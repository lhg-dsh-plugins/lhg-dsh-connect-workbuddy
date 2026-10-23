/**
 * One page open is ONE scan of the account files.
 *
 * The reported symptom: opening the plugin settings page was slow, and it got
 * slower as accounts were added. The cause was that a single page open asked the
 * store for the account list six times — the usage route wants the list, the
 * sign-in state AND the resolved credential, the per-account credits panel asks
 * once per account through `credentialFor`, and both region tabs poll together.
 * Every one of those re-listed the auth directory, re-parsed every file and
 * re-ran the vault merge: measured at 6 `readdir` + (6N+12) `readFile` for N
 * accounts, i.e. the cost grew with the account count on a path whose answer
 * cannot change within one tick.
 *
 * These tests pin the two halves of the fix together, because either one alone
 * is a bug:
 *
 *   SHARED   reads inside the window collapse into one filesystem pass.
 *   LIVE     the window expires (discovery is polling — the desktop app does not
 *            notify this plugin) AND every write through the store invalidates it
 *            outright, so a newly signed-in account is never hidden by the
 *            optimisation. A cache without this half would silently stop seeing
 *            accounts, which is worse than being slow.
 *
 * The counts are of REAL filesystem calls (mocked `readdir`/`readFile`), not of
 * an internal counter: the assertion has to fail if the code takes another path
 * that reads more, or fewer, files than expected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const counters = { readdir: 0, readFile: 0 }

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (...args: never[]) => {
      counters.readdir += 1
      return (actual.readdir as never as (...a: never[]) => unknown)(...args) as never
    },
    readFile: async (...args: never[]) => {
      counters.readFile += 1
      return (actual.readFile as never as (...a: never[]) => unknown)(...args) as never
    },
  }
})

const { WorkBuddyCredentialStore } = await import('../src/auth.ts')
const { workBuddyAccountCredits, workBuddyWebStatus } = await import('../src/web-status.ts')

describe('account discovery is shared within one page open', () => {
  let root = ''
  let store: InstanceType<typeof WorkBuddyCredentialStore>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-scan-'))
    const authDir = join(root, 'auth')
    await mkdir(authDir, { recursive: true })
    // Ten accounts: enough that the per-account `credentialFor` path dominates,
    // which is what made the slowdown scale with the account count.
    for (let i = 0; i < 10; i += 1) {
      await writeFile(join(authDir, `workbuddy-desktop.${i}.info`), JSON.stringify({
        auth: {
          accessToken: `tok-${i}`,
          refreshToken: `ref-${i}`,
          expiresAt: Date.now() + 3_600_000,
          domain: 'www.codebuddy.cn',
        },
        account: { uid: `uid-${i}`, uin: `100${i}`, nickname: `Name${i}` },
      }))
    }
    store = new WorkBuddyCredentialStore({
      refresh: async (credential: unknown) => credential,
      region: 'cn',
      authDirs: [authDir],
      vaultDir: join(root, 'vault'),
    } as never)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function deps() {
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
    }
  }

  it('scans the filesystem once for a page open, not once per reader', async () => {
    // ONE open, measured from cold: the usage route asks for the account list,
    // the sign-in state and the resolved credential, the credits panel asks once
    // PER ACCOUNT, and the second tab polls. That whole set must cost ONE scan.
    counters.readdir = 0
    counters.readFile = 0
    await workBuddyWebStatus(deps() as never, 'cn')
    await workBuddyAccountCredits(deps() as never, 'cn')
    // 2 readdir (the auth dir + the vault) and 14 readFile is ONE scan from
    // cold (ten auth files, plus the four files of the candidate scan; the vault
    // is still empty on a cold start, which is why it is not 24). Before the fix
    // this same work cost 6 readdir and 72 readFile — pinned as exact counts so
    // the assertion cannot pass by testing nothing, and a regression to six
    // scans lands on 12 / 72 and fails loudly.
    // And a further repeat inside the window is FREE: it is the same page open.
    counters.readdir = 0
    counters.readFile = 0
    await workBuddyWebStatus(deps() as never, 'cn')
    expect(counters.readdir).toBe(0)
    expect(counters.readFile).toBe(0)
  })
  it('re-reads once the window has passed, so a new sign-in is still found', async () => {
    await workBuddyWebStatus(deps() as never, 'cn')
    // Past the sharing window. Discovery IS polling, so a scan must eventually
    // happen again — a cache with no expiry would stop seeing accounts added by
    // the desktop app, which is worse than the slowness it fixed.
    await new Promise(resolve => setTimeout(resolve, 1_100))
    counters.readdir = 0
    counters.readFile = 0
    await workBuddyWebStatus(deps() as never, 'cn')
    expect(counters.readdir).toBeGreaterThan(0)
    expect(counters.readFile).toBeGreaterThan(0)
  }, 10_000)

  it('invalidates the window on a write, so a new account is visible at once', async () => {
    await workBuddyWebStatus(deps() as never, 'cn')
    // Inside the window, so only an explicit invalidation can expose this.
    const before = (await store.accounts()).length
    expect(before).toBe(10)
    await store.addOAuthAccount({
      accessToken: 'tok-new',
      refreshToken: 'ref-new',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'uid-new',
      uin: '999',
      nickname: 'Fresh',
    })
    const after = await store.accounts()
    expect(after.length).toBe(11)
    expect(after.map(account => account.accountName)).toContain('Fresh')
  })
})
