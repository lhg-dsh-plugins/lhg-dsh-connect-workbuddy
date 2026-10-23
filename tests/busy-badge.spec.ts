/**
 * The load badge: it must SURVIVE a settings change, and it must be drawn as an
 * icon where an icon is possible.
 *
 * TWO CLAIMS, and the first one is the bug the user actually reported.
 *
 * 1. THE BADGE BLINKED OUT. Load levels live on the RUNTIME roster only —
 *    they are deliberately not persisted (`src/busy.ts`: a saved level is a lie
 *    the moment the settings page closes). But `applySelection()` rebuilds each
 *    region's roster from the SAVED `lastCatalog`, and a saved roster has no
 *    load level in it. So every config change — switching region, changing the
 *    model selection, toggling anything — wiped the badge that was on screen a
 *    moment earlier. The user saw "极度拥堵" appear and then vanish without the
 *    upstream having changed at all.
 *
 *    The fix asks the upstream again instead of remembering: the probe is
 *    read-only, free, and answers for the whole roster in ~190 ms.
 *
 * 2. THE BADGE IS DRAWN AS AN ICON where the plugin renders itself. The DSH
 *    model picker renders the model name as a plain string, so THAT place gets
 *    a character; the card gets a picture.
 */
import { describe, expect, it } from 'vitest'
import { attachBusyLevels, busyDisplaySuffix, busyIcon, busyLabel, busySymbol } from '../src/busy.ts'
import type { WorkBuddyBusyLevel } from '../src/busy.ts'

describe('the load badge survives a settings change', () => {
  it('re-stamps the level onto a roster rebuilt from the SAVED catalog', () => {
    // The situation, in miniature: a saved roster (no level) comes back from
    // the settings page, and the live probe's levels are applied to it.
    const savedRoster: { id: string, name: string, busyLevel?: WorkBuddyBusyLevel }[] = [
      { id: 'hy3', name: 'Hy3' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
    ]
    const levels = new Map([['hy3', 'congested' as const]])
    const restamped = attachBusyLevels(savedRoster, levels)
    // The badge is back on the row that had one...
    expect(restamped[0]?.busyLevel).toBe('congested')
    // ...and the row the probe said nothing about stays unbadged, rather than
    // being given an invented level.
    expect(restamped[1]?.busyLevel).toBeUndefined()
  })

  it('keeps the level OUT of the saved roster, because a saved level is a lie', () => {
    // The reason the badge has to be re-asked for rather than remembered: the
    // persisted entry carries no level, so the replay cannot restore one by
    // itself. This is the property that makes the re-probe necessary — if a
    // saved entry ever DID carry a level, the re-probe would be redundant.
    const saved: { id: string, name: string, busyLevel?: WorkBuddyBusyLevel } = { id: 'hy3', name: 'Hy3' }
    expect('busyLevel' in saved).toBe(false)
    const stamped = attachBusyLevels([saved], new Map([['hy3', 'busy' as const]]))
    expect(stamped[0]?.busyLevel).toBe('busy')
  })
})

describe('the load badge as a character (the DSH model picker)', () => {
  it('uses ONE character per level, because the name is a plain string', () => {
    // The picker renders `name` verbatim: no image slot, no markup. A word made
    // the row read as a sentence; a character reads as a badge.
    // ONE shape, repeated: the COUNT is what says "congested".
    // ONE shape, repeated: the COUNT says how congested it is.
    expect(busySymbol('congested')).toBe('🧍🧍🧍')
    expect(busySymbol('busy')).toBe('🧍🧍')
    // The healthy case is drawn too — one person, saying "free".
    expect(busySymbol('normal')).toBe('🧍')
    expect(busySymbol('unavailable')).toBe('🚫')
  })

  it('draws nothing ONLY for a level the upstream never reported', () => {
    // `unknown` is the plugin's own "the probe did not answer" — it must never
    // become a claim. Every level the upstream DID report is drawn, `idle`
    // included (one green person: "free right now" is useful).
    expect(busySymbol('unknown')).toBe('')
    expect(busySymbol(undefined)).toBe('')
  })

  it('appends the character to the RIGHT of the name', () => {
    expect(busyDisplaySuffix('congested')).toBe(' 🧍🧍🧍')
    expect(busyDisplaySuffix('busy')).toBe(' 🧍🧍')
    expect(busyDisplaySuffix('normal')).toBe(' 🧍')
    expect(busyDisplaySuffix('idle')).toBe(' 🚀')
    expect(busyDisplaySuffix('unknown')).toBe('')
    expect(busyDisplaySuffix(undefined)).toBe('')
  })
})

describe('the load badge as an icon (the card)', () => {
  it('has an icon for every level the upstream reported', () => {
    expect(busyIcon('idle')).toBe('idle')
    expect(busyIcon('normal')).toBe('normal')
    expect(busyIcon('busy')).toBe('busy')
    expect(busyIcon('congested')).toBe('congested')
    expect(busyIcon('unavailable')).toBe('unavailable')
  })

  it('has NO icon for "we were told nothing"', () => {
    // `unknown` is the plugin's own "the probe did not answer" — it must
    // never be turned into a claim the upstream did not make.
    expect(busyIcon('unknown')).toBeUndefined()
    expect(busyIcon(undefined)).toBeUndefined()
  })
})

describe('the word is still available, for the icon tooltip', () => {
  it('keeps the upstream wording in both languages', () => {
    // The card draws a picture, but the level must stay READABLE: the icon
    // carries the word in its `title`, so the information is not lost.
    expect(busyLabel('busy')).toBe('轻微拥堵')
    expect(busyLabel('congested')).toBe('极度拥堵')
    expect(busyLabel('unavailable')).toBe('不可用')
    expect(busyLabel('idle')).toBe('空闲')
    expect(busyLabel('busy', 'en')).toBe('Slightly congested')
    expect(busyLabel('congested', 'en')).toBe('Extremely congested')
  })
})
