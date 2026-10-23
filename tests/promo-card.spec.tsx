// @vitest-environment jsdom
/**
 * The upstream's promotion badge, rendered.
 *
 * The badge is the one thing in this card that says something the USER did
 * not configure: it is the upstream's own promotion, published in the same
 * document as the roster. Three properties are worth pinning, and all three
 * are about not overstating what the upstream said:
 *
 * 1. It says the upstream's own words — its label, its colour, its copy.
 * 2. It is GONE once the promotion is over. A badge that outlives its
 *    promotion is worse than no badge: the user would read "限时免费" as a
 *    standing fact about the model.
 * 3. It costs the row one chip, not a column: a model row is one line wide
 *    and already carries the name, the credit rate and two checkboxes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** A promotion in the shape the card receives it in (already parsed). */
function promo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hy3-free-trial-202608',
    source: 'promotion',
    modelIds: ['probe-model'],
    badge: { label: 'Free now', color: '#FF0000', display: 'activeOnly' },
    hover: { textZh: 'Aug 6 – Oct 31: Free daily use with unlimited credits.' },
    schedule: {
      timezone: 'Asia/Shanghai',
      validFrom: Date.now() - 86_400_000,
      validUntil: Date.now() + 86_400_000,
    },
    priority: 200,
    ...overrides,
  }
}

/** A signed-in usage body whose single model carries the given promotions. */
function usageWithPromos(promos: unknown[]): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'real-1', accountName: 'Real One' }],
    models: [{
      id: 'probe-model',
      name: 'Probe Model',
      contextWindow: 192_000,
      nativeContextWindow: 192_000,
      maxTokens: 64_000,
      ...(promos.length === 0 ? {} : { promos }),
    }],
    enabledModelIds: ['probe-model'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 20, expiringSoon: 0, packages: [] },
  }
}

const render = async (promos: unknown[]) => {
  stubFetch(() => ({ body: usageWithPromos(promos) }))
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
  await m.settle()
  return m
}

/** The badges in the rendered card, in document order. */
function chips(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.dsm-workbuddy-model-promo'))
}

describe('the promotion badge', () => {
  it('draws the upstream\'s own label', async () => {
    const m = await render([promo()])
    expect(chips(m.container).map(chip => chip.textContent)).toEqual(['Free now'])
  })

  it('draws the upstream\'s own colour', async () => {
    const m = await render([promo()])
    // The colour reaches the chip as a custom property, so the stylesheet
    // can tint the border and the background with it.
    expect(chips(m.container)[0]?.style.getPropertyValue('--dsm-workbuddy-promo-color')).toBe('#FF0000')
  })

  it('puts the upstream\'s own copy in the tooltip', async () => {
    const m = await render([promo()])
    expect(chips(m.container)[0]?.getAttribute('title')).toContain('Free daily use with unlimited credits')
  })

  it('draws nothing for a model no promotion names', async () => {
    const m = await render([])
    expect(chips(m.container)).toHaveLength(0)
  })

  it('draws nothing once the promotion is over', async () => {
    // The promotion's lifetime is the upstream's own: after it, the badge
    // must not keep advertising itself.
    const m = await render([promo({
      schedule: {
        timezone: 'Asia/Shanghai',
        validFrom: Date.parse('2026-07-06T00:00:00+08:00'),
        validUntil: Date.parse('2026-07-07T00:00:00+08:00'),
      },
    })])
    expect(chips(m.container)).toHaveLength(0)
  })

  it('draws one badge even when several promotions name the model', async () => {
    // A model row is one line wide: the upstream's `priority` orders the
    // entries that name a model, and the row shows the one that matters.
    const m = await render([
      promo({ id: 'low', priority: 10, badge: { label: 'Low' } }),
      promo({ id: 'high', priority: 90, badge: { label: 'High' } }),
    ])
    expect(chips(m.container).map(chip => chip.textContent)).toEqual(['High'])
  })
})
