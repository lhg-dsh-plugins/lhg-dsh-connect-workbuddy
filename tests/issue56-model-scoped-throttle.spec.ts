/**
 * Regression suite for issue #56 — "14003 是模型级、逐请求的软限流 … 却被当成账号级
 * 失败：换号循环把池内每个账号各锁 30 分钟".
 *
 * The reporter's evidence, reproduced here as CONSTANTS rather than prose, is
 * what makes this fix decidable rather than a matter of taste. Measured on ONE
 * credential at ONE moment, byte-identical requests differing only in `model`,
 * three attempts each:
 *
 *   | model                  | multiplier | ok  | failures    |
 *   | ---                    | ---        | --- | ---         |
 *   | deepseek-v4.1-flash    | x0.00      | 1/3 | 429 / 14003 |
 *   | deepseek-v4.1-flash-sg | x0.03      | 1/3 | 429 / 14003 |
 *   | glm-5.3-flash          | x0.06      | 3/3 | —           |
 *   | hy3                    | x0.00      | 3/3 | —           |
 *   | kimi-k2.6              | x0.77      | 3/3 | —           |
 *
 * The same account served other models at the same second, and the upstream's own
 * text names `model` as the axis ("switch to a less busy model"). So the plug-in
 * was wrong on three counts, each pinned below:
 *
 * 1. It classified 14003 as `soft_rate` — an ACCOUNT limit.
 * 2. `cooldownOf` gave it the 30-minute fallback and `exclusionOf` benched the
 *    account for that long, though the upstream says "about a minute".
 * 3. Failover walked every pool member into the same model-level wall, writing a
 *    false per-account measurement onto each one.
 */
import { describe, expect, it } from 'vitest'
import {
  carriesModelBusyTip,
  classifyUpstreamError,
  isModelBusyBody,
} from '../src/upstream.ts'
import {
  cooldownOf,
  outcomeOfFailure,
  MODEL_BUSY_COOLDOWN_MS,
} from '../src/probe.ts'
import {
  exclusionOf,
  MODEL_BUSY_COOLDOWN_MS as POOL_MODEL_BUSY_COOLDOWN_MS,
  POOL_UNKNOWN_COOLDOWN_MS,
  rankPool,
} from '../src/account-pool.ts'

/**
 * The reporter's failure body, verbatim (2026-10-13 15:35, `deepseek-v4.1-flash`).
 *
 * Kept as the raw string, not a re-serialised object: the classifier reads the
 * upstream's TEXT, and a fixture that had been through `JSON.parse`/`stringify`
 * would not prove anything about the bytes that actually arrive.
 */
const MODEL_BUSY_BODY = '{"code":14003,"msg":"too many requests","requestId":"00dc90c7-f7b6-40ad-8960-a00c2d92b567","retry_policy":{"retry":true},"displayMsg":{"en":"Too many requests. Please retry later.","zh":"请求过于频繁，请稍后重试。","zh-hant":"請求過於頻繁，請稍後重試。"},"displayTips":{"en":"Wait about a minute before retrying, or switch to a less busy model.","zh":"建议等待约 1 分钟后重试，或切换到负载较低的模型。","zh-hant":"建議等待約 1 分鐘後重試，或切換至負載較低的模型。"}}'

/**
 * The ACCOUNT limit (6004), for contrast — the kind that DOES carry a reset
 * instant and DOES belong to one account.
 */
const ACCOUNT_RATE_LIMIT_BODY = JSON.stringify({
  code: 6004,
  msg: '您的使用量已超出频率限制，将在 2026-10-02 05:23:27 UTC+8 重置，您也可以切换其他模型继续使用。',
})

