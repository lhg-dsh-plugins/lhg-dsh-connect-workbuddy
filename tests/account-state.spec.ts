/**
 * Folding one streamed test row into the document the panel renders.
 *
 * The batch is serial and streamed, so each account's measurement arrives while
 * the other accounts are still being tested. The panel has to show the row the
 * user is watching the moment that account's line lands — waiting for the batch
 * end is what made the button look dead for the duration of the slowest member.
 *
 * These cases pin the two decisions that makes that safe:
 *
 * 1. A row is matched to an account by ID, never guessed from a name two
 *    accounts might share.
 * 2. The exclusion is RE-DERIVED from the new measurement. Copying the previous
 *    one forward would leave an account that just measured `ok` red until the
 *    re-read — and, worse, one that just hit its limit green.
 */
import { describe, expect, it } from 'vitest'
import { testRowOf, withTestRow } from '../src/client/account-state.ts'
import type {
  WorkBuddyWebPoolAccount,
  WorkBuddyWebPoolTestRow,
  WorkBuddyWebUsage,
} from '../src/status-paths.ts'

/** A signed-in document carrying a pool block, which is what the panel reads. */
function usageWith(accounts: readonly WorkBuddyWebPoolAccount[]): WorkBuddyWebUsage {
  return {
    status: 'signed-in',
    region: 'cn',
    accountId: accounts[0]?.accountId ?? 'a-1',
    accountName: accounts[0]?.accountName ?? 'A One',
    tokenExpiresAtMs: 0,
    selectionExplicit: true,
    accounts: accounts.map(account => ({
      id: account.accountId,
      accountName: account.accountName,
      domain: 'workbuddy.cn',
      source: 'desktop' as const,
      tokenExpiresAtMs: 0,
      selected: account.current,
    })),
    models: [],
    enabledModelIds: [],
    imageModelIds: [],
    offModelIds: [],
    contextBudgets: {},
    credits: { total: 0, expiringSoon: 0, packages: [] },
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelSource: 'free',
      targetModelId: 'free-1',
      accounts,
    },
  }
}

function accountOf(accountId: string, overrides: Partial<WorkBuddyWebPoolAccount> = {}): WorkBuddyWebPoolAccount {
  return {
    accountId,
    accountName: `Name ${accountId}`,
    current: false,
    member: true,
    ...overrides,
  }
}

const NOW = 1_760_000_000_000

function testRow(accountId: string, result: WorkBuddyWebPoolTestRow['result']): WorkBuddyWebPoolTestRow {
  return { accountId, accountName: `Name ${accountId}`, result }
}

describe('testRowOf', () => {
  it('reads the row out of one line of the batch stream', () => {
    const row = testRowOf({
      row: {
        accountId: 'a-2',
        accountName: 'A Two',
        result: { modelId: 'free-1', outcome: 'rate-limited', retryAtMs: NOW + 60_000, status: 429 },
      },
    })
    expect(row).toEqual({
      accountId: 'a-2',
      accountName: 'A Two',
      result: { modelId: 'free-1', outcome: 'rate-limited', retryAtMs: NOW + 60_000, status: 429 },
    })
  })

  it('ignores the batch envelope and the closing line', () => {
    // `{ action, modelId }`, `{ done: true }` and `{ reason, error }` all share
    // the stream with the rows; folding one of them would invent a measurement.
    expect(testRowOf({ action: 'test', modelId: 'free-1' })).toBeUndefined()
    expect(testRowOf({ done: true })).toBeUndefined()
    expect(testRowOf({ reason: 'pool-failed', error: 'boom' })).toBeUndefined()
  })

  it('refuses a row that does not name the model it measured', () => {
    // Issue #61: an outcome without its model reads as account-level
    // availability, which is the false positive that started it.
    expect(testRowOf({ row: { accountId: 'a-1', result: { outcome: 'ok' } } })).toBeUndefined()
  })

  it('refuses an outcome this build does not know', () => {
    expect(testRowOf({ row: { accountId: 'a-1', result: { modelId: 'm', outcome: 'vibes' } } })).toBeUndefined()
    expect(testRowOf({ row: { accountId: '', result: { modelId: 'm', outcome: 'ok' } } })).toBeUndefined()
  })
})

