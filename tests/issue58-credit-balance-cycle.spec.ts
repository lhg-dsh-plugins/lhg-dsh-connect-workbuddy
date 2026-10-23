/**
 * Issue #58: the balance is the CYCLE family, precisely — and this REVERSES the
 * rule issue #48 introduced. The reversal is deliberate; read both before
 * "fixing" this back.
 *
 * ## What #48 concluded, and why it looked right
 *
 * The upstream returns a monthly resource (`CapacityType === 4`) with two
 * capacity families:
 *
 *   CapacityRemain / CapacitySize / CapacityUsed          — "the pool"
 *   CycleCapacityRemain / CycleCapacitySize / CycleUsed   — "the current cycle"
 *
 * #48 found three global accounts reporting `CapacityRemain=100` together with
 * `CycleCapacityRemain=0`, read that as "the pool holds 100 while the cycle is
 * spent", and switched the balance to the pool. `CapacityRemain=100` looks like
 * a balance, and 0 looks like the false "积分耗尽" the reporter complained
 * about, so the trade was plausible — but it was never checked against the one
 * thing that defines the right answer: what the official client displays.
 *
 * ## What #58 measured (2026-10-14)
 *
 * The maintainer's own CN account, client screenshot vs the same response:
 *
 *   client  总剩余积分 2,196.61 = 套餐基础积分 500 + 平台奖励积分 1,696.61
 *   API     Σ CycleCapacityRemainPrecise = 2,196.61   ← exact, to the cent
 *           Σ CapacityRemain            = 2,196      (pool; integer only)
 *
 * The cent is the proof: no sum of the integer `CapacityRemain` fields can end
 * in `.61`, because the fractions live only in the `*Precise` spellings — and
 * they live in the CYCLE family. The client's own three buckets map one-to-one
 * onto (monthly cycle, gift cycle, purchased).
 *
 * Two further measurements, both on 8/8 + 3/3 real accounts:
 *
 * 1. The pool family is NOT a balance on a monthly resource. An account whose
 *    cycle was fully spent reported `CapacityRemain=500, CapacityUsed=0` — i.e.
 *    "nothing used, everything left" — while the cycle reported
 *    `CycleCapacityUsed=500`. Pool and cycle agreed only where the cycle was
 *    untouched, so the pool reading over-reports by the entire monthly
 *    allowance of every account that has started consuming it.
 * 2. The international gateway refuses those same three global accounts'
 *    chat requests with `14018 Credits exhausted` while the response says
 *    `CapacityRemain=100`. The pool figure is not spendable credit there.
 *
 * So #48's "0" was the truth for a spent cycle, and #48's reporter was misled
 * by a `200` from `/v2/chat/completions` that the gift packages (or a grace
 * path) were serving. A gift carries both families with IDENTICAL values, so
 * reading the cycle uniformly removes the monthly/gift branch entirely: there
 * is no longer a special case to get wrong.
 *
 * ## What is asserted, and what deliberately is not
 *
 * - `total` equals Σ `CycleCapacityRemainPrecise` over the same response —
 *   asserted exactly, fraction included, on a fixture whose rows are copied
 *   from the real dump.
 * - The spent-cycle global row totals 0, not 100: this is the case #48 called a
 *   false "out of credit", pinned here as correct.
 * - `size` comes from the same family as `remain`, so "0 of 100" reads right.
 * - A row with no cycle family at all still parses, from the pool.
 * - Gifts keep their drop rules (exhausted / expired), and a negative value
 *   never reaches `total`.
 *
 * NOT asserted: any relationship between pool and cycle beyond what the rows
 * state. They disagree in production, and assuming an agreement is exactly what
 * produced #48.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

function credential(): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: 0,
    domain: 'www.codebuddy.cn',
    uid: 'u',
    source: 'desktop',
    filePath: '/tmp/workbuddy-desktop.info',
  }
}

/** Run the real `fetchCredits` against a stubbed billing response. */
async function creditsFor(accounts: readonly Record<string, unknown>[]) {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, msg: 'OK', data: { Response: { Data: { Accounts: accounts } } } }),
    text: async () => JSON.stringify({ code: 0, msg: 'OK', data: { Response: { Data: { Accounts: accounts } } } }),
  }) as unknown as Response)
  return new WorkBuddyUpstreamClient().fetchCredits(credential())
}