describe('issue #56: 14003 is the MODEL\'s limit, and 6004 is the account\'s', () => {
  it('classifies the reporter\'s 14003 body as model_busy, not soft_rate', () => {
    // The single most important assertion in this file: the upstream code is the
    // criterion, and reading it as `soft_rate` is the whole defect.
    expect(isModelBusyBody(MODEL_BUSY_BODY)).toBe(true)
    expect(classifyUpstreamError(429, MODEL_BUSY_BODY)).toBe('model_busy')
  })

  it('still classifies the account-level 6004 as soft_rate', () => {
    // The fix must not swallow the case the pool logic was BUILT for: a volume
    // limit with a stated reset time is genuinely per-account, and failing over
    // is exactly right there.
    expect(isModelBusyBody(ACCOUNT_RATE_LIMIT_BODY)).toBe(false)
    expect(classifyUpstreamError(429, ACCOUNT_RATE_LIMIT_BODY)).toBe('soft_rate')
  })

  it('does not reclassify a 429 that merely mentions a busy model', () => {
    // An HTML error page or a gateway banner is not the business envelope. The
    // code must be present in its quoted-key form — a request id is hexadecimal
    // and can contain the digits 14003 by coincidence.
    expect(isModelBusyBody('<html>switch to a less busy model</html>')).toBe(false)
    expect(classifyUpstreamError(429, '<html>switch to a less busy model</html>')).toBe('soft_rate')
    // …and a request id that happens to contain them does not promote it either.
    expect(isModelBusyBody('{"code":6004,"requestId":"a14003b"}')).toBe(false)
  })

  it('reads the upstream\'s own remedy out of displayTips, as data', () => {
    expect(carriesModelBusyTip(MODEL_BUSY_BODY)).toBe(true)
    expect(carriesModelBusyTip('负载较低的模型')).toBe(true)
    expect(carriesModelBusyTip('{"code":14003}')).toBe(false)
    // Deliberately NOT a classification criterion: the code decides, so a body
    // with the advice but no code stays a plain rate limit.
    expect(isModelBusyBody('{"code":6004,"displayTips":{"zh":"或切换到负载较低的模型"}}')).toBe(false)
  })

  it('leaves every other class untouched', () => {
    // Ordering guard: a body carrying BOTH a throttling code and a wallet
    // complaint must still read as the actionable, wallet-shaped failure.
    expect(classifyUpstreamError(402, MODEL_BUSY_BODY)).toBe('hard_credit')
    expect(classifyUpstreamError(429, '{"code":14003,"msg":"积分不足"}')).toBe('hard_credit')
    // And the codes that were never affected.
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(404, '')).toBe('not_found')
    expect(classifyUpstreamError(500, '')).toBe('server')
  })

  it('maps the kind onto its own probe outcome', () => {
    expect(outcomeOfFailure(429, MODEL_BUSY_BODY)).toBe('model-busy')
    expect(outcomeOfFailure(429, ACCOUNT_RATE_LIMIT_BODY)).toBe('rate-limited')
    // A 401/403 still wins: classification order must not turn an auth refusal
    // into a throttle.
    expect(outcomeOfFailure(401, MODEL_BUSY_BODY)).toBe('credential-rejected')
  })
})

describe('issue #56: the cooldown matches what the upstream actually said', () => {
  const NOW = 1_800_000_000_000

  it('benches a model-scoped failure for about a minute, not thirty', () => {
    const cooldown = cooldownOf({ outcome: 'model-busy', retryAfter: null, nowMs: NOW, body: MODEL_BUSY_BODY })
    expect(cooldown.retryAtMs).toBe(NOW + MODEL_BUSY_COOLDOWN_MS)
    // The 'upstream-tips' source says what this number IS: a magnitude the
    // upstream stated in prose, not a timestamp it printed. Without that label
    // the card would present an order of magnitude as if it were an instant.
    expect(cooldown.retrySource).toBe('upstream-tips')
    // The defect in one comparison: 30 minutes is 15x the stated magnitude.
    expect(MODEL_BUSY_COOLDOWN_MS).toBeLessThan(POOL_UNKNOWN_COOLDOWN_MS)
    expect(POOL_UNKNOWN_COOLDOWN_MS / MODEL_BUSY_COOLDOWN_MS).toBeGreaterThanOrEqual(10)
  })

  it('prefers a real stated time when the upstream gives one', () => {
    // A `Retry-After` header, or a `将在 … UTC+8 重置` sentence, outranks the
    // prose magnitude — those are the upstream naming an instant.
    const fromHeader = cooldownOf({
      outcome: 'model-busy', retryAfter: '90', nowMs: NOW, body: MODEL_BUSY_BODY,
    })
    expect(fromHeader).toEqual({ retryAtMs: NOW + 90_000, retrySource: 'retry-after' })
    const fromBody = cooldownOf({
      outcome: 'model-busy', retryAfter: null, nowMs: NOW, body: ACCOUNT_RATE_LIMIT_BODY,
    })
    expect(fromBody.retrySource).toBe('upstream-message')
  })

  it('keeps the two cooldowns in step, because a probe writes and a ranking reads', () => {
    // `src/probe.ts` and `src/account-pool.ts` must not import each other (one is
    // the Host probe, the other the pure ranking rule), so the value is declared
    // twice. This is the assertion that keeps the two declarations honest: a
    // probe that writes one cooldown and a ranking that applies another would
    // silently re-open the defect.
    expect(MODEL_BUSY_COOLDOWN_MS).toBe(POOL_MODEL_BUSY_COOLDOWN_MS)
  })

  it('still says nothing rather than inventing a time for other timeless failures', () => {
    // The exception is ONLY `model-busy`: every other unstated cooldown keeps
    // the honest empty answer the card renders as "the upstream did not say".
    expect(cooldownOf({ outcome: 'rate-limited', retryAfter: null, nowMs: NOW, body: '429 no text' })).toEqual({})
    expect(cooldownOf({ outcome: 'unavailable', retryAfter: null, nowMs: NOW })).toEqual({})
  })
})

