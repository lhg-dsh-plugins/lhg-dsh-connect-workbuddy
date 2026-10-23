// @vitest-environment jsdom
/**
 * The CLI-route SWITCH, card side: the global opt-in that mounts `codebuddy_ask`
 * and `/codebuddy`, or mounts nothing at all.
 *
 * Why this is its own suite rather than a line in `cli-bridge.spec.ts`: that
 * file pins what the route DOES once it is mounted. This one pins the thing a
 * user actually touches — a checkbox that must be OFF by default, must read a
 * COMMITTED value rather than the (documented-stale) browser mirror, and must
 * write the global settings block without dropping the caps sitting next to it.
 *
 * The server-side half of the merge is `cli-bridge-switch.spec.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliBridgeEnabledOf, writeCliBridgeEnabled } from '../src/client/account-selection.ts'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { fakeScope, mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

describe('cliBridgeEnabledOf', () => {
  it('reads OFF for every shape that is not an explicit true', () => {
    expect(cliBridgeEnabledOf(undefined)).toBe(false)
    expect(cliBridgeEnabledOf({})).toBe(false)
    expect(cliBridgeEnabledOf({ cliBridge: {} })).toBe(false)
    expect(cliBridgeEnabledOf({ cliBridge: { enabled: false } })).toBe(false)
    // A stringified boolean is a settings-file typo, not consent.
    expect(cliBridgeEnabledOf({ cliBridge: { enabled: 'true' } })).toBe(false)
    // The provider switch is a different setting entirely.
    expect(cliBridgeEnabledOf({ regions: { cn: { enabled: true } } })).toBe(false)
  })

  it('reads ON only for an explicit boolean true', () => {
    expect(cliBridgeEnabledOf({ cliBridge: { enabled: true } })).toBe(true)
  })
})

describe('writeCliBridgeEnabled', () => {
  it('posts the GLOBAL field to the Host and mirrors what it stored', async () => {
    const calls: { url: string, body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: unknown, init: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: { enabled: true, maxTurns: 25 } }),
      }
    })
    const setCalls: [string, unknown][] = []
    const scope = {
      getSnapshot: () => ({ value: {} }),
      set: async (field: string, value: unknown) => {
        setCalls.push([field, value])
        return true
      },
    }
    await writeCliBridgeEnabled(scope as never, true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/plugins/dsh-connect-workbuddy/__save')
    // No region wrapper: this field is global, so the posted value is itself.
    expect(calls[0]?.body).toEqual({ field: 'cliBridge', value: { enabled: true } })
    // The mirror is refreshed with the HOST's block, not a client-side re-merge.
    expect(setCalls).toEqual([['cliBridge', { enabled: true, maxTurns: 25 }]])
  })

  it('falls back to the settings scope when the Host endpoint is unavailable, and verifies it landed', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('offline') })
    const store: { value: Record<string, unknown> } = {
      value: { cliBridge: { enabled: false, maxTurns: 25 } },
    }
    const scope = {
      getSnapshot: () => ({ value: store.value }),
      set: async (field: string, value: unknown) => {
        store.value = { ...store.value, [field]: value }
        return true
      },
    }
    await writeCliBridgeEnabled(scope as never, true)
    expect(store.value.cliBridge).toMatchObject({ enabled: true, maxTurns: 25 })
  })

  it('throws when neither writer persists the value', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('offline') })
    const scope = {
      getSnapshot: () => ({ value: {} }),
      // Settling `false` is the 0.1.7 refusal channel: nothing was stored, so
      // reporting success would silently throw the click away.
      set: async () => false,
    }
    await expect(writeCliBridgeEnabled(scope as never, true)).rejects.toThrow(/cliBridge/)
  })
})

/** A signed-in usage body carrying the switch's committed value. */
function usageOf(cliBridgeEnabled: boolean): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'cn One' }],
    models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    enabledModelIds: ['glm-5.3'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
    enabled: true,
    cliBridgeEnabled,
  }
}

describe('the card renders the global CLI switch', () => {
  const render = async (cliBridgeEnabled: boolean) => {
    const calls = stubFetch((url: string) => ({
      body: url.includes('__save') ? { ok: true, value: { enabled: true } } : usageOf(cliBridgeEnabled),
    }))
    const m = await mount(WorkBuddyCard, {
      t,
      settingsScope: fakeScope({ regions: { cn: { enabled: true } } }),
      view: 'page',
    })
    await m.settle()
    return { m, calls }
  }

  it('renders it OFF when the Host says off, and usable for a live region', async () => {
    const { m } = await render(false)
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-cli-bridge-check')
    expect(box).not.toBeNull()
    expect(box?.checked).toBe(false)
    // GLOBAL: unlike the credit line it is not gated on the region's provider,
    // because the route can pull its credential from the other region.
    expect(box?.disabled).toBe(false)
  })

  it('renders it ON when the Host says on', async () => {
    const { m } = await render(true)
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-cli-bridge-check')
    expect(box?.checked).toBe(true)
  })

  it('posts the global field when clicked, not a region slot', async () => {
    const { m, calls } = await render(false)
    const box = m.container.querySelector<HTMLInputElement>('.dsm-workbuddy-cli-bridge-check')
    await m.click(box as Element)
    const save = calls.find(call => String(call.url).includes('__save'))
    expect(save).toBeDefined()
    expect(String(save?.init?.body)).toContain('"field":"cliBridge"')
    expect(String(save?.init?.body)).toContain('"enabled":true')
  })

  it('keeps its own class, so the credit-switch suite still sees exactly one `.dsm-workbuddy-pref-check`', async () => {
    const { m } = await render(false)
    // `.dsm-workbuddy-pref-check` is that suite's contract; a second element
    // carrying it would make every single-checkbox selector resolve wrongly.
    const shared = m.container.querySelectorAll('.dsm-workbuddy-pref-check')
    expect(shared).toHaveLength(1)
  })
})