/**
 * A real CN monthly package (the maintainer's account), untouched this cycle:
 * the pool and the cycle agree, so this row alone cannot tell the families
 * apart — which is why the fixtures below also carry a SPENT cycle.
 */
function cnMonthly(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    CapacityType: 4,
    PackageName: 'CodeBuddy个人体验版',
    CapacityRemain: 500,
    CapacitySize: 500,
    CapacityUsed: 0,
    CapacityRemainPrecise: '500',
    CapacitySizePrecise: '500',
    CapacityUsedPrecise: '0',
    CycleCapacityRemain: 500,
    CycleCapacitySize: 500,
    CycleCapacityUsed: 0,
    CycleCapacityRemainPrecise: '500',
    CycleCapacitySizePrecise: '500',
    CycleCapacityUsedPrecise: '0',
    CycleEndTime: '2026-10-31 23:59:59',
    ExpiredTime: '',
    Status: 0,
    ...overrides,
  }
}

/** A real gift row: both families identical, fraction in the precise spelling. */
function gift(precise: string, integer: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    CapacityType: 1,
    PackageName: 'CodeBuddy个人版国内运营裂变包',
    CapacityRemain: integer,
    CapacitySize: 100,
    CapacityRemainPrecise: precise,
    CapacitySizePrecise: '100',
    CycleCapacityRemain: integer,
    CycleCapacitySize: 100,
    CycleCapacityUsed: 100 - integer,
    CycleCapacityRemainPrecise: precise,
    CycleCapacitySizePrecise: '100',
    CycleEndTime: '2026-10-15 04:30:22',
    ExpiredTime: '2126-01-01 00:00:00',
    Status: 0,
    ...overrides,
  }
}

/** The exact row three real global accounts returned (2026-10-12 → 10-14). */
function globalMonthlySpentCycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    CapacityType: 4,
    PackageName: 'Free Plan Subscription',
    CapacityRemain: 100,
    CapacitySize: 100,
    CapacityUsed: 0,
    CapacityRemainPrecise: '100',
    CycleCapacityRemain: 0,
    CycleCapacitySize: 100,
    CycleCapacityUsed: 100,
    CycleCapacityRemainPrecise: '0',
    CycleCapacitySizePrecise: '100',
    CycleCapacityUsedPrecise: '100',
    CycleEndTime: '2026-10-31 23:59:59',
    ExpiredTime: '',
    Status: 0,
    ...overrides,
  }
}

