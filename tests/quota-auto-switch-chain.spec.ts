/**
 * The AUTO-SWITCH chain for a quota failure, end to end.
 *
 * The maintainer's requirement, in one sentence: when this failure appears, the
 * plugin should switch to another account in the pool and keep working — so the
 * notice's parenthetical is only ever read when that switch could NOT happen.
 *
 * The chain has five links, and each one has its own spec:
 *
 *   1. classify   `classifyUpstreamError`            (upstream.spec.ts)
 *   2. outcome    `outcomeOfFailure`                 (probe tests)
 *   3. cooldown   `cooldownOf` / `quotaRefreshOf`    (issue63-quota-refresh-merge.spec.ts)
 *   4. ranking    `rankPool` + `exclusionOf`         (account-pool tests)
 *   5. failover   the shim's retry loop              (shim-failover.spec.ts)
 *
 * What NO existing spec did is run them as ONE pipeline on the upstream's real
 * bytes. Each link was green while the seams between them were unverified, which
 * is exactly the shape of a silent regression: change the classifier and the
 * failover spec still passes (it hands in a `kind` it made up), change
 * `exclusionOf` and the classifier tests still pass (they never ask what the
 * pool does with the verdict). This file closes the seams.
 *
 * The specific claim it pins: BOTH upstream spellings of an account-level
 * refusal — the `6004` volume limit and the `14018` exhaustion — go all the way
 * from raw HTTP bytes to a decision that benches THAT account and hands the
 * request to the next one, and the `14003` MODEL-scoped throttle deliberately
 * does not (issue #56).
 */
import { describe, expect, it } from 'vitest'
import { exclusionOf, rankPool } from '../src/account-pool.ts'
import { cooldownOf, outcomeOfFailure } from '../src/probe.ts'
import { classifyUpstreamError } from '../src/upstream.ts'
import type { UpstreamErrorKind } from '../src/upstream.ts'
import type { WorkBuddyPoolMember, WorkBuddyPoolProbe } from '../src/account-pool.ts'

/** `6004`, verbatim from a live 429: a volume limit that CLEARS at a stated time. */
const BODY_6004 = '{"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-10-02 05:23:27 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"00dc90c7-f7b6-40ad-8960-a00c2d92b567"}'

/** `14018`, verbatim from a live refusal: the account cannot pay for the model. */
const BODY_14018 = '{"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the WorkBuddy console to top up."}}}'

/** `14003`, verbatim: the MODEL is busy — every account answers the same. */
const BODY_14003 = '{"code":14003,"msg":"请求过于频繁，请稍后重试。","displayTips":{"zh":"建议等待约 1 分钟后重试，或切换到负载较低的模型。"}}'

const NOW = 1_800_000_000_000

/**
 * `6004`'s reset as a function of "now".
 *
 * The verbatim body carries an ABSOLUTE instant, which is right for the product
 * (the user reads a clock time, not a countdown) and awkward for a test whose
 * `now` is fixed: with `NOW` at 2027 the stated reset is in the past and the
 * account is legitimately a candidate again. Re-writing only the clock inside
 * the sentence keeps every other byte — including the code and the prose that
 * surrounds it — exactly as the upstream sent it.
 */
function body6004At(nowMs: number): string {
  // The parser reads the stamp as WALL-CLOCK time at the stated offset, so the
  // instant to WRITE is the target shifted back by the offset — not the UTC
  // rendering of the target, which would land 8 hours early.
  const wall = new Date(nowMs + 3 * 3_600_000 + 8 * 3_600_000)
  const stamp = `${wall.toISOString().slice(0, 10)} ${wall.toISOString().slice(11, 19)}`
  return BODY_6004.replace(/将在 [0-9-]+ [0-9:]+ UTC\+8/u, `将在 ${stamp} UTC+8`)
}

/**
 * Links 1→4: raw bytes in, "which accounts may serve" out.
 *
 * This is the whole chain minus the HTTP hop. It mirrors exactly what the
 * production path does — `classifyUpstreamError` → `outcomeOfFailure` →
 * `cooldownOf` → a stored `WorkBuddyPoolProbe` → `rankPool` — so a verdict that
 * survives here is one the shim's failover loop will actually act on.
 */
function chain(status: number, body: string, atMs = NOW): {
  kind: UpstreamErrorKind
  /** The stored measurement, plus the cooldown SOURCE the probe record drops. */
  probe: WorkBuddyPoolProbe & { retrySource?: string }
  ranked: ReturnType<typeof rankPool>
} {
  const kind = classifyUpstreamError(status, body)
  const outcome = outcomeOfFailure(status, body)
  const cooldown = cooldownOf({ outcome, retryAfter: null, nowMs: atMs, body })
  const probe: WorkBuddyPoolProbe = {
    outcome,
    atMs,
    source: 'live-request',
    ...cooldown.retryAtMs === undefined ? {} : { retryAtMs: cooldown.retryAtMs },
    ...cooldown.retrySource === undefined ? {} : { retrySource: cooldown.retrySource },
  }
  const members: WorkBuddyPoolMember[] = [
    { account: { id: 'failed', accountName: 'Failed' }, probe },
    { account: { id: 'fresh', accountName: 'Fresh' } },
  ]
  return { kind, probe, ranked: rankPool(members, atMs) }
}

