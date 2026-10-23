// @vitest-environment jsdom
/**
 * The speed-sweep button must be CLICKABLE when it has work to do
 * (issue #92 regression, found 2026-10-22 from a screenshot).
 *
 * THE DEFECT. The button's `disabled` expression contained
 * `tpsProbing !== undefined`, where `tpsProbing` is
 * `useState<Record<string, boolean>>({})` — a record that is ALWAYS an object and
 * therefore NEVER `undefined`. The comparison was permanently true, so the button
 * rendered permanently disabled and the whole one-click speed sweep was
 * unreachable from the UI, with no visible reason.
 *
 * WHY IT LOOKED RIGHT. The two availability sweeps beside it compare
 * `sweeping !== undefined`, and that is correct THERE: `sweeping` really is
 * `{done,total} | undefined`, so `undefined` genuinely means "not running". The
 * speed sweep copied the shape of that expression without the fact that made it
 * meaningful — a different state variable with a different possible-value set.
 * "Busy" for a map is "has keys", not "is defined".
 *
 * These tests are written against `disabled` as a BOOLEAN the DOM actually
 * exposes, not against the JSX text, because the bug lived in the expression and
 * a text-level assertion would have agreed with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'ds', creditMultiplier: 0.11 },
  { id: 'glm-5.3-flash', name: 'glm', creditMultiplier: 0.08 },
]

function usageOf(enabled: readonly string[]): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'CN One' }],
    models: MODELS,
    enabledModelIds: [...enabled],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
  }
}

/**
 * Render the card and record every speed request.
 *
 * The speed route is `/tps`, distinct from the availability probe's `/probe`, so
 * the stub can tell them apart — which is also why the two features cannot be
 * confused at the wire level.
 */
async function render(enabled: readonly string[] = ['deepseek-v4.1-flash']) {
  const measured: string[] = []
  stubFetch((url, init) => {
    if (url.includes('/tps')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { modelIds?: string[] }
      const ids = body.modelIds ?? []
      measured.push(...ids)
      return {
        body: {
          results: ids.map(modelId => ({
            modelId,
            outcome: 'ok',
            tokensPerSecond: 396,
            timeToFirstTokenMs: 1115,
            samples: 3,
            complete: true,
          })),
        },
      }
    }
    return { body: usageOf(enabled) }
  })
  const scope = fakeScope({ regions: { cn: {} } })
  const m = await mount(WorkBuddyCard, { t, settingsScope: scope, view: 'page' })
  await m.settle()
  return { m, measured }
}

/** The speed sweep button, located by its own label (not by class, which it shares). */
function tpsSweepButton(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.dsm-workbuddy-models-sweep'))
    .find(b => (b.textContent ?? '').includes('row.tpsSweepEnabled'))
}

describe('the speed-sweep button is reachable', () => {
  it('is NOT disabled when models are enabled and nothing is running', async () => {
    // The regression. Before the fix this assertion failed with `true`, and the
    // button could never be pressed.
    const { m } = await render(['deepseek-v4.1-flash'])
    const button = tpsSweepButton(m.container)
    expect(button).toBeDefined()
    expect(button?.disabled).toBe(false)
  })

  it('actually measures the enabled models when clicked', async () => {
    // "Not disabled" is only worth anything if the click does the work: this
    // asserts the request really went out, for exactly the enabled set.
    const { m, measured } = await render(['deepseek-v4.1-flash'])
    tpsSweepButton(m.container)?.click()
    await m.settle()
    expect(measured).toEqual(['deepseek-v4.1-flash'])
  })

  it('measures ONE model per request, like every other spending route', async () => {
    // The route refuses more than one id, and that cap is what keeps a stale
    // bundle from turning a click into an unaccounted spend over a whole roster.
    const { m, measured } = await render(['deepseek-v4.1-flash', 'glm-5.3-flash'])
    tpsSweepButton(m.container)?.click()
    await m.settle()
    expect(measured).toEqual(['deepseek-v4.1-flash', 'glm-5.3-flash'])
  })

  it('IS disabled when nothing is enabled — a sweep with no work to do', async () => {
    // The one disabled state that is real: the label promises "enabled models",
    // and there are none. This keeps the fix from making the button
    // unconditionally clickable.
    const { m } = await render([])
    expect(tpsSweepButton(m.container)?.disabled).toBe(true)
  })

  it('shows the measured speed on the model row afterwards', async () => {
    // End-to-end: the button's whole purpose is the number appearing beside the
    // model, so a click that sends but renders nothing would pass the tests above
    // and still be useless.
    const { m } = await render(['deepseek-v4.1-flash'])
    tpsSweepButton(m.container)?.click()
    await m.settle()
    expect(m.container.innerHTML).toContain('396')
  })
})
