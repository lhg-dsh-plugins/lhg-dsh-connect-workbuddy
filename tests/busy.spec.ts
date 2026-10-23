/**
 * Model load ("繁忙程度"): how the probe's answer is read, batched and worded.
 *
 * The fixtures are the upstream's REAL answer, measured 2026-10-21 on the CN
 * gateway (`POST /v2/chat/busy`, HTTP 200, identical on all three CN hosts and
 * under both client identities). The levels are the app's own enum, so the
 * assertions below pin the two things a rendering layer can get wrong:
 *
 *   1. an unusable answer must become `unknown`, never `normal` — "we were told
 *      nothing" and "everything is fine" are different claims;
 *   2. the healthy default must draw NOTHING, or every row of the picker grows a
 *      badge that says nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  attachBusyLevels,
  batchModelIds,
  busyDisplaySuffix,
  busyLabel,
  normalizeBusyLevel,
  parseBusyLevels,
  WORKBUDDY_BUSY_BATCH_SIZE,
} from '../src/busy.ts'
import type { WorkBuddyBusyLevel } from '../src/busy.ts'

/** One catalog entry, as the refresh hands it over (level not yet stamped). */
type Entry = { id: string; name: string; busyLevel?: WorkBuddyBusyLevel }

/** The observed CN answer, unchanged. */
const liveAnswer = [
  { model: 'hy3', busy_level: 'busy' },
  { model: 'deepseek-v4.1-flash', busy_level: 'congested' },
  { model: 'glm-5.3', busy_level: 'busy' },
  { model: 'kimi-k2.8-preview', busy_level: 'normal' },
  { model: 'hy4-preview', busy_level: 'congested' },
]

describe('parseBusyLevels', () => {
  it('reads the live answer into a model-id map', () => {
    const levels = parseBusyLevels(liveAnswer)
    expect(levels.get('hy3')).toBe('busy')
    expect(levels.get('deepseek-v4.1-flash')).toBe('congested')
    expect(levels.get('kimi-k2.8-preview')).toBe('normal')
    expect(levels.size).toBe(5)
  })

  it('turns a level outside the enum into unknown, not into normal', () => {
    expect(parseBusyLevels([{ model: 'x', busy_level: 'overloaded' }]).get('x')).toBe('unknown')
    expect(parseBusyLevels([{ model: 'x' }]).get('x')).toBe('unknown')
    expect(parseBusyLevels([{ model: 'x', busy_level: 3 }]).get('x')).toBe('unknown')
  })

  it('skips entries that name no model, and non-arrays', () => {
    expect(parseBusyLevels([{ busy_level: 'busy' }, null, 'hy3']).size).toBe(0)
    expect(parseBusyLevels(undefined).size).toBe(0)
    expect(parseBusyLevels({ data: liveAnswer }).size).toBe(0)
  })

  it('accepts every level the app declares', () => {
    for (const level of ['idle', 'normal', 'busy', 'congested', 'unavailable', 'unknown']) {
      expect(normalizeBusyLevel(level)).toBe(level)
    }
  })
})

describe('batchModelIds', () => {
  it('splits at the upstream ceiling of 50 ids per call', () => {
    const ids = Array.from({ length: 62 }, (_, index) => `m${index}`)
    const batches = batchModelIds(ids)
    expect(batches.map(batch => batch.length)).toEqual([WORKBUDDY_BUSY_BATCH_SIZE, 12])
    expect(batches[1]?.[11]).toBe('m61')
  })

  it('de-duplicates, because the roster carries kept ids alongside the upstream one', () => {
    expect(batchModelIds(['hy3', 'hy3', 'glm-5.3', ''])).toEqual([['hy3', 'glm-5.3']])
  })

  it('answers nothing for an empty roster', () => {
    expect(batchModelIds([])).toEqual([])
  })
})

