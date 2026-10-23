/**
 * The vault directory holds MORE than credentials, and the scans must know it.
 *
 * `removeAccount` records a hide in `.dismissed.json`, stored beside the vault
 * entries. Both vault enumerations used a bare `endsWith('.json')` test, so this
 * bookkeeping file was admitted as a candidate CREDENTIAL — and because it is
 * well-formed JSON that is not a credential document, `diagnose` reported it at
 * the user:
 *
 *   searched: [{ path: '…/vault/.dismissed.json',
 *                source: 'dsh', reason: 'invalid',
 *                message: 'not a readable vault credential' }]
 *
 * Measured on a machine with NO accounts at all (the only case that renders the
 * path list): removing an account and reaching the signed-out state showed a
 * credential failure that did not exist. The sign-in was healthy; the plugin was
 * reading its own bookkeeping as a broken token file.
 *
 * The fix keys the filter on the ACCOUNT ID SHAPE the store itself writes
 * (`^[0-9a-f]{24}\.json$`) rather than on a naming convention, which also covers
 * the `<id>.json.<hex>.tmp` siblings an atomic write leaves behind.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { workBuddyWebStatus } from '../src/web-status.ts'

let root = ''
let authDir = ''
let vaultDir = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-vault-filter-'))
  authDir = join(root, 'auth')
  vaultDir = join(root, 'vault')
  await mkdir(authDir, { recursive: true })
  await mkdir(vaultDir, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function makeStore(): WorkBuddyCredentialStore {
  return new WorkBuddyCredentialStore({
    region: 'cn',
    authDirs: [authDir],
    vaultDir,
    refresh: async (credential: unknown) => credential,
  } as never)
}

/** The real on-disk shape `writeDismissed` produces. */
async function writeDismissedFile(accountIds: string[] = ['0123456789abcdef01234567']): Promise<string> {
  const path = join(vaultDir, '.dismissed.json')
  await writeFile(path, `${JSON.stringify({ version: 1, accountIds }, null, 2)}\n`, 'utf8')
  return path
}

function routeDeps(store: WorkBuddyCredentialStore): never {
  return {
    store: () => store,
    client: {
      fetchCredits: async () => ({ total: 10, packages: [], expiringSoon: 0, nearestExpiryMs: 0 }),
      fetchCheckinStatus: async () => ({ active: false, todayCheckedIn: false, streakDays: 0 }),
      claimDailyCheckin: async () => ({ claimed: false, alreadyCheckedIn: false }),
    },
    displayModels: () => [],
    enabledModelIds: () => [],
    imageModelIds: () => [],
    offModelIds: () => [],
    contextBudgets: () => ({}),
    regionEnabled: () => true,
  } as never
}

describe('the dismissal list is not a credential', () => {
  it('keeps it out of the diagnostics the signed-out card shows', async () => {
    // Exactly the reported state: no sign-ins at all, a hide on record.
    await writeDismissedFile()
    const { failures } = await makeStore().diagnose()
    expect(failures.map(failure => failure.path)).not.toContain(join(vaultDir, '.dismissed.json'))
    // The empty machine still EXPLAINS itself — dropping the real missing path
    // would be a different bug.
    expect(failures.map(failure => failure.reason)).toContain('missing')
  })

  it('does not turn the card\'s searched list into a credential failure', async () => {
    await writeDismissedFile()
    const usage = await workBuddyWebStatus(routeDeps(makeStore()), 'cn')
    const searched = (usage as { searched?: { path: string, reason: string }[] }).searched ?? []
    expect(searched.map(entry => entry.path)).not.toContain(join(vaultDir, '.dismissed.json'))
    expect(searched.map(entry => entry.reason)).not.toContain('invalid')
  })

  it('ignores an interrupted atomic-write sibling as well', async () => {
    // `<id>.json.<hex>.tmp` is left by a crash mid-write. It ends in `.tmp`, but
    // a filter written as "contains .json" would still admit it.
    await writeFile(join(vaultDir, '0123456789abcdef01234567.json.abc123.tmp'), '{ half', 'utf8')
    await writeDismissedFile()
    const { failures } = await makeStore().diagnose()
    expect(failures.filter(failure => failure.path.includes('.tmp'))).toEqual([])
    expect(failures.filter(failure => failure.path.includes('.dismissed.json'))).toEqual([])
  })

  it('still reads a REAL vault entry, so the filter is not over-broad', async () => {
    // The positive control: an account id shaped file must keep working, or the
    // filter would have quietly turned the vault into a read-nothing directory.
    // The name must be the id DERIVED from the credential (`uin` here), because
    // a vault file whose name disagrees with its own contents is rejected on
    // purpose — so this doubles as a check that the filter did not change which
    // ids are accepted.
    const id = createHash('sha256').update('workbuddy\0' + '100').digest('hex').slice(0, 24)
    await writeFile(join(vaultDir, `${id}.json`), JSON.stringify({
      version: 1,
      auth: {
        accessToken: 'tok',
        refreshToken: 'ref',
        expiresAt: Math.floor((Date.now() + 3_600_000) / 1000),
        domain: 'www.codebuddy.cn',
      },
      account: { uid: 'uid', uin: '100', nickname: 'VaultOnly' },
    }), 'utf8')
    const accounts = await makeStore().accounts()
    expect(accounts.map(account => account.accountName)).toEqual(['VaultOnly'])
  })
})
