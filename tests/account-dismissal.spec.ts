/**
 * Removing a DESKTOP-SCANNED account, and getting it back.
 *
 * The reported defect: an account discovered from the WorkBuddy desktop app
 * could not be removed — the row came back. `removeAccount` deleted the vault
 * entry and reported `true`, but the account is also a DESKTOP sign-in, and
 * `readAll` merges desktop scans INTO the vault (`syncVault` writes back every
 * desktop account it finds) before returning the list. So the next read
 * recreated the file that had just been deleted.
 *
 * The intended semantics, pinned here:
 *
 *   REMOVE hides      the account disappears from the list and STAYS gone
 *                     through the automatic poll, which is what made the
 *                     button look broken before (a hidden desktop account must
 *                     not pop back a minute later).
 *   RESCAN restores   the manual 「Detect accounts again」 action is the user
 *                     asking what this machine currently has, so it clears the
 *                     hides and the accounts return. Without that, a removed
 *                     desktop account would be unrecoverable from the UI.
 *   APP untouched     the desktop app is never signed out — only this plugin
 *                     stops listing the account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyCredentialStore } from '../src/auth.ts'

describe('removing a desktop-scanned account', () => {
  let root = ''
  let authDir = ''
  let vaultDir = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-dismiss-'))
    authDir = join(root, 'auth')
    vaultDir = join(root, 'vault')
    await mkdir(authDir, { recursive: true })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  /** A desktop auth file; `suffix` keeps several of them side by side. */
  async function writeDesktop(uid: string, nickname: string, suffix = ''): Promise<string> {
    const path = join(authDir, `workbuddy-desktop${suffix}.info`)
    await writeFile(path, JSON.stringify({
      auth: {
        accessToken: `tok-${uid}`,
        refreshToken: `ref-${uid}`,
        expiresAt: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
      },
      account: { uid, uin: `100${uid}`, nickname },
    }))
    return path
  }

  function store(): WorkBuddyCredentialStore {
    return new WorkBuddyCredentialStore({
      refresh: async (credential: unknown) => credential,
      region: 'cn',
      authDirs: [authDir],
      vaultDir,
    } as never)
  }

  it('hides it through the next scan instead of bringing it back', async () => {
    const desktopPath = await writeDesktop('A', 'Alpha')
    const first = store()
    const before = await first.accounts()
    expect(before.map(account => account.accountName)).toEqual(['Alpha'])
    // The desktop account IS in the vault by now — `syncVault` put it there,
    // which is what made the removal look like it had worked.
    expect(await first.removeAccount(before[0]!.id)).toBe(true)
    expect(await first.accounts()).toEqual([])
    // The automatic poll reads through a fresh store instance repeatedly; the
    // account must stay hidden for every one of those reads.
    expect(await store().accounts()).toEqual([])
    expect(await store().accounts()).toEqual([])
    // The desktop file is untouched: the plugin hid the account, it did not
    // sign the app out.
    expect(JSON.parse(await readFile(desktopPath, 'utf8')).account.nickname).toBe('Alpha')
  })

  it('brings it back on the next manual scan', async () => {
    await writeDesktop('B', 'Beta')
    const first = store()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)
    expect(await first.accounts()).toEqual([])
    // 「Detect accounts again」: the accounts the machine currently has return.
    await store().clearDismissals()
    expect((await store().accounts()).map(a => a.accountName)).toEqual(['Beta'])
  })

  it('restores every hidden account, not just one', async () => {
    await writeDesktop('C', 'Gamma')
    await writeDesktop('D', 'Delta', '.1')
    const first = store()
    const before = await first.accounts()
    expect(before.length).toBe(2)
    for (const account of before) await first.removeAccount(account.id)
    expect(await first.accounts()).toEqual([])
    await store().clearDismissals()
    expect((await store().accounts()).map(a => a.accountName).sort()).toEqual(['Delta', 'Gamma'])
  })

  it('remembers the hide across a fresh store instance', async () => {
    await writeDesktop('E', 'Epsilon')
    const first = store()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)
    // The hide is on DISK, not in memory: a restart (or the next poll through a
    // new instance) must not resurrect it.
    expect(JSON.parse(await readFile(join(vaultDir, '.dismissed.json'), 'utf8')).accountIds)
      .toEqual([account!.id])
    expect(await store().accounts()).toEqual([])
  })

  it('signing in again clears the hide for that account', async () => {
    await writeDesktop('F', 'Zeta')
    const first = store()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)
    expect(await first.accounts()).toEqual([])
    // An OAuth sign-in (or an import) for the same account must bring it back
    // without waiting for a manual scan.
    await first.addOAuthAccount({
      accessToken: 'tok-oauth',
      refreshToken: 'ref-oauth',
      expiresAtMs: Date.now() + 3_600_000,
      domain: 'www.codebuddy.cn',
      uid: 'F',
      uin: '100F',
      nickname: 'Zeta',
    })
    expect((await first.accounts()).map(a => a.accountName)).toEqual(['Zeta'])
  })

  it('hides a desktop-only account that has no vault entry of its own', async () => {
    // Nothing plugin-stored exists to delete, yet the user's request must still
    // be honoured: `removed: false` describes the vault, not the outcome.
    await writeDesktop('G', 'Eta')
    const first = store()
    const [account] = await first.accounts()
    await rm(join(vaultDir, `${account!.id}.json`), { force: true })
    expect(await first.removeAccount(account!.id)).toBe(false)
    expect(await first.accounts()).toEqual([])
  })

  it('leaves other accounts alone', async () => {
    await writeDesktop('H', 'Theta')
    await writeDesktop('I', 'Iota', '.1')
    const first = store()
    const before = await first.accounts()
    expect(before.length).toBe(2)
    const target = before.find(account => account.accountName === 'Theta')!
    await first.removeAccount(target.id)
    expect((await first.accounts()).map(a => a.accountName)).toEqual(['Iota'])
  })
})
