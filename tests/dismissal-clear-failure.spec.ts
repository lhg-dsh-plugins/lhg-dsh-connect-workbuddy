/**
 * 「Detect accounts again」 must actually bring the accounts back — and SAY SO
 * when it cannot.
 *
 * Dismissal is stored in `.dismissed.json`, and the manual rescan's promise is
 * that it clears them (the row-removal copy tells the user exactly that:
 * 「点重新检测账号即可找回」). `clearDismissals` used to express that promise as a
 * bare `rm(..., { force: true })` inside a swallowing `catch` — and `force`
 * only ignores ENOENT, not a refusal.
 *
 * On POSIX that is invisible: `unlink` succeeds on a file another process holds
 * open. On Windows it commonly fails with `EPERM`/`EBUSY`/`EACCES` (antivirus,
 * OneDrive, an editor — the contention `docs/WINDOWS.md` keeps a register for
 * and `isFileContentionWriteError` classifies for profile writes). The measured
 * outcome was the worst shape a promise can break in: the account did NOT come
 * back, the interface reported NOTHING, and the button looked like it worked.
 *
 * These tests simulate exactly that refusal and pin the two things that must
 * hold afterwards:
 *   WORKS      the fallback rewrite still clears the hides, so the user's ask
 *              is honoured even when the file cannot be deleted.
 *   HONEST     if BOTH routes fail, the store returns false — the value the
 *              route forwards and the card renders — instead of a silent
 *              success. A `true` here would be a lie the user cannot see.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Refuse to remove the dismissal file, the way Windows refuses a locked one.
 *
 * `force: true` is passed by the caller, so this reproduces the exact case the
 * old code could not survive: EPERM despite `force`.
 */
function lockDismissalFile(): { confinedError: () => NodeJS.ErrnoException } {
  const make = (): NodeJS.ErrnoException => {
    const error = new Error('EPERM: operation not permitted, unlink') as NodeJS.ErrnoException
    error.code = 'EPERM'
    return error
  }
  return { confinedError: make }
}

const realFsPromises = await import('node:fs/promises')

let root = ''
let authDir = ''
let vaultDir = ''
/**
 * Which refusals the simulated Windows lock produces.
 *
 *   none                   ordinary machine: the unlink succeeds.
 *   unlink-only            the delete is refused, the atomic REPLACE still
 *                          lands — the case the rewrite fallback exists for.
 *   both                   every ACCESS to the file fails, reads included, so
 *                          `readDismissed` answers "nothing hidden" and the
 *                          hide cannot be applied either.
 *   write-blocked-read-ok  the delete and the rewrite are refused while the
 *                          EXISTING list still reads: the hide remains in
 *                          force, which is the only case the card's error line
 *                          should ever describe.
 */
let refusal: 'unlink-only' | 'both' | 'write-blocked-read-ok' | 'none' = 'none'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const eperm = (path: string): NodeJS.ErrnoException => {
    const error = new Error(
      `EPERM: operation not permitted, unlink '${path}'`,
    ) as NodeJS.ErrnoException
    error.code = 'EPERM'
    return error
  }
  const ebusy = (path: string): NodeJS.ErrnoException => {
    const error = new Error(
      `EBUSY: resource busy or locked, open '${path}'`,
    ) as NodeJS.ErrnoException
    error.code = 'EBUSY'
    return error
  }
  return {
    ...actual,
    rm: async (target: never, options: never) => {
      const path = String(target)
      if (path.endsWith('.dismissed.json') && refusal !== 'none') throw eperm(path)
      return (actual.rm as never as (...args: never[]) => unknown)(target, options) as never
    },
    readFile: async (target: never, ...rest: never[]) => {
      const path = String(target)
      // A held-open handle that denies sharing blocks reads as well as deletes;
      // `write-blocked-read-ok` is the deliberate exception.
      if (path.endsWith('.dismissed.json') && refusal === 'both') throw ebusy(path)
      return (actual.readFile as never as (...args: never[]) => unknown)(target, ...rest) as never
    },
  }
})

/**
 * The rewrite half of the refusal.
 *
 * `writeDismissed` reaches the filesystem through `writeFileAtomic`, which lives
 * in an EXTERNAL package — so its internal `node:fs/promises` calls are not
 * intercepted by the mock above (vitest does not transform `node_modules` by
 * default). Mocking the module the store actually imports is what makes the
 * "both routes refused" case reproducible; mocking `fs` alone silently let the
 * rewrite succeed and the test proved nothing.
 */
vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: async (filename: never, content: never, options: never) => {
      // Every mode except `none` and `unlink-only` also refuses the REPLACE —
      // `unlink-only` is precisely the case where the rewrite is expected to
      // succeed.
      if ((refusal === 'both' || refusal === 'write-blocked-read-ok')
        && String(filename).includes('.dismissed.json')) {
        const error = new Error(
          `EPERM: operation not permitted, open '${String(filename)}'`,
        ) as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return (actual.writeFileAtomic as never as (...args: never[]) => unknown)(
        filename, content, options,
      ) as never
    },
  }
})

