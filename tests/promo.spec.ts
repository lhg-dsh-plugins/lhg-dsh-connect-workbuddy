/**
 * The upstream's promotion badges: how they are read, and WHEN they hold.
 *
 * The risk this file guards against is not the parsing — it is the CLOCK. A
 * promotion badge is a function of the clock: the upstream's campaigns run on
 * wall-clock hours in a named zone (`23:00`–`7:50` Asia/Shanghai is the
 * observed CN night discount), so a badge chosen when the document was read
 * would keep claiming the night after the night is over. Every assertion
 * below therefore asks "what holds NOW", not "what was parsed".
 *
 * The fixtures are the upstream's REAL entries, copied from the global feed's
 * `/v3/config` on 2026-10-21 — including the two entries in
 * `modelPromotions` that are not promotions at all (the image and video
 * models), because dropping those is a parsing rule, not an accident.
 */
import { describe, expect, it } from 'vitest'
import {
  attachPromos,
  parseWorkBuddyPromos,
  promoActiveAt,
  selectPromoBadge,
} from '../src/promo.ts'

/** The observed global-feed promotion, unchanged in shape. */
const hy3Promotion = {
  id: 'hy3-free-trial-202608',
  kind: 'discount',
  enabled: true,
  priority: 200,
  modelIds: ['hy3'],
  badge: { label: 'Free now', color: '#FF0000', display: 'activeOnly' },
  discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
  hover: { textZh: 'Aug 6 – Oct 31: Free daily use with unlimited credits.' },
  schedule: {
    timezone: 'Asia/Shanghai',
    validFrom: '2026-07-06T00:00:00+08:00',
    validUntil: '2026-11-01T00:00:00+08:00',
  },
}

/** The observed tier entry, which has no schedule at all. */
const gptProTier = {
  id: 'gpt-pro-only',
  badge: { label: 'Pro Only', labelEn: 'Pro Only', color: '#009273' },
  hover: { textEn: 'Exclusive to Pro subscribers.', textZh: '模型仅面向 Pro 用户开放。' },
  modelIds: ['gpt-6-astra', 'gpt-5.4'],
  priority: 200,
  requiredUserType: 'standard',
  tier: 'standard',
}

/** The two entries the global feed puts in `modelPromotions` that are not promotions. */
const notPromotions = [
  { id: 'hy-image-3.5', name: 'HY-Image-3.5', tags: ['image', 'generation'] },
  { id: 'kling-video-v3', name: 'Kling Video V3', videoGeneration: { maxDuration: 10 } },
]

/** `2026-10-21T23:30:00+08:00` — inside the observed CN night window. */
const NIGHT_2330 = Date.parse('2026-10-21T23:30:00+08:00')
/** `2026-10-21T08:00:00+08:00` — the same day, outside it. */
const MORNING_0800 = Date.parse('2026-10-21T08:00:00+08:00')