describe('fetchCredits: the balance is the cycle family (issue #58)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('totals Σ CycleCapacityRemainPrecise, fraction included', async () => {
    // Rows copied from the live CN dump, trimmed to four: the monthly base plus
    // three gifts, one of which carries a real fractional remainder.
    const credits = await creditsFor([
      cnMonthly(),
      gift('96.61000218', 96),
      gift('100', 100),
      gift('100', 100),
    ])
    // 500 + 96.61000218 + 100 + 100. The pool reading gives the same number here
    // only because every row's two families agree — the fraction is what proves
    // the PRECISE spelling is being read at all.
    expect(credits.total).toBeCloseTo(796.61000218, 8)
    expect(credits.packages[1]?.remain).toBeCloseTo(96.61000218, 8)
    // `size` rides the same family, so "96.61 of 100" reads right.
    expect(credits.packages[1]?.size).toBe(100)
  })

  it('reads the cycle, not the pool, when a monthly cycle is spent', async () => {
    // THE regression of #48, re-asserted the other way round. A real CN account
    // (LaoDing, 2026-10-14): the pool claims 500 remaining / 0 used while the
    // cycle claims 500 used. The client shows the cycle figure; the pool reading
    // over-reports by the full 500.
    const credits = await creditsFor([
      cnMonthly({ CycleCapacityRemain: 0, CycleCapacityUsed: 500, CycleCapacityRemainPrecise: '0', CycleCapacityUsedPrecise: '500' }),
      gift('647.01', 647),
    ])
    expect(credits.total).toBeCloseTo(647.01, 8)
    expect(credits.packages[0]?.remain).toBe(0)
    expect(credits.packages[0]?.size).toBe(500)
    // The monthly row is still kept despite reading 0, so the card can still
    // offer the refresh point.
    expect(credits.packages[0]?.monthly).toBe(true)
    expect(credits.packages[0]?.refreshAtMs).toBeDefined()
  })

  it('reports a spent-cycle global account as 0, not as its pool', async () => {
    // These are the three rows #48 called a false "积分耗尽". The gateway itself
    // refuses their chat with 14018 Credits exhausted, so 0 is the honest
    // figure and 100 was the over-report.
    const credits = await creditsFor([globalMonthlySpentCycle(), globalMonthlySpentCycle(), globalMonthlySpentCycle()])
    expect(credits.total).toBe(0)
    expect(credits.packages).toHaveLength(3)
  })

  it('agrees with the pool reading where the cycle is untouched', async () => {
    // A "sensible-looking" fixture would pass under both rules; this is here so
    // the reversal is not mistaken for "every number changed".
    const credits = await creditsFor([cnMonthly()])
    expect(credits.total).toBe(500)
  })

  it('falls back to the pool family for a row that has no cycle at all', async () => {
    // A response that omits the cycle spelling must still parse rather than
    // reporting 0 — a silent 0 is the failure mode this whole area keeps
    // producing.
    const credits = await creditsFor([{ CapacityType: 1, PackageName: 'Bonus Pack', CapacityRemain: 40, CapacitySize: 250, ExpiredTime: '2126-01-01 00:00:00' }])
    expect(credits.total).toBe(40)
    expect(credits.packages[0]?.size).toBe(250)
  })

  it('prefers the precise spelling but still parses an integer-only row', async () => {
    const precise = await creditsFor([gift('3.38999782', 3)])
    expect(precise.total).toBeCloseTo(3.38999782, 8)
    const integerOnly = await creditsFor([{ CapacityType: 1, PackageName: 'Bonus Pack', CapacityRemain: 7, CycleCapacityRemain: 7, CycleCapacitySize: 100, ExpiredTime: '2126-01-01 00:00:00' }])
    expect(integerOnly.total).toBe(7)
  })

  it('keeps the gift drop rules unchanged', async () => {
    // Exhausted and expired gifts are dropped from `packages` (and from
    // `total`), exactly as before the reversal: they carry nothing usable and
    // would clutter the nearest-expiry list.
    const exhausted = await creditsFor([gift('0', 0, { ExpiredTime: '2126-01-01 00:00:00' })])
    expect(exhausted.total).toBe(0)
    expect(exhausted.packages).toEqual([])

    const expired = await creditsFor([gift('40', 40, { ExpiredTime: '2026-10-04 02:40:13' })])
    expect(expired.total).toBe(0)
    expect(expired.packages).toEqual([])
  })

  it('never lets a negative balance reach the total', async () => {
    const credits = await creditsFor([cnMonthly({ CycleCapacityRemain: -5, CycleCapacityRemainPrecise: '-5' })])
    expect(credits.total).toBe(0)
    expect(credits.packages[0]?.remain).toBe(0)
  })

  it('counts a near-expiry gift from its cycle balance', async () => {
    // `expiringSoon` must follow the same reading as `total`, or the warning and
    // the number it warns about would describe different quantities.
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const pad = (n: number): string => n.toString().padStart(2, '0')
    const stamp = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())} ${pad(soon.getHours())}:${pad(soon.getMinutes())}:${pad(soon.getSeconds())}`
    const credits = await creditsFor([gift('96.61000218', 96, { ExpiredTime: stamp })])
    expect(credits.expiringSoon).toBeCloseTo(96.61000218, 8)
    expect(credits.nearestExpiryMs).toBeGreaterThan(Date.now())
  })
})
