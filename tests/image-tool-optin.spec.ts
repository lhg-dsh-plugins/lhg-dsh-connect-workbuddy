/**
 * The image tool is the ONE capability in this plugin where the MODEL decides to
 * spend credits — about 5.71 per image, and the host has no per-call approval
 * seam (`needsApproval` / `toolApproval` do not exist; verified against the
 * shipped `app.asar`). Every other spending path needs a human action: a chat
 * request is one the user sent, and the per-model "test" button is one the user
 * clicked.
 *
 * So it is opt-IN, and off means the tool is NOT REGISTERED — not "registered
 * but refusing". A registered tool appears in the model's tool list, which
 * invites a call that then fails; a tool that was never registered is invisible
 * and cannot spend anything. These cases pin that contract.
 */
import { describe, expect, it } from 'vitest'
import { regionStateOf } from '../src/index.ts'
import {
  nextRegionImageToolEnabled,
  regionImageToolEnabledOf,
} from '../src/status-paths.ts'

describe('regionImageToolEnabledOf', () => {
  it('reads OFF for every shape that does not say ON', () => {
    // OPT-IN, unlike the credit line and the provider switch next to it in the
    // same slot. Those two are opt-OUT (`!== false`) because their absence
    // should behave like a fresh install; this one authorizes spending, so
    // absence must never be read as consent.
    expect(regionImageToolEnabledOf({}, 'cn')).toBe(false)
    expect(regionImageToolEnabledOf({ regions: {} }, 'cn')).toBe(false)
    expect(regionImageToolEnabledOf({ regions: { cn: {} } }, 'cn')).toBe(false)
    expect(regionImageToolEnabledOf({ regions: { cn: { imageToolEnabled: false } } }, 'cn')).toBe(false)
    // A truthy non-boolean is not consent either: a hand-edited profile that
    // wrote `"yes"` or `1` must not unlock spending.
    expect(regionImageToolEnabledOf({ regions: { cn: { imageToolEnabled: 'yes' } } }, 'cn')).toBe(false)
    expect(regionImageToolEnabledOf({ regions: { cn: { imageToolEnabled: 1 } } }, 'cn')).toBe(false)
  })

  it('reads ON only for an explicit boolean true', () => {
    expect(regionImageToolEnabledOf({ regions: { cn: { imageToolEnabled: true } } }, 'cn')).toBe(true)
  })

  it('is per-region, so the CN opt-in does not leak into the global tab', () => {
    const value = { regions: { cn: { imageToolEnabled: true } } }
    expect(regionImageToolEnabledOf(value, 'cn')).toBe(true)
    expect(regionImageToolEnabledOf(value, 'global')).toBe(false)
  })
})

describe('nextRegionImageToolEnabled', () => {
  it('changes only that one flag of that one slot', () => {
    const value = { regions: { cn: { enabled: true, enabledModelIds: ['hy3'] }, global: { enabled: false } } }
    const next = nextRegionImageToolEnabled(value, 'cn', true) as any
    expect(next.cn.imageToolEnabled).toBe(true)
    // The rest of the slot survives, and so does the sibling region — the write
    // is a merge, not a replacement.
    expect(next.cn.enabled).toBe(true)
    expect(next.cn.enabledModelIds).toEqual(['hy3'])
    expect(next.global.enabled).toBe(false)
  })

  it('round-trips through the reader', () => {
    const on = nextRegionImageToolEnabled({ regions: { cn: {} } }, 'cn', true)
    expect(regionImageToolEnabledOf({ regions: on }, 'cn')).toBe(true)
    const off = nextRegionImageToolEnabled({ regions: on }, 'cn', false)
    expect(regionImageToolEnabledOf({ regions: off }, 'cn')).toBe(false)
  })
})

describe('the config default is OFF', () => {
  it('treats an empty config as not opted in', () => {
    // The upgrade path is the one that matters: nobody's existing profile says
    // `imageToolEnabled`, so every existing user must land on OFF.
    expect(regionStateOf({}, 'cn').imageToolEnabled).toBeUndefined()
    expect(regionImageToolEnabledOf({}, 'cn')).toBe(false)
  })

  it('does not interpret the provider switch as the opt-in', () => {
    // A region that is ON (the default) must still have the image tool OFF:
    // these are two independent gates, and conflating them would hand every
    // existing user a spending capability on upgrade.
    expect(regionStateOf({ regions: { cn: { enabled: true } } }, 'cn').imageToolEnabled).toBeUndefined()
    expect(regionImageToolEnabledOf({ regions: { cn: { enabled: true } } }, 'cn')).toBe(false)
  })
})

describe('the card shows the opt-in on the CN tab only', () => {
  it('puts the checkbox in the preference block, not the account pool', async () => {
    // It lives among the credit preferences rather than inside AccountPool so a
    // Host that reports no pool state still renders it — the same reason the
    // credit switch sits there.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/client/WorkBuddyCard.tsx', import.meta.url), 'utf8')
    // CN-only: the upstream publishes a `text-to-image` model on the CN gateway
    // and none at all internationally, so the box on the global tab would be a
    // control that can never do anything.
    expect(source).toContain("activeRegion === 'cn'")
    expect(source).toContain('toggleImageTool')
    // Its own class: `.dsm-workbuddy-pref-check` is the contract the
    // credit-switch suite selects on ("exactly one switch"), so a second element
    // carrying it would make every single-checkbox selector resolve wrongly.
    expect(source).toContain('dsm-workbuddy-image-tool-check')
  })
})
