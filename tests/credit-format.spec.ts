/**
 * The credit display rule: whole credits, grouped, FLOORED.
 *
 * Why this is a test and not a style preference: `4.4.5` made the balance exact
 * (`2,196.61` where it used to be a whole number), so the display has to choose
 * what to do with the fraction — and rounding UP would print `2,197` for a
 * balance the official client shows as `2,196.61`, making a card that had just
 * been reconciled against the client look one credit off. That is the whole
 * complaint behind issue #58, so the truncation is load-bearing.
 */
import { describe, expect, it } from 'vitest'
import { formatCredits } from '../src/client/credit-format.ts'

describe('formatCredits', () => {
  it('floors a precise balance instead of rounding it up', () => {
    // The live figure from the account that settled issue #58. Rounding would
    // print 2,197; the client shows 2,196.61, whose integer part is 2,196.
    expect(formatCredits(2196.61)).toBe('2,196')
  })

  it('never claims a credit the account does not have', () => {
    // 0.61 is not a spendable whole credit. Rounding prints "1" and tells the
    // reader they can spend something they cannot.
    expect(formatCredits(0.61)).toBe('0')
    expect(formatCredits(0)).toBe('0')
  })

  it('leaves whole credits exactly as they were before the exact balance', () => {
    // The display must not have changed for every pre-existing value: these are
    // the readings that were on screen before this release.
    expect(formatCredits(1875)).toBe('1,875')
    expect(formatCredits(500)).toBe('500')
    expect(formatCredits(1072)).toBe('1,072')
  })

  it('keeps the thousands separator, which is why this is not a bare floor', () => {
    expect(formatCredits(12_345.99)).toBe('12,345')
  })

  it('floors a small fraction down rather than to the nearest integer', () => {
    expect(formatCredits(96.61000218)).toBe('96')
    expect(formatCredits(3.99)).toBe('3')
  })
})
