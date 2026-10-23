/**
 * The `cliBridge` settings merge, server side.
 *
 * The switch lives on `WorkBuddyWebUsage` and its write goes through the Host's
 * own `__save` route, which merges the posted patch into the committed block.
 * That merge is the one place a save can silently reset the user's tuning: the
 * card only knows `{ enabled }`, while the committed block also holds
 * `maxTurns`, `binary`, `timeoutSecs` and the caps. So the merge is pinned here
 * as a pure function rather than only through the route.
 *
 * The card-side half of the switch (reading the committed value, the write's two
 * writers, the rendered checkbox) is `cli-bridge-card-switch.spec.tsx`, because
 * it has to run under the client tsconfig with DOM types.
 */
import { describe, expect, it } from 'vitest'
import { nextCliBridgeSettings } from '../src/web-status.ts'

describe('nextCliBridgeSettings', () => {
  it('keeps the tuned caps beside the switch', () => {
    // The dangerous save is the one that carries `{ enabled: true }` alone: a
    // naive replace would drop every cap the user tuned alongside it.
    const merged = nextCliBridgeSettings(
      { enabled: false, maxTurns: 25, binary: '/opt/codebuddy', maxTurnsPerHour: 0 },
      { enabled: true },
    )
    expect(merged).toEqual({
      enabled: true,
      maxTurns: 25,
      binary: '/opt/codebuddy',
      maxTurnsPerHour: 0,
    })
  })

  it('lets an explicit false win, so the switch can be turned OFF', () => {
    expect(nextCliBridgeSettings({ enabled: true }, { enabled: false }).enabled).toBe(false)
  })

  it('never invents a block out of a non-object patch', () => {
    expect(nextCliBridgeSettings({ enabled: true }, undefined)).toEqual({ enabled: true })
    expect(nextCliBridgeSettings(undefined, { enabled: true })).toEqual({ enabled: true })
    expect(nextCliBridgeSettings('nonsense', { enabled: true })).toEqual({ enabled: true })
  })
})