describe('withTestRow', () => {
  it('writes the measurement onto the account the row names', () => {
    const usage = usageWith([accountOf('a-1'), accountOf('a-2')])
    const next = withTestRow(usage, testRow('a-2', { modelId: 'free-1', outcome: 'ok' }), NOW)
    if (!('pool' in next) || next.pool === undefined) throw new Error('pool went missing')
    const measured = next.pool.accounts[1]
    expect(measured?.probe).toEqual({
      outcome: 'ok',
      atMs: NOW,
      source: 'test-batch',
      modelId: 'free-1',
    })
    // The other account is untouched: a batch line measures ONE account.
    expect(next.pool.accounts[0]?.probe).toBeUndefined()
  })

  it('clears a stale exclusion when the fresh measurement says usable', () => {
    // The regression: reusing the old `excludedBy` keeps a just-measured-good
    // account red until the re-read, which is exactly the "still shows limited
    // after testing it" report.
    const usage = usageWith([
      accountOf('a-1', { excludedBy: 'rate-limited', probe: { outcome: 'rate-limited', atMs: NOW - 60_000 } }),
    ])
    const next = withTestRow(usage, testRow('a-1', { modelId: 'free-1', outcome: 'ok' }), NOW)
    if (!('pool' in next) || next.pool === undefined) throw new Error('pool went missing')
    expect(next.pool.accounts[0]?.excludedBy).toBeUndefined()
  })

  it('excludes an account the row measured as limited, and says when', () => {
    const usage = usageWith([accountOf('a-1')])
    const next = withTestRow(
      usage,
      testRow('a-1', { modelId: 'free-1', outcome: 'rate-limited', retryAtMs: NOW + 3_600_000 }),
      NOW,
    )
    if (!('pool' in next) || next.pool === undefined) throw new Error('pool went missing')
    expect(next.pool.accounts[0]?.excludedBy).toBe('rate-limited')
    expect(next.pool.accounts[0]?.probe?.retryAtMs).toBe(NOW + 3_600_000)
  })

  it('matches by id, and by name only when exactly one account carries it', () => {
    const usage = usageWith([
      accountOf('a-1', { accountName: 'Shared' }),
      accountOf('a-2', { accountName: 'Shared' }),
    ])
    // The id decides when it is listed, even if the name points elsewhere.
    const byId = withTestRow(usage, { accountId: 'a-2', accountName: 'Shared', result: { modelId: 'm', outcome: 'ok' } }, NOW)
    if (!('pool' in byId) || byId.pool === undefined) throw new Error('pool went missing')
    expect(byId.pool.accounts[1]?.probe?.outcome).toBe('ok')
    expect(byId.pool.accounts[0]?.probe).toBeUndefined()

    // An unknown id whose name two accounts share: writing it onto either would
    // be a guess, and a measurement filed under the wrong account is worse than
    // a row that waits for the re-read.
    const byName = withTestRow(usage, { accountId: 'gone', accountName: 'Shared', result: { modelId: 'm', outcome: 'ok' } }, NOW)
    expect(byName).toBe(usage)
  })

  it('leaves a document alone when it carries no pool at all', () => {
    // An older Host: the panel renders the credits table, and a test batch that
    // this document cannot describe must not invent a pool block.
    const usage = usageWith([accountOf('a-1')])
    const withoutPool: WorkBuddyWebUsage = { ...usage } as WorkBuddyWebUsage
    delete (withoutPool as { pool?: unknown }).pool
    expect(withTestRow(withoutPool, testRow('a-1', { modelId: 'm', outcome: 'ok' }), NOW)).toBe(withoutPool)
  })
})
