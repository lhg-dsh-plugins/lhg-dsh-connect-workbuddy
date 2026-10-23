/**
 * Issue #79: surface the promotional benefits an account has NOT claimed yet.
 *
 * The bug being fixed is one of omission: a crash-compensation campaign opened a
 * 500-credit window on every account in a pool, and the only way to notice was to
 * sign into each account's 「套餐与积分」 page before it lapsed. With a pool of
 * eight accounts that is eight logins to learn something two cheap reads already
 * know.
 *
 * The design follows the issue's explicit boundary — **发现是只读的**. These two
 * endpoints are STATUS reads; the plugin never calls the matching `claim-*`
 * endpoints, and there is deliberately no batch-claim action. The card reports;
 * the user claims, in the place they already claim things.
 *
 * What earns the cases below:
 *   1. `active` alone is NOT "claimable" — a claimed account still reports
 *      `active: true` (measured), so a card keyed on `active` would show the claim
 *      button forever.
 *   2. a claimed benefit renders as ABSENCE, per the issue: 领过的就不要显示了.
 *   3. a lapsed campaign disappears on its own, because the gateway flips `active`
 *      to `false` when the window closes — the frontend must not re-derive that
 *      from `end_time`, or clock skew would contradict the server.
 *   4. one campaign's endpoint failing must not hide the other.
 */
import { describe, expect, it } from 'vitest'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyBenefit } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  BENEFIT_CACHE_MS,
  URGENT_DAYS,
  WORKBUDDY_BENEFIT_TITLES,
  benefitOf,
  claimableBenefits,
} from '../src/benefits.ts'

const credential: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.workbuddy.cn',
  uid: 'uid',
  source: 'dsh',
  filePath: '/tmp/auth.info',
}

/** A day in ms, so the fixtures read as "how far away is the deadline". */
const DAY = 86_400_000

function benefit(over: Partial<WorkBuddyBenefit> = {}): WorkBuddyBenefit {
  return {
    kind: 'compensation',
    active: true,
    claimed: false,
    creditNum: 500,
    endsAtMs: Date.now() + 3 * DAY,
    ...over,
  }
}

/** Answer both status endpoints; `routes` maps a path suffix to its body. */
function stub(routes: Record<string, unknown>): string[] {
  const urls: string[] = []
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url)
    urls.push(href)
    const key = Object.keys(routes).find(suffix => href.endsWith(suffix))
    const body = key === undefined ? { code: 500, msg: 'boom' } : routes[key]
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return urls
}

const COMP = '/billing/meter/compensation-status'
const GIFT = '/billing/meter/check-gift-claimed'

describe('reading benefit status', () => {
  it('reads both campaigns and parses their windows', async () => {
    const urls = stub({
      [COMP]: { code: 0, data: { claimed: false, active: true, credit_num: 500, validity_period: 1, end_time: '2026-10-22 23:59:59' } },
      [GIFT]: { code: 0, data: { claimed: true, claimed_at: '2026-06-23 11:45:31', active: true, credit_num: 1500, start_time: '2026-04-01 00:00:00', end_time: '2026-10-31 23:59:59' } },
    })
    const benefits = await new WorkBuddyUpstreamClient().fetchBenefits(credential)
    expect(urls.sort()).toEqual([
      'https://www.codebuddy.cn/billing/meter/check-gift-claimed',
      'https://www.codebuddy.cn/billing/meter/compensation-status',
    ])
    const [compensation, gift] = benefits
    expect(compensation).toMatchObject({ kind: 'compensation', active: true, claimed: false, creditNum: 500 })
    // The gateway states wall-clock time with no zone; `Date.parse` reads it as
    // LOCAL, so the assertion has to as well.
    expect(compensation?.endsAtMs).toBe(new Date('2026-10-22T23:59:59').getTime())
    expect(gift).toMatchObject({ kind: 'gift', active: true, claimed: true, creditNum: 1500 })
    expect(gift?.claimedAtMs).toBe(new Date('2026-06-23T11:45:31').getTime())
    expect(gift?.startsAtMs).toBe(new Date('2026-04-01T00:00:00').getTime())
  })

  it('omits the time fields the gateway did not send', async () => {
    // Compensation carries no `start_time`, and the international answer carries
    // no `claimed_at`. Absent must stay absent: a `0` would read as 1970.
    stub({
      [COMP]: { code: 0, data: { claimed: false, active: true, credit_num: 500, end_time: '2026-10-22 23:59:59' } },
      [GIFT]: { code: 0, data: { claimed: false, active: false, credit_num: 1000, end_time: '2026-04-15 23:59:59' } },
    })
    const [compensation] = await new WorkBuddyUpstreamClient().fetchBenefits(credential)
    expect(compensation).not.toHaveProperty('startsAtMs')
    expect(compensation).not.toHaveProperty('claimedAtMs')
  })

  it('keeps the other campaign when one endpoint fails', async () => {
    stub({ [COMP]: { code: 0, data: { claimed: false, active: true, credit_num: 500 } } })
    const benefits = await new WorkBuddyUpstreamClient().fetchBenefits(credential)
    expect(benefits.map(item => item.kind)).toEqual(['compensation'])
  })

  it('reports nothing when every endpoint fails', async () => {
    stub({})
    expect(await new WorkBuddyUpstreamClient().fetchBenefits(credential)).toEqual([])
  })
})

