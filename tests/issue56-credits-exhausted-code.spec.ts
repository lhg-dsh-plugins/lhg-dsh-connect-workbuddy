/**
 * Regression suite for the `14018` exhaustion refusal — found by the issue #56
 * reporter while answering a question about whether `14018` belongs to the same
 * family as `14003`.
 *
 * Two separate defects are pinned here, and they are worth keeping apart:
 *
 * 1. **A wording bug in `HARD_CREDIT_MARKERS`.** The table listed
 *    `'credit exhausted'` (singular) while the live body says "Credits
 *    exhausted." (plural + capital C). `'credits exhausted.'.includes('credit
 *    exhausted')` is FALSE — the `s` sits between the two words — so no marker
 *    matched and the failure fell through to the generic 429 branch.
 *
 * 2. **The consequence of (1).** A failure whose entire point is "go top up"
 *    was reported to the user as "wait a bit" (`rate-limited`), and the account
 *    was benched on the 30-minute fallback — the same kind of amplification as
 *    issue #56's one-minute-to-half-an-hour, reached through a different door.
 *
 * The reporter's `14018` is an ACCOUNT-level exhaustion, NOT the model-scoped
 * `14003`, and their three-account × four-model matrix is what proves it:
 * account B (total 100) failed `hy4-preview` 0/2 while A (379) and C (350)
 * served the same model 2/2; and on B itself the FREE models (`hy3`,
 * `deepseek-v4.1-flash`) answered 2/2 while the credit-charging ones did not.
 * So this suite deliberately asserts the two codes stay APART.
 *
 * The body below is the reporter's, verbatim, including its trailing space and
 * the `{"error":{"data":…}}` nesting (it is NOT the flat envelope the `14003`
 * fixture uses — one more reason a marker table keyed on prose is brittle).
 */
import { describe, expect, it } from 'vitest'
import { classifyUpstreamError } from '../src/upstream.ts'
import { cooldownOf, outcomeOfFailure } from '../src/probe.ts'
import { exclusionOf, POOL_UNKNOWN_COOLDOWN_MS } from '../src/account-pool.ts'

/** The live `14018` body, byte-for-byte as the reporter captured it. */
const CREDITS_EXHAUSTED_BODY = '{"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage ","requestId":"05cbe639-4007-4da2-bd7e-57c84c4892d8"}}}'

/**
 * The `14003` body from the same issue, for the "they must stay apart" half.
 */
const MODEL_BUSY_BODY = '{"code":14003,"msg":"too many requests","requestId":"00dc90c7-f7b6-40ad-8960-a00c2d92b567","retry_policy":{"retry":true},"displayMsg":{"en":"Too many requests. Please retry later.","zh":"请求过于频繁，请稍后重试。"},"displayTips":{"en":"Wait about a minute before retrying, or switch to a less busy model.","zh":"建议等待约 1 分钟后重试，或切换到负载较低的模型。"}}'

describe('14018: an exhausted account is NOT a busy model', () => {
  it('classifies the live body as hard_credit, not soft_rate', () => {
    // The defect in one line: this used to return 'soft_rate'.
    expect(classifyUpstreamError(429, CREDITS_EXHAUSTED_BODY)).toBe('hard_credit')
  })

  it('the plural spelling is what the upstream actually ships', () => {
    // Stated as a fact about the text, so the marker table cannot silently lose
    // the plural again: the singular substring is genuinely ABSENT.
    expect(CREDITS_EXHAUSTED_BODY.toLowerCase().includes('credit exhausted')).toBe(false)
    expect(CREDITS_EXHAUSTED_BODY.toLowerCase().includes('credits exhausted')).toBe(true)
  })

  it('still recognises the singular spelling, and the Chinese markers', () => {
    // The plural was ADDED, not swapped in: the gateway has been seen to reword
    // itself, so a table that only knows today's spelling is the same trap.
    expect(classifyUpstreamError(429, '{"msg":"credit exhausted"}')).toBe('hard_credit')
    expect(classifyUpstreamError(429, '{"msg":"积分不足"}')).toBe('hard_credit')
    expect(classifyUpstreamError(429, '{"msg":"余额不足"}')).toBe('hard_credit')
  })

  it('recognises the CODE even when the prose is reworded entirely', () => {
    // This is why the code check exists alongside the markers: a message the
    // table has never seen must still resolve. Body deliberately carries no
    // marker substring at all.
    expect(classifyUpstreamError(429, '{"error":{"data":{"code":14018,"msg":"nope"}}}')).toBe('hard_credit')
    // …and the quoted-key form means a request id containing the digits cannot
    // promote an unrelated body.
    expect(classifyUpstreamError(429, '{"code":6004,"requestId":"a14018b"}')).toBe('soft_rate')
  })

  it('maps it onto out-of-credit, which is the advice the user needs', () => {
    expect(outcomeOfFailure(429, CREDITS_EXHAUSTED_BODY)).toBe('out-of-credit')
    // Contrast: the model-scoped one stays its own outcome.
    expect(outcomeOfFailure(429, MODEL_BUSY_BODY)).toBe('model-busy')
  })

  it('a body carrying BOTH a throttling code and the exhaustion code reads as exhaustion', () => {
    // Ordering guard. "Go top up" is the actionable answer; "wait" is not.
    const both = '{"code":14003,"error":{"data":{"code":14018,"msg":"Credits exhausted."}}}'
    expect(classifyUpstreamError(429, both)).toBe('hard_credit')
  })

  it('excludes the account as out-of-credit rather than rate-limited', () => {
    // The user-visible half: the pool row says 积分耗尽 (act on it) instead of
    // 被限流 (wait), which is the difference between a working instruction and
    // a misleading one.
    const probe = { outcome: outcomeOfFailure(429, CREDITS_EXHAUSTED_BODY), atMs: 1_800_000_000_000 }
    expect(exclusionOf(probe, probe.atMs)).toBe('out-of-credit')
    expect(exclusionOf(probe, probe.atMs + 60_000)).toBe('out-of-credit')
  })

  it('no longer invents a cooldown the upstream never stated', () => {
    // `cooldownOf` attaches a time only from a real source. 14018 names none,
    // so the honest answer stays empty — the OLD behaviour still waited out the
    // generic fallback, which is what made this a 30-minute illusion for a
    // condition that only a top-up clears.
    const cooldown = cooldownOf({
      outcome: outcomeOfFailure(429, CREDITS_EXHAUSTED_BODY),
      retryAfter: null,
      nowMs: 1_800_000_000_000,
      body: CREDITS_EXHAUSTED_BODY,
    })
    expect(cooldown).toEqual({})
    // And the generic fallback it used to fall into, for the record.
    expect(POOL_UNKNOWN_COOLDOWN_MS).toBe(30 * 60_000)
  })

  it('keeps the quota-refresh time when the caller has one', () => {
    // The one real answer to "when can I use this again" for an exhausted
    // account: the region's monthly refresh point. `hard_credit` is exactly the
    // outcome that branch exists for, so the fix must not bypass it.
    const refreshAt = 1_800_000_000_000 + 86_400_000
    const cooldown = cooldownOf({
      outcome: 'out-of-credit',
      retryAfter: null,
      nowMs: 1_800_000_000_000,
      body: CREDITS_EXHAUSTED_BODY,
      quotaRefreshAtMs: refreshAt,
    })
    expect(cooldown).toEqual({ retryAtMs: refreshAt, retrySource: 'quota-refresh' })
  })
})