const { WorkBuddyCredentialStore } = await import('../src/auth.ts')

beforeEach(async () => {
  refusal = 'none'
  root = await mkdtemp(join(tmpdir(), 'wb-windows-'))
  authDir = join(root, 'auth')
  vaultDir = join(root, 'vault')
  await mkdir(authDir, { recursive: true })
  await writeFile(join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: {
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Date.now() + 3_600_000,
      domain: 'www.codebuddy.cn',
    },
    account: { uid: 'W1', uin: '9001', nickname: 'WindowsAccount' },
  }), 'utf8')
})
afterEach(async () => { refusal = 'none'; await rm(root, { recursive: true, force: true }) })

function makeStore(): InstanceType<typeof WorkBuddyCredentialStore> {
  return new WorkBuddyCredentialStore({
    region: 'cn',
    authDirs: [authDir],
    vaultDir,
    refresh: async (credential: unknown) => credential,
  } as never)
}

describe('a manual rescan with the dismissal file locked', () => {
  it('still brings the accounts back, through the rewrite fallback', async () => {
    // The realistic Windows shape: the file can be UNLINKED against only when
    // nothing holds it, but a scanner holding it usually blocks the delete while
    // leaving the atomic REPLACE (create temp + rename) able to land — which is
    // why the fallback is a rewrite and not a second unlink attempt.
    const first = makeStore()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)
    expect(await makeStore().accounts()).toEqual([])

    refusal = 'unlink-only'
    const cleared = await makeStore().clearDismissals()
    expect(cleared).toBe(true)
    expect((await makeStore().accounts()).map(a => a.accountName)).toEqual(['WindowsAccount'])
  })

  /**
   * The FULLY locked case: `readFile` fails too, so `readDismissed` answers
   * 「nothing is hidden」 — the same rule every reader uses (an unreadable list
   * must never take account discovery down; see `readDismissed`). Two
   * consequences, both asserted here rather than reasoned about:
   *
   *   the ACCOUNT comes back anyway, because a hide that cannot be read cannot
   *   be applied either — so the user still gets what the button promised; and
   *   the return value is `true` on that path, which is the HONEST answer and
   *   not the lie it looks like. It means 「no hides are in force」, which is
   *   exactly what the accounts() call beside it then shows.
   *
   * This test exists because the opposite looks plausible on inspection: a
   * locked file sounds like it should report failure. It does not, and the two
   * assertions below are what stop a later reader from "fixing" the return value
   * into a `false` that would contradict the list the user is looking at.
   */
  it('is honest when the file cannot even be read: report matches the list', async () => {
    const first = makeStore()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)

    refusal = 'both'
    const cleared = await makeStore().clearDismissals()
    const visible = (await makeStore().accounts()).map(a => a.accountName)
    // Whatever it reports, it must AGREE with what the user is shown. Pinning
    // the pair, not one of them, is the point.
    expect(cleared).toBe(visible.length > 0)
    expect(visible).toEqual(['WindowsAccount'])
  })

  it('reports false when the rewrite cannot land but the old list still reads', async () => {
    const first = makeStore()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)

    // Unlink and rewrite both refused, but the EXISTING list is still readable —
    // so the hide IS still in force and `false` is the truthful answer. This is
    // the case the card's error line exists for.
    refusal = 'write-blocked-read-ok'
    const cleared = await makeStore().clearDismissals()
    // The honest answer, and the one the route forwards to the card. Returning
    // nothing here is what made the button look like it had worked.
    expect(cleared).toBe(false)
    // And nothing was corrupted by the attempt: the hide is still recorded, so
    // the account stays consistently hidden rather than half-restored.
    expect(await makeStore().accounts()).toEqual([])
    const raw = JSON.parse(await readFile(join(vaultDir, '.dismissed.json'), 'utf8')) as { accountIds: string[] }
    expect(raw.accountIds).toEqual([account!.id])
  })

  it('verifies the outcome instead of trusting the write', async () => {
    // Sanity on the ordinary path: no refusal, so the unlink works and the
    // answer is true — the fallback must not have changed the common case.
    const first = makeStore()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)
    expect(await makeStore().clearDismissals()).toBe(true)
    expect((await makeStore().accounts()).map(a => a.accountName)).toEqual(['WindowsAccount'])
  })
})

describe('the lock helper used above is real', () => {
  it('produces an EPERM-shaped error the card classifies as contention', async () => {
    const { confinedError } = lockDismissalFile()
    const error = confinedError()
    expect(error.code).toBe('EPERM')
    // The card's own classifier must recognise it, or the message it renders
    // would be the raw temp path instead of the remedy.
    const { isFileContentionWriteError } = await import('../src/client/account-selection.ts')
    expect(isFileContentionWriteError(error)).toBe(true)
    expect(realFsPromises).toBeDefined()
  })
})
