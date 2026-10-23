/**
 * Issue #120 follow-up: the picker printed the multiplier TWICE.
 *
 * `workBuddyDisplayName` builds the host-facing name as
 * `"<model> · x<multiplier>"` and the host renders it verbatim. The #120 fix
 * added a rate span beside that string, so the live picker read
 * `DeepSeek-V4.1-Flash · x0.11 · x0.11` for every model (reported with a
 * screenshot right after 5.6.0 shipped).
 *
 * The fix is not "stop drawing the rate" — the whole point of #120 is that the
 * number must track a running discount. It is to STRIP the suffix out of the
 * host's string and re-draw that single number in the span that can carry the
 * discounted value. These tests pin both halves: exactly one number, and it is
 * the discount when one runs.
 */
import { describe, expect, it } from 'vitest'
import { splitCatalogRate } from '../src/client/WorkBuddyModelLabel.tsx'

describe('the picker shows exactly one multiplier (issue #120 follow-up)', () => {
  it('strips the catalog suffix and keeps the same number', () => {
    expect(splitCatalogRate('DeepSeek-V4.1-Flash · x0.11', 0.11, undefined))
      .toEqual({ base: 'DeepSeek-V4.1-Flash', rate: 0.11 })
  })

  it('replaces it with the discounted rate while a discount runs', () => {
    // One number, and it is the discounted one — not `x0.11`, and not both.
    expect(splitCatalogRate('DeepSeek-V4.1-Flash · x0.11', 0.11, 0.06))
      .toEqual({ base: 'DeepSeek-V4.1-Flash', rate: 0.06 })
  })

  it('recognises the suffix by SHAPE, so a stale snapshot cannot restore the duplicate', () => {
    // The catalog figure changed between the snapshot and this render. Matching
    // against `baseRate` would leave the old suffix in place and print twice.
    expect(splitCatalogRate('SomeModel · x0.29', 0.11, undefined))
      .toEqual({ base: 'SomeModel', rate: 0.29 })
  })

  it('does not touch a name that carries no rate', () => {
    expect(splitCatalogRate('PlainModel', undefined, undefined))
      .toEqual({ base: 'PlainModel', rate: undefined })
  })

  it('draws the snapshot rate for a name without a suffix', () => {
    expect(splitCatalogRate('PlainModel', 0.79, undefined))
      .toEqual({ base: 'PlainModel', rate: 0.79 })
  })

  it('still draws a discount for a name without a suffix', () => {
    expect(splitCatalogRate('PlainModel', undefined, 0))
      .toEqual({ base: 'PlainModel', rate: 0 })
  })

  it('leaves a mid-name "x" alone', () => {
    // Only the TRAILING ` · x<number>` is this plugin's own token.
    expect(splitCatalogRate('Model x2 preview', undefined, undefined))
      .toEqual({ base: 'Model x2 preview', rate: undefined })
  })

  it('handles a free model (x0.00) without treating zero as "no rate"', () => {
    expect(splitCatalogRate('DeepSeek-V4.1-Flash · x0.00', 0, undefined))
      .toEqual({ base: 'DeepSeek-V4.1-Flash', rate: 0 })
  })
})