describe('issue #56: one busy model does not bench the whole pool', () => {
  const NOW = 1_800_000_000_000

  it('puts a model-busy account back in the pool on the short clock', () => {
    const probe = { outcome: 'model-busy' as const, atMs: NOW }
    expect(exclusionOf(probe, NOW)).toBe('model-busy')
    expect(exclusionOf(probe, NOW + MODEL_BUSY_COOLDOWN_MS - 1)).toBe('model-busy')
    expect(exclusionOf(probe, NOW + MODEL_BUSY_COOLDOWN_MS)).toBeUndefined()
    // The old behaviour, in one comparison: at one minute this account used to
    // still be excluded, because the generic fallback is an order of magnitude
    // longer.
    expect(exclusionOf(probe, NOW + MODEL_BUSY_COOLDOWN_MS)).toBeUndefined()
    expect(NOW + MODEL_BUSY_COOLDOWN_MS).toBeLessThan(NOW + POOL_UNKNOWN_COOLDOWN_MS)
  })

  it('honours a stated retryAtMs over the short clock', () => {
    // A 14003 that DID carry a time is obeyed; the short clock is a fallback,
    // not an override.
    const stated = NOW + 10 * 60_000
    expect(exclusionOf({ outcome: 'model-busy', atMs: NOW, retryAtMs: stated }, NOW + MODEL_BUSY_COOLDOWN_MS))
      .toBe('model-busy')
    expect(exclusionOf({ outcome: 'model-busy', atMs: NOW, retryAtMs: stated }, stated)).toBeUndefined()
  })

  it('does not idle the pool: a measured rate-limit still benches longer than a busy model', () => {
    // The two exclusions must not converge, or the distinction buys nothing.
    const busy = { outcome: 'model-busy' as const, atMs: NOW }
    const limited = { outcome: 'rate-limited' as const, atMs: NOW }
    expect(exclusionOf(busy, NOW + MODEL_BUSY_COOLDOWN_MS)).toBeUndefined()
    expect(exclusionOf(limited, NOW + MODEL_BUSY_COOLDOWN_MS)).toBe('rate-limited')
  })

  it('reports the reason as model-busy so the card can name the right party', () => {
    const ranked = rankPool([
      { account: { id: 'a', accountName: 'A' }, probe: { outcome: 'model-busy', atMs: NOW } },
      { account: { id: 'b', accountName: 'B' }, probe: { outcome: 'rate-limited', atMs: NOW } },
    ], NOW)
    // Excluded rows are still RETURNED, and each carries its own reason: folding
    // `model-busy` into `rate-limited` is what told issue #56's reporter to go
    // hunting for a bad account.
    expect(ranked.map(row => [row.account.id, row.excludedBy])).toEqual([
      ['a', 'model-busy'],
      ['b', 'rate-limited'],
    ])
  })
})