describe('promotion parsing', () => {
  it('drops the entries that are not promotions', () => {
    // The upstream's `modelPromotions` array carries the image and video
    // models. They have no `modelIds` and no `badge`, so there is nothing to
    // draw and nothing to attach them to — they must not become a badge on
    // some model by accident.
    expect(parseWorkBuddyPromos(notPromotions, [])).toEqual([])
  })

  it('drops an entry the upstream switched off', () => {
    const [promo] = parseWorkBuddyPromos([{ ...hy3Promotion, enabled: false }], [])
    expect(promo).toBeUndefined()
  })

  it('reads the badge, the copy and the lifetime of a promotion', () => {
    const [promo] = parseWorkBuddyPromos([hy3Promotion], [])
    expect(promo?.id).toBe('hy3-free-trial-202608')
    expect(promo?.source).toBe('promotion')
    expect(promo?.modelIds).toEqual(['hy3'])
    expect(promo?.badge.label).toBe('Free now')
    expect(promo?.badge.color).toBe('#FF0000')
    expect(promo?.badge.display).toBe('activeOnly')
    expect(promo?.hover?.textZh).toContain('Free daily use')
    expect(promo?.schedule?.timezone).toBe('Asia/Shanghai')
    expect(promo?.schedule?.validFrom).toBe(Date.parse('2026-07-06T00:00:00+08:00'))
    expect(promo?.schedule?.validUntil).toBe(Date.parse('2026-11-01T00:00:00+08:00'))
  })

  it('reads the tier entries, which carry no schedule', () => {
    const [tier] = parseWorkBuddyPromos([], [gptProTier])
    expect(tier?.source).toBe('tier')
    expect(tier?.badge.label).toBe('Pro Only')
    expect(tier?.badge.labelEn).toBe('Pro Only')
    expect(tier?.schedule).toBeUndefined()
    // A tier without a schedule has no end: it describes the model for as
    // long as the upstream publishes it.
    expect(promoActiveAt(tier!, NIGHT_2330)).toBe(true)
  })

  it('keeps every candidate, so the renderer can pick the one that holds', () => {
    // Two promotions name the same model, and only one of them is running at
    // a given moment. The parser must not choose — choosing here is the
    // defect that freezes a night badge into the morning.
    const promos = parseWorkBuddyPromos([
      { ...hy3Promotion, id: 'night', badge: { label: 'Night', display: 'activeOnly' }, schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] } },
      { ...hy3Promotion, id: 'day', badge: { label: 'Day', display: 'activeOnly' }, schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '7:50', end: '23:00' }] } },
    ], [])
    expect(promos).toHaveLength(2)
  })
})

describe('promotion attachment', () => {
  it('attaches to the models it names, highest priority first', () => {
    const promos = parseWorkBuddyPromos([
      { ...hy3Promotion, id: 'low', priority: 10, modelIds: ['hy3'] },
      { ...hy3Promotion, id: 'high', priority: 90, modelIds: ['hy3'] },
    ], [])
    const [model] = attachPromos([{ id: 'hy3' }, { id: 'other' }], promos)
    expect(model?.promos?.map(promo => promo.id)).toEqual(['high', 'low'])
  })

  it('leaves a model that no promotion names alone', () => {
    const promos = parseWorkBuddyPromos([hy3Promotion], [])
    const [model] = attachPromos([{ id: 'other' }], promos)
    // No empty array: an absent field is the honest answer, and it keeps the
    // persisted catalog small.
    expect(model?.promos).toBeUndefined()
  })
})