/** The account `rankPool` puts first, i.e. the one the request would go to next. */
function nextUp(ranked: ReturnType<typeof rankPool>): string | undefined {
  return ranked.find(row => row.excludedBy === undefined)?.account.id
}


describe('the quota failure reaches the pool as a per-account measurement', () => {
  it('benches the 6004 volume limit and serves from the next account', () => {
    const { kind, probe, ranked } = chain(429, body6004At(NOW))
    // The classification the shim's failover loop reads.
    expect(kind).toBe('soft_rate')
    expect(probe.outcome).toBe('rate-limited')
    // The upstream's OWN reset time survives into the stored measurement, so the
    // account is benched for exactly as long as it said — not for a guessed
    // fallback that would either idle it or re-hit the same wall.
    expect(probe.retryAtMs).toBe(NOW + 3 * 3_600_000)
    expect(probe.retrySource).toBe('upstream-message')
    expect(exclusionOf(probe, NOW)).toBe('rate-limited')
    expect(nextUp(ranked), 'the failed account was picked again').toBe('fresh')
  })

  it('benches an exhausted balance and serves from the next account', () => {
    const { kind, probe, ranked } = chain(429, BODY_14018)
    expect(kind).toBe('hard_credit')
    expect(probe.outcome).toBe('out-of-credit')
    expect(exclusionOf(probe, NOW)).toBe('out-of-credit')
    // This is the case the notice's parenthetical is honest about: the upstream
    // blamed credits, but another ACCOUNT may still hold some — so the chain
    // tries one before the user is told to top up.
    expect(nextUp(ranked)).toBe('fresh')
  })

  it('benches a model-scoped 14003 on its OWN short clock (issue #56)', () => {
    const { kind, probe, ranked } = chain(429, BODY_14003)
    expect(kind).toBe('model_busy')
    expect(probe.outcome).toBe('model-busy')
    // The bench is the model-scoped clock the upstream's own advice implies —
    // minutes, not the half-hour the unknown-failure fallback applies — so one
    // busy minute cannot turn into a pool-wide outage.
    expect(probe.retrySource).toBe('upstream-tips')
    expect(exclusionOf(probe, NOW)).toBe('model-busy')
    expect(probe.retryAtMs).toBe(NOW + 120_000)
    // Benched for the NEXT request, but NOT permanently disqualified: once the
    // window passes it is a candidate again without a manual test, which is what
    // stops issue #56's "walk every member into the same wall" from repeating.
    expect(exclusionOf(probe, NOW + 120_001)).toBeUndefined()
    // The ranking is NOT what keeps this failure from rerouting the pool — the
    // shim refuses that failover by `kind` alone (`isFailoverWorthy`), and that
    // refusal is pinned in shim-failover.spec.ts. The seam this file owns is the
    // measurement: whatever the pool stores for a 14003 must expire, not stand
    // as a verdict about the account.
    expect(ranked).toHaveLength(2)
  })

  it('returns the failed account to rotation once its stated reset arrives', () => {
    const { probe } = chain(429, body6004At(NOW))
    // An account is benched for a REASON with an end, never forever: at and after
    // the upstream's own instant it is a candidate again without a manual test.
    // That is what keeps the pool from shrinking by one on every transient limit.
    expect(exclusionOf(probe, (probe.retryAtMs as number) + 1)).toBeUndefined()
  })
})

describe('the chain degrades honestly when there is nowhere to switch to', () => {
  it('has no candidate when the only member is the failed one', () => {
    const { probe } = chain(429, body6004At(NOW))
    const ranked = rankPool([{ account: { id: 'only', accountName: 'Only' }, probe }], NOW)
    // `rankPool` still RETURNS the row — the card has to explain why it is out —
    // but it is not a candidate, which is what makes `failoverAccountFor` return
    // undefined and the user see the failure with the parenthetical.
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.excludedBy).toBe('rate-limited')
    expect(nextUp(ranked)).toBeUndefined()
  })

  it('keeps the failed account as the only row rather than inventing a healthy one', () => {
    const { probe } = chain(429, BODY_14018)
    const ranked = rankPool([{ account: { id: 'only', accountName: 'Only' }, probe }], NOW)
    expect(ranked.filter(row => row.excludedBy === undefined)).toHaveLength(0)
  })
})