describe('busyLabel / busyDisplaySuffix', () => {
  it('uses the app’s own words', () => {
    expect(busyLabel('idle')).toBe('空闲')
    expect(busyLabel('busy')).toBe('轻微拥堵')
    expect(busyLabel('congested')).toBe('极度拥堵')
    expect(busyLabel('unavailable')).toBe('不可用')
    expect(busyLabel('congested', 'en')).toBe('Extremely congested')
  })

  it('draws the healthy default as ONE person, and nothing for an unknown level', () => {
    // `normal` is drawn — one person is the healthy case and the row should
    // say so. `unknown` (the plugin's own "the probe did not answer") must
    // never become a claim.
    expect(busyDisplaySuffix('normal')).toBe(' 🧍')
    expect(busyDisplaySuffix('unknown')).toBe('')
  })

  it('draws nothing for a level that is not worth drawing', () => {
    // The WORD for `normal` is still undefined — it is the healthy case, and a
    // word that says "正常" on every row is noise. The ICON for it is one
    // person, which is the same information in a form that does not shout.
    expect(busyLabel('normal')).toBeUndefined()
    expect(busyLabel('unknown')).toBeUndefined()
    expect(busyDisplaySuffix('unknown')).toBe('')
    expect(busyDisplaySuffix(undefined)).toBe('')
  })

  it('draws an IDLE model as a ROCKET', () => {
    // The word exists (the app's detail panel uses it) and the mark exists too:
    // a rocket says "nobody is queuing, full speed", which is a different
    // SHAPE from one person waiting — the two must not be confused at 12px.
    expect(busyLabel('idle')).toBe('空闲')
    expect(busyDisplaySuffix('idle')).toBe(' 🚀')
  })

  it('puts the load to the RIGHT of the name, as ONE character', () => {
    // The DSH model picker renders the model name verbatim, as a plain string:
    // no image slot, no markup. So the level in THAT place can only be a
    // character — the word made the row read as a sentence, and the picker's
    // rows are narrow. The card, which renders itself, uses the SVG icons
    // instead (`src/client/busy-icon.tsx`).
    // ONE person shape, repeated: the COUNT says how congested it is.
    expect(busyDisplaySuffix('congested')).toBe(' 🧍🧍🧍')
    expect(busyDisplaySuffix('busy')).toBe(' 🧍🧍')
    expect(busyDisplaySuffix('unavailable')).toBe(' 🚫')
    // The locale argument no longer changes the picker's mark: there is no
    // word left in it. It stays in the signature because the card still asks
    // `busyLabel` for its tooltip.
    expect(busyDisplaySuffix('busy', 'en')).toBe(' 🧍🧍')
  })

  it('keeps the WORD available for the card, which can render a tooltip', () => {
    // The word is not gone — it moved. The card asks `busyLabel` and puts it in
    // the icon's `title`, so the level is still readable on hover.
    expect(busyLabel('congested')).toBe('极度拥堵')
    expect(busyLabel('congested', 'en')).toBe('Extremely congested')
  })
})

describe('attachBusyLevels', () => {
  it('stamps the level onto the matching entry only', () => {
    const models: Entry[] = [{ id: 'hy3', name: 'Hy3' }, { id: 'glm-5.3', name: 'GLM-5.3' }]
    const stamped = attachBusyLevels(models, new Map([['hy3', 'congested']]))
    expect(stamped[0]?.busyLevel).toBe('congested')
    expect(stamped[1]?.busyLevel).toBeUndefined()
  })

  it('leaves a model the probe did not answer for UNTOUCHED (same reference)', () => {
    const model: Entry = { id: 'hy3', name: 'Hy3' }
    const stamped = attachBusyLevels([model], new Map())
    expect(stamped[0]).toBe(model)
  })

  it('never mutates the catalog entry it was handed', () => {
    const model: Entry = { id: 'hy3', name: 'Hy3' }
    attachBusyLevels([model], new Map([['hy3', 'busy']]))
    expect('busyLevel' in model).toBe(false)
  })
})