describe('which badge holds now', () => {
  it('holds a promotion only inside its lifetime', () => {
    const [promo] = parseWorkBuddyPromos([hy3Promotion], [])
    expect(promoActiveAt(promo!, Date.parse('2026-08-06T12:00:00+08:00'))).toBe(true)
    // Before it starts.
    expect(promoActiveAt(promo!, Date.parse('2026-07-05T12:00:00+08:00'))).toBe(false)
    // After it ends — the end is EXCLUSIVE, so the last day still shows it.
    expect(promoActiveAt(promo!, Date.parse('2026-10-31T12:00:00+08:00'))).toBe(true)
    expect(promoActiveAt(promo!, Date.parse('2026-11-01T00:00:00+08:00'))).toBe(false)
  })

  it('reads the daily window in the zone the upstream named', () => {
    // The CN night discount runs 23:00–07:50 Asia/Shanghai. The instants
    // below carry that zone's offset, and the window is evaluated in the
    // upstream's zone — not the test runner's, and not the user's.
    const [night] = parseWorkBuddyPromos([{
      ...hy3Promotion,
      id: 'night',
      badge: { label: '夜间折扣', display: 'activeOnly' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
    }], [])
    expect(promoActiveAt(night!, NIGHT_2330)).toBe(true)
    // The same night, an hour later — the window crosses midnight.
    expect(promoActiveAt(night!, Date.parse('2026-10-22T03:00:00+08:00'))).toBe(true)
    // The same morning: the night is over.
    expect(promoActiveAt(night!, MORNING_0800)).toBe(false)
    // The window's own edges are inclusive at the start, exclusive at the end.
    expect(promoActiveAt(night!, Date.parse('2026-10-21T23:00:00+08:00'))).toBe(true)
    expect(promoActiveAt(night!, Date.parse('2026-10-22T07:50:00+08:00'))).toBe(false)
  })

  it('draws the running promotion, not the one that is asleep', () => {
    const promos = parseWorkBuddyPromos([
      { ...hy3Promotion, id: 'night', badge: { label: 'Night', display: 'activeOnly' }, schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] } },
      { ...hy3Promotion, id: 'day', badge: { label: 'Day', display: 'activeOnly' }, schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '7:50', end: '23:00' }] } },
    ], [])
    expect(selectPromoBadge(promos, NIGHT_2330)?.id).toBe('night')
    expect(selectPromoBadge(promos, MORNING_0800)?.id).toBe('day')
  })

  it('drops a promotion whose lifetime is over', () => {
    const [promo] = parseWorkBuddyPromos([hy3Promotion], [])
    // The observed promotion ended on 2026-11-01; after that there is no
    // badge at all, not a stale one.
    expect(selectPromoBadge([promo!], Date.parse('2026-11-02T12:00:00+08:00'))).toBeUndefined()
  })

  it('prefers a running promotion over a standing tier badge', () => {
    // The upstream numbers the price promotion and the tier badge equally
    // (both 200 on the observed feed). A running price badge is the more
    // actionable of the two, so it is the one the row shows.
    const promos = parseWorkBuddyPromos([hy3Promotion], [gptProTier])
    const selected = selectPromoBadge(promos, Date.parse('2026-08-06T12:00:00+08:00'))
    expect(selected?.source).toBe('promotion')
  })

  it('falls back to a standing badge once the promotion is over', () => {
    // A badge the upstream did NOT mark `activeOnly` describes the model for
    // as long as the promotion itself lasts — the upstream uses this for its
    // night-discount pairs, where the badge stays and only the hours change.
    const promos = parseWorkBuddyPromos([{
      ...hy3Promotion,
      id: 'standing',
      badge: { label: '限时免费' },
      schedule: {
        timezone: 'Asia/Shanghai',
        validFrom: '2026-07-06T00:00:00+08:00',
        validUntil: '2026-11-01T00:00:00+08:00',
        daily: [{ start: '23:00', end: '7:50' }],
      },
    }], [])
    // Inside the hours: the promotion itself is the running one.
    expect(selectPromoBadge(promos, NIGHT_2330)?.id).toBe('standing')
    // Outside them the badge still stands — the hours govern the discount.
    expect(selectPromoBadge(promos, MORNING_0800)?.id).toBe('standing')
    // But not past the promotion's own lifetime.
    expect(selectPromoBadge(promos, Date.parse('2027-01-01T12:00:00+08:00'))).toBeUndefined()
  })

  it('draws nothing for a model no promotion names', () => {
    expect(selectPromoBadge(undefined, NIGHT_2330)).toBeUndefined()
    expect(selectPromoBadge([], NIGHT_2330)).toBeUndefined()
  })

  it('treats a published-but-unreadable daily window as never running, not as all day', () => {
    // The upstream DID say this campaign has hours; every one of them failed to
    // parse. Reading that as "no hours" would turn a night-only discount into a
    // badge shown around the clock — the one direction that overstates the
    // offer. The parse failure must hide the badge, not widen it.
    const broken = [
      { start: '23:00', end: '25:00' },       // hour out of range
      { start: '23:00:00', end: '07:50:00' }, // seconds in the clock value
      { from: '23:00', to: '07:50' },         // renamed keys
    ]
    for (const daily of broken) {
      const [promo] = parseWorkBuddyPromos([{
        ...hy3Promotion,
        id: 'broken',
        badge: { label: '限时免费', display: 'activeOnly' },
        schedule: { timezone: 'Asia/Shanghai', daily: [daily] },
      }], [])
      expect(promo?.schedule?.dailyUnusable).toBe(true)
      // 13:00 is outside the intended night window; it must draw nothing.
      expect(selectPromoBadge([promo!], Date.parse('2026-10-21T13:00:00+08:00'))).toBeUndefined()
      // And it must not stand as a badge either.
      expect(selectPromoBadge([promo!], NIGHT_2330)).toBeUndefined()
    }
  })

  it('keeps the upstream saying nothing about hours as a 24-hour campaign', () => {
    // No `daily` at all is a genuinely 24-hour campaign (the tier badge is the
    // real instance). It must NOT be lumped in with the parse failures above.
    const [tier] = parseWorkBuddyPromos([], [gptProTier])
    expect(tier?.schedule).toBeUndefined()
    expect(selectPromoBadge([tier!], MORNING_0800)?.id).toBe('gpt-pro-only')
  })

  it('reads a window that ends at 24:00 without leaving a midnight hole', () => {
    const [promo] = parseWorkBuddyPromos([{
      ...hy3Promotion,
      id: 'all-day',
      badge: { label: '全天', display: 'activeOnly' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '0:00', end: '24:00' }] },
    }], [])
    for (const iso of ['2026-10-21T00:00:00+08:00', '2026-10-21T12:00:00+08:00', '2026-10-21T23:59:00+08:00']) {
      expect(promoActiveAt(promo!, Date.parse(iso))).toBe(true)
    }
  })

  it('reads a window whose endpoints are equal as a 24-hour window', () => {
    // docs/PROMO_BADGE.md states this rule; it must be pinned so the "start
    // inclusive, end exclusive" reading cannot silently turn it into an empty
    // interval. This branch had no coverage before.
    const [promo] = parseWorkBuddyPromos([{
      ...hy3Promotion,
      id: 'same',
      badge: { label: 'Same', display: 'activeOnly' },
      schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '08:00', end: '08:00' }] },
    }], [])
    expect(promoActiveAt(promo!, Date.parse('2026-10-21T03:00:00+08:00'))).toBe(true)
    expect(promoActiveAt(promo!, Date.parse('2026-10-21T13:00:00+08:00'))).toBe(true)
  })

  it('lets a genuinely running campaign outrank a schedule-less tier badge', () => {
    // A tier badge has no hours, so `promoActiveAt` is trivially true for it.
    // Treating that as "running" let a high-priority tier shadow a LOWER
    // priority campaign whose window really is open — the opposite of what the
    // "a running promotion wins" rule promises. Step 1 is restricted to
    // entries that publish hours; the tier competes in step 2.
    const promos = parseWorkBuddyPromos([
      {
        ...hy3Promotion,
        id: 'night-campaign',
        priority: 100,
        badge: { label: '夜间折扣', display: 'activeOnly' },
        schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
      },
    ], [{ ...gptProTier, id: 'high-tier', priority: 200 }])
    expect(selectPromoBadge(promos, NIGHT_2330)?.id).toBe('night-campaign')
    // Outside the campaign's hours the schedule-less tier is the only answer.
    expect(selectPromoBadge(promos, MORNING_0800)?.id).toBe('high-tier')
  })

  it('breaks a priority tie toward the promotion regardless of input order', () => {
    const price = { ...hy3Promotion, id: 'price', priority: 200, badge: { label: 'P' } }
    const access = { ...gptProTier, id: 'access', priority: 200 }
    expect(selectPromoBadge(parseWorkBuddyPromos([price], [access]), MORNING_0800)?.id).toBe('price')
    // Reversing the order must not change the answer: the tie-break has to be
    // in the comparator, not an accident of which array was read first.
    expect(selectPromoBadge(parseWorkBuddyPromos([price], [access]).reverse(), MORNING_0800)?.id).toBe('price')
  })
})
