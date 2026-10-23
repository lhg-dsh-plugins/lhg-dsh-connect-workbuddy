import { describe, expect, it } from 'vitest'
import { applyManualOrder, readOrderAccountIds } from '../src/client/manual-order.ts'

/**
 * The manual order must mean the SAME thing on every surface that lists member
 * accounts. It used to mean two things: the pool card sorted by it while the
 * composer credits panel showed the Host's raw order, so the user sorted the
 * pool, opened the credit panel, and was shown a different sequence. These
 * tests pin the contract both surfaces now share.
 */

const account = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra })

describe('readOrderAccountIds', () => {
  it('reads the saved order for the requested region', () => {
    const value = { regions: { cn: { pool: { orderAccountIds: ['b', 'a'] } } } }
    expect(readOrderAccountIds(value, 'cn')).toEqual(['b', 'a'])
  })

  it('keeps the two regions independent', () => {
    // Sorting the domestic pool must never reorder the international panel.
    const value = {
      regions: {
        cn: { pool: { orderAccountIds: ['cn-2', 'cn-1'] } },
        global: { pool: { orderAccountIds: ['g-1'] } },
      },
    }
    expect(readOrderAccountIds(value, 'global')).toEqual(['g-1'])
  })

  it.each([
    ['no snapshot', undefined, 'cn'],
    ['region unknown', { regions: {} }, 'cn'],
    ['no pool in the slot', { regions: { cn: {} } }, 'cn'],
    ['pool without the field', { regions: { cn: { pool: {} } } }, 'cn'],
    ['field is not an array', { regions: { cn: { pool: { orderAccountIds: 'a,b' } } } }, 'cn'],
    ['regions not an object', { regions: 7 }, 'cn'],
    ['no active region', { regions: { cn: { pool: { orderAccountIds: ['a'] } } } }, undefined],
  ])('degrades to "no manual order" on %s', (_label, value, region) => {
    // Every one of these is a real older-profile shape. Returning a non-empty
    // order here would silently reorder accounts the user never sorted.
    expect(readOrderAccountIds(value, region as string | undefined)).toEqual([])
  })

  it('drops non-string entries instead of trusting stored JSON', () => {
    const value = { regions: { cn: { pool: { orderAccountIds: ['a', 7, null, 'b'] } } } }
    expect(readOrderAccountIds(value, 'cn')).toEqual(['a', 'b'])
  })

  it('finds the order of a region whose slot only survives one level down (restart reset)', () => {
    // The measured corrupt field: the card's save happened to leave `cn` at the
    // surface, while the international slot — and its saved sort — remained only
    // in the buried copy. A direct `value.regions[region]` lookup answered "no
    // manual order" for `global`, so the credit panel silently reverted to the
    // Host's order for accounts the user had sorted.
    const value = {
      regions: {
        accounts: { enabled: true },
        regions: { global: { pool: { orderAccountIds: ['g-2', 'g-1'] } } },
        cliBridge: { enabled: false },
        cn: { pool: { orderAccountIds: ['cn-1'] } },
      },
    }
    expect(readOrderAccountIds(value, 'global')).toEqual(['g-2', 'g-1'])
    expect(readOrderAccountIds(value, 'cn')).toEqual(['cn-1'])
    // Asked for a field instead of the section, the same answer comes back —
    // the helper tolerates both shapes, as the card's write bases do.
    expect(readOrderAccountIds(value.regions, 'global')).toEqual(['g-2', 'g-1'])
  })
})

describe('applyManualOrder', () => {
  const rows = [account('a'), account('b'), account('c')]

  it('follows the saved order', () => {
    expect(applyManualOrder(rows, ['c', 'a', 'b']).map(r => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('places accounts the order never mentions AFTER the ordered ones', () => {
    // Unlisted must not be dropped, and must not jump ahead of a real choice.
    expect(applyManualOrder(rows, ['b']).map(r => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('keeps the original sequence among unlisted accounts', () => {
    // Their relative order is the only signal available; inventing one would
    // make the list jump around between refreshes.
    const many = ['a', 'b', 'c', 'd', 'e'].map(id => account(id))
    expect(applyManualOrder(many, ['d']).map(r => r.id)).toEqual(['d', 'a', 'b', 'c', 'e'])
  })

  it('ignores ids that no longer name an account', () => {
    // A member can leave the pool while the order still mentions it. That must
    // not hide the accounts that remain.
    expect(applyManualOrder(rows, ['gone', 'c']).map(r => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('treats an empty order as "leave the list alone"', () => {
    expect(applyManualOrder(rows, []).map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input array', () => {
    // The caller usually passes a state value; reordering it in place would
    // change identity behind React's back.
    const input = [account('a'), account('b')]
    const snapshot = [...input]
    const result = applyManualOrder(input, ['b', 'a'])
    expect(input).toEqual(snapshot)
    expect(result).not.toBe(input)
  })

  it('is stable when the same id is listed twice', () => {
    expect(applyManualOrder(rows, ['c', 'c', 'a']).map(r => r.id)).toEqual(['c', 'a', 'b'])
  })
})
