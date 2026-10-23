/**
 * The REAL Windows file-lock case, measured against the operating system
 * instead of a mocked error code.
 *
 * `tests/dismissal-clear-failure.spec.ts` injects `EPERM`/`EBUSY` to pin the
 * CONTROL FLOW on every platform. That is enough to stop a regression, but it
 * cannot answer the question `docs/WINDOWS.md` §2 actually asks: does a genuine
 * Windows sharing violation behave the way we assumed? A mocked `throw` never
 * refuses anything, so it can only ever confirm the branch we wrote.
 *
 * This file holds the dismissal file open for real, with
 * `[System.IO.File]::Open(..., FileShare.Read)` — the shape a scanner or sync
 * client produces. That share mode is chosen deliberately over `FileShare.None`
 * because the two mean OPPOSITE things to this feature:
 *
 *   FileShare.Read   readers still succeed, so the hide list IS in force and the
 *                    account stays hidden — deleting and replacing are both
 *                    refused. This is the only shape in which the user is really
 *                    stuck, and the one the card's error line exists for.
 *   FileShare.None   even reading fails, so `readDismissed` answers "nothing is
 *                    hidden" (the documented rule for a list that only REMOVES
 *                    things). The account comes back by itself and there is
 *                    nothing to report — see the `both` mode in the mock suite.
 *
 * Windows-only on purpose, and it SKIPS elsewhere: `FileShare` has no POSIX
 * equivalent (unlink on an open file simply works there), so on macOS/Linux
 * there is nothing to assert — the absence of the failure IS the semantics.
 * `tests/platform-standing.spec.ts` keeps a Windows runner in the CI matrix, so
 * this runs on every push.
 *
 * The TEARDOWN has a Windows lesson of its own, and it is why this file was
 * fixed while CI was still green. `kill()` only DELIVERS a signal; the kernel
 * closes the held handle a few milliseconds LATER. Removing the temp tree
 * immediately after `kill()` therefore lands inside that window and fails with
 * `EBUSY`. Measured on the machine this was fixed on: `rm` reached its `unlink`
 * 1ms after `kill()` returned, while the handle stayed open until ~9ms — so the
 * failure was deterministic there and `0/8` rounds survived it, yet a slow
 * runner can spend longer than that merely walking the tree, which is why
 * `windows-latest` never saw it. State that plainly, because the shape is
 * misleading: every ASSERTION in this file passed, and the red test was the
 * cleanup. It was never evidence of a store bug.
 *
 * The fix waits for 'exit' — the condition the cleanup actually needs — and
 * keeps `rm`'s own contention budget as a second layer. A blind `sleep` would
 * pass too (measured), but it would encode only "long enough on my machine".
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const isWindows = process.platform === 'win32'

let root = ''
let authDir = ''
let vaultDir = ''
let lockProcess: ReturnType<typeof execFile> | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-winlock-'))
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
    account: { uid: 'L1', uin: '7001', nickname: 'LockedAccount' },
  }), 'utf8')
})

afterEach(async () => {
  // `kill()` returns as soon as the signal is DELIVERED; the holder's file
  // handle is closed by the kernel a few ms later. Removing the tree in that
  // window is the `EBUSY` this teardown used to die on (see the file header).
  await killLockHolder()
  // Second layer: even once the process is gone, a Windows runner can still
  // refuse briefly (a scanner that opened the file in the meantime). `rm`'s own
  // retry budget absorbs that instead of failing the cleanup.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

/**
 * Kill the holder process and wait for it to actually EXIT.
 *
 * Waiting for the condition rather than assuming the signal is the whole story
 * is the entire point: `kill()` resolving says nothing about whether Windows
 * has closed the handle yet.
 *
 * The 10s guard is a backstop, not a timeout to tune. If it ever fires, the
 * cleanup must still proceed — a hung helper would otherwise turn one leaked
 * temp directory into a red suite, which is the same "cleanup failure masks
 * the real result" trap this fix removes. The already-dead case is settled by
 * the `exitCode`/`signalCode` check BEFORE any listener is attached: a process
 * that died earlier emits no further 'exit', so waiting on the event alone
 * would hang for the full guard every time.
 */
async function waitForExit(child: ReturnType<typeof execFile>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve()
    }
    const guard = setTimeout(() => {
      // Escalate once so a wedged PowerShell still dies, then stop waiting:
      // the `rm` below carries its own retry budget.
      child.kill('SIGKILL')
      done()
    }, 10_000)
    child.once('exit', done)
  })
}