describe('deciding what the card shows', () => {
  const now = Date.parse('2026-10-19T12:00:00Z')

  it('offers a benefit that is active and unclaimed', () => {
    // 2.5 days out → ceil to 3, which is exactly the 「3 天内到期」 highlight.
    const view = benefitOf(benefit({ endsAtMs: now + 2.5 * DAY }), now)
    expect(view.state).toBe('claimable')
    expect(view.daysLeft).toBe(3)
    expect(view.urgent).toBe(true)
  })

  it('treats a CLAIMED benefit as claimed even though the gateway says active', () => {
    // Measured on a real pool: account 966e7bf8 answered
    // `{claimed: true, active: true}`. Keying the card on `active` would have
    // shown 「立即领取」 for a campaign this account had already taken.
    const view = benefitOf(benefit({ claimed: true, active: true }), now)
    expect(view.state).toBe('claimed')
    expect(view.urgent).toBe(false)
  })

  it('treats a lapsed campaign as expired even though it was never claimed', () => {
    // Also measured: every international account kept answering
    // `{claimed: false, active: false}` long after its window closed.
    const view = benefitOf(
      benefit({ active: false, claimed: false, endsAtMs: Date.parse('2026-04-30T23:59:59Z') }),
      now,
    )
    expect(view.state).toBe('expired')
  })

  it('drops claimed and expired campaigns from the list entirely', () => {
    // The issue's rule: 领取过的就不要显示了. Absence, not a disabled row.
    const views = claimableBenefits([
      benefit({ kind: 'compensation', claimed: true }),
      benefit({ kind: 'gift', active: false }),
      benefit({ kind: 'gift', endsAtMs: Date.parse('2026-10-21T00:00:00Z') }),
    ], now)
    expect(views.map(view => view.kind)).toEqual(['gift'])
  })

  it('orders by the soonest deadline, and a missing deadline sorts last', () => {
    const views = claimableBenefits([
      benefit({ kind: 'gift' }),
      benefit({ kind: 'compensation', endsAtMs: now + DAY }),
    ], now)
    expect(views.map(view => view.kind)).toEqual(['compensation', 'gift'])
    expect(claimableBenefits([benefit({ endsAtMs: undefined as unknown as number })], now)[0]?.daysLeft).toBeUndefined()
  })

  it('does not call a deadline urgent once it is comfortably far away', () => {
    const view = benefitOf(benefit({ endsAtMs: now + (URGENT_DAYS + 1) * DAY }), now)
    expect(view.urgent).toBe(false)
  })

  it('never reports negative days for a window that already closed', () => {
    const view = benefitOf(benefit({ active: false, endsAtMs: now - 5 * DAY }), now)
    expect(view.daysLeft).toBe(0)
  })

  it('trusts the gateway window over the local clock', () => {
    // A skewed clock must not resurrect or kill a campaign the server still
    // considers open; only the countdown is local.
    expect(benefitOf(benefit({ active: true, endsAtMs: now - 5 * DAY }), now).state).toBe('claimable')
  })
})

describe('the display contract', () => {
  it('names every campaign kind', () => {
    expect(Object.keys(WORKBUDDY_BENEFIT_TITLES).sort()).toEqual(['compensation', 'gift'])
    expect(Object.values(WORKBUDDY_BENEFIT_TITLES).every(title => title.length > 0)).toBe(true)
  })

  it('caches far longer than a card poll', () => {
    // The card polls every minute; two endpoints per account per minute would be
    // thousands of requests a day for state that changes when a human acts.
    expect(BENEFIT_CACHE_MS).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })
})
