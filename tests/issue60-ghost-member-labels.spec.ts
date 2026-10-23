import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mergePoolProbe, readPoolProbes, writePoolProbes } from '../src/account-pool-store.ts'
import { probeUpdatesOf } from '../src/account-pool-run.ts'
import { ghostMemberIds, ghostMembers, ghostNameList } from '../src/client/pool-state.ts'

/**
 * Issue #60: the pool's "no longer signed in" warning was a COUNT with no
 * subject — "1 saved account is no longer signed in" — and the ids it referred
 * to had no row anywhere in the card, because the table renders local sign-ins
 * and a ghost is exactly the member that has none. The user could see that
 * something was wrong and could do nothing about it.
 *
 * The fix has two halves, and both are pinned here: the measurement record now
 * carries the name it saw (so a later ghost CAN be named), and the card renders
 * one removable entry per ghost instead of a bare count.
 */

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-ghost-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(home, { force: true, recursive: true })
})

describe('ghostMembers', () => {
  const listed = new Set(['live-1'])

  it('still finds exactly the saved ids with no sign-in', () => {
    // The primitive is unchanged; #60 is about what the card does with it.
    expect(ghostMemberIds(['live-1', 'gone-1', 'gone-2'], listed)).toEqual(['gone-1', 'gone-2'])
  })

  it('names a ghost from the last measurement that saw it', () => {
    const ghosts = ghostMembers(['live-1', 'gone-1'], listed, { 'gone-1': '账号甲' })
    expect(ghosts).toEqual([{ id: 'gone-1', label: '账号甲', named: true }])
  })

  it('falls back to an id prefix when no name was ever measured', () => {
    // An honest label beats a blank: the prefix still tells two ghosts apart,
    // whereas an invented one (a position, an index) would point the user at
    // the wrong account to remove.
    const ghosts = ghostMembers(['e44e62b3-1111-2222'], new Set<string>(), {})
    expect(ghosts[0]?.label).toBe('e44e62b3…')
    expect(ghosts[0]?.named).toBe(false)
  })

  it('treats an empty measured name as no name', () => {
    // The desktop app records `accountName: ''` for accounts it cannot name,
    // and an empty chip would render as a gap the user cannot read.
    const ghosts = ghostMembers(['abcdefgh-1'], new Set<string>(), { 'abcdefgh-1': '' })
    expect(ghosts[0]?.label).toBe('abcdefgh…')
    expect(ghosts[0]?.named).toBe(false)
  })

  it('keeps the saved order so the list does not reshuffle between polls', () => {
    const ghosts = ghostMembers(['b-2', 'a-1'], new Set<string>(), {})
    expect(ghosts.map(ghost => ghost.id)).toEqual(['b-2', 'a-1'])
  })

  it('returns nothing for a pool whose members all resolve', () => {
    expect(ghostMembers(['live-1'], listed, {})).toEqual([])
  })
})

describe('ghostNameList', () => {
  it('joins up to three names into one sentence fragment', () => {
    const ghosts = ghostMembers(['a', 'b'], new Set<string>(), { a: '甲', b: '乙' })
    expect(ghostNameList(ghosts)).toBe('甲、乙')
  })

  it('truncates beyond three rather than wrapping the warning into a paragraph', () => {
    const ghosts = ghostMembers(['a', 'b', 'c', 'd'], new Set<string>(), { a: '甲', b: '乙', c: '丙', d: '丁' })
    // The removable list underneath carries the full set, so truncating here
    // cannot hide a member from the user.
    expect(ghostNameList(ghosts)).toBe('甲、乙、丙…')
  })
})

describe('mergePoolProbe', () => {
  const measured = { outcome: 'rate-limited' as const, atMs: 1_000, accountName: '账号甲' }

  it('inherits the name when the update carries none', () => {
    // The live-failure writer runs on the request path and cannot always name
    // the account. Losing the name there would erase the ONLY way to identify
    // a member whose sign-in later disappears.
    const merged = mergePoolProbe(measured, { outcome: 'out-of-credit', atMs: 2_000, source: 'live-request' })
    expect(merged.accountName).toBe('账号甲')
    expect(merged.outcome).toBe('out-of-credit')
  })

  it('lets a newer measurement replace the name', () => {
    const merged = mergePoolProbe(measured, { outcome: 'ok', atMs: 2_000, accountName: '账号甲（改）' })
    expect(merged.accountName).toBe('账号甲（改）')
  })

  it('keeps recording the name while still inheriting a future retry time', () => {
    // Both inherited fields must survive together: they are set by different
    // writers on different paths.
    const existing = { outcome: 'rate-limited' as const, atMs: 1_000, retryAtMs: 9_000, accountName: '账号甲' }
    const merged = mergePoolProbe(existing, { outcome: 'rate-limited', atMs: 2_000 })
    expect(merged).toMatchObject({ accountName: '账号甲', retryAtMs: 9_000 })
  })
})

describe('probeUpdatesOf', () => {
  it('records the account name with the measurement', () => {
    const updates = probeUpdatesOf([{
      accountId: 'id-1',
      accountName: '账号甲',
      result: { modelId: 'm', outcome: 'ok', status: 200 },
    }])
    expect(updates['id-1']?.accountName).toBe('账号甲')
  })

  it('omits an empty name rather than storing a blank', () => {
    const updates = probeUpdatesOf([{
      accountId: 'id-1',
      accountName: '',
      result: { modelId: 'm', outcome: 'ok', status: 200 },
    }])
    expect(updates['id-1']).not.toHaveProperty('accountName')
  })
})

describe('the store keeps the name across a round trip', () => {
  it('persists and reads it back', async () => {
    await writePoolProbes('global', {
      'gone-1': { outcome: 'rate-limited', atMs: 5, accountName: '账号甲' },
    })
    const probes = await readPoolProbes('global')
    expect(probes['gone-1']?.accountName).toBe('账号甲')
  })
})