async function killLockHolder(): Promise<void> {
  const child = lockProcess
  lockProcess = undefined
  if (child === undefined) return
  child.kill()
  await waitForExit(child)
}

/**
 * Hold `path` open with `FileShare.Read` until the returned handle is killed.
 *
 * Resolves once PowerShell has CONFIRMED the handle is open (it prints `LOCKED`
 * after `File::Open` returns), so the test never races the lock.
 */
async function holdFileWithReadShare(path: string): Promise<void> {
  // A script FILE rather than `-Command`: arguments to `-Command` have to be
  // threaded through quoting rules that differ between PowerShell editions, and
  // a Windows path containing a space would break it.
  const scriptPath = join(root, 'hold.ps1')
  await writeFile(scriptPath, [
    "$ErrorActionPreference = 'Stop'",
    '$target = $args[0]',
    // FileShare::Read: other processes may READ, nobody may delete or replace.
    '$handle = [System.IO.File]::Open($target, [System.IO.FileMode]::Open,',
    '  [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)',
    "Write-Output 'LOCKED'",
    '[Console]::Out.Flush()',
    'Start-Sleep -Seconds 120',
    '$handle.Close()',
  ].join('\n'), 'utf8')

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, path],
      // windowsHide per the project's standing rule (docs/WINDOWS.md §1-5): the
      // host has no console, so an unhidden child would flash a black window.
      { windowsHide: true },
      error => { if (error !== null) reject(error) },
    )
    lockProcess = child
    let seen = ''
    const timer = setTimeout(() => reject(new Error(`the lock never confirmed: ${seen}`)), 20_000)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      seen += String(chunk)
      if (seen.includes('LOCKED')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('error', (error: Error) => { clearTimeout(timer); reject(error) })
  })
}

describe.skipIf(!isWindows)('a real Windows sharing violation on the dismissal list', () => {
  it('refuses both the delete and the replace, and says so instead of pretending', async () => {
    const { WorkBuddyCredentialStore } = await import('../src/auth.ts')
    const makeStore = (): InstanceType<typeof WorkBuddyCredentialStore> =>
      new WorkBuddyCredentialStore({
        region: 'cn',
        authDirs: [authDir],
        vaultDir,
        refresh: async (credential: unknown) => credential,
      } as never)

    // 1. Remove the account, so a dismissal list exists on disk.
    const first = makeStore()
    const [account] = await first.accounts()
    expect(account?.accountName).toBe('LockedAccount')
    await first.removeAccount(account!.id)
    expect(await makeStore().accounts()).toEqual([])

    // 2. Hold the file the way a scanner does: readable, not replaceable.
    await holdFileWithReadShare(join(vaultDir, '.dismissed.json'))

    // 3. The rescan must not claim success. THIS is the assertion the mocked
    //    suite cannot make, because only the OS can refuse the real operation.
    const cleared = await makeStore().clearDismissals()
    expect(cleared).toBe(false)
    // The hide is still in force — which is exactly why `false` is truthful
    // rather than pessimistic.
    expect(await makeStore().accounts()).toEqual([])
  })

  it('clears the hides as soon as the holder lets go', async () => {
    const { WorkBuddyCredentialStore } = await import('../src/auth.ts')
    const makeStore = (): InstanceType<typeof WorkBuddyCredentialStore> =>
      new WorkBuddyCredentialStore({
        region: 'cn',
        authDirs: [authDir],
        vaultDir,
        refresh: async (credential: unknown) => credential,
      } as never)

    const first = makeStore()
    const [account] = await first.accounts()
    await first.removeAccount(account!.id)
    await holdFileWithReadShare(join(vaultDir, '.dismissed.json'))
    expect(await makeStore().clearDismissals()).toBe(false)

    // Release, then retry: the SAME call must now succeed and the account must
    // come back, so the failure above is a transient condition rather than a
    // stuck state the user cannot leave.
    //
    // Waits for the real exit instead of a fixed 1.5s sleep. The sleep happened
    // to cover the handle-release window, which is why THIS test stayed green
    // while the file still failed in `afterEach` — the same race, papered over
    // in one place and not the other. Waiting on the condition removes the
    // guesswork and documents the dependency: the account returns only once the
    // OS has actually let the file go.
    await killLockHolder()

    expect(await makeStore().clearDismissals()).toBe(true)
    expect((await makeStore().accounts()).map(a => a.accountName)).toEqual(['LockedAccount'])
  }, 30_000)
})
