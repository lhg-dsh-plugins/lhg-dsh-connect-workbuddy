/**
 * The two host utilities this plugin uses that must ALSO work in the
 * standalone CLI (issue #47).
 *
 * WHY THIS EXISTS. `@deepseek-ai/dsh-atomic-write` and
 * `@deepseek-ai/dsh-home-paths` are declared as **peer** dependencies: the DSH
 * host carries them, and the plugin is supposed to borrow the host's copies.
 * Inside a booted host that works — `packages/boot/app-boot`'s runtime
 * interception layer answers those bare specifiers from the installation. But
 * `dsh plugin --profile <p> exec dsh-connect-workbuddy …` is NOT a booted host:
 * `plugin-manager`'s `runProfilePnpm` spawns `pnpm exec` in the profile
 * directory with the plain environment, so the child resolves with stock Node
 * rules and the interception layer is absent (DSH deliberately never sets
 * `NODE_PATH`; `packages/boot/app-boot/src/index.ts` scrubs it).
 *
 * The profile is created with `autoInstallPeers: false`, so peers are never
 * installed there either. The result on a clean machine is a load-time crash
 * before any command runs:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package
 *   '@deepseek-ai/dsh-atomic-write' imported from
 *   …/profiles/<p>/node_modules/dsh-connect-workbuddy/lib/host-heartbeat-*.js
 *
 * The trigger is CHUNKING, which is why the import looked unrelated to the
 * command: tsdown emits `host-heartbeat-*.js` as the shared chunk holding
 * `auth`, `at-rest`, `host-heartbeat`, and `pi-ai-runtime`, so `lib/bin.js`
 * reaches `auth.ts`'s atomic-write import even for a read-only `status`.
 *
 * WHY NOT a static import with a fallback: a static `import` of a missing
 * package throws at MODULE EVALUATION time, before any fallback can run. The
 * import itself has to be deferred, so both peers are loaded through
 * `import()` inside the functions that need them.
 *
 * WHY NOT move them to `dependencies`: the host half genuinely runs against
 * the host's copies, and duplicating them into every profile would add two
 * packages to a market install to serve a CLI that runs a handful of times.
 * More importantly these two are pure, stateless, cordis-free utilities — no
 * service, no process-global state — so the host's copy and a local copy are
 * interchangeable, which is exactly what makes a fallback safe here. (Contrast
 * `@deepseek-ai/cordis` or pi-ai, where a second copy WOULD be wrong: cordis
 * carries the service registry, and pi-ai's generation changes context shape.)
 *
 * WHY THE FALLBACK MIRRORS THE HOST. `writeFileAtomic` and `withFileLock`
 * govern a cross-process protocol: the lock is a `wx`-created `<file>.lock`
 * sibling and the commit is a same-directory temp file renamed over the
 * target. A fallback with different timing or a different lock path would let
 * a CLI process and the host race each other on the same file, so the retry
 * cadence, the Windows transient-error set, and the `EPERM`-needs-`lstat`
 * confirmation rule are transcribed from the host package rather than
 * reinvented. `docs/WINDOWS.md` and `CHANGELOG.md` (2.0.x) already record the
 * measured budget: delay sequence 20+40+80+160+200×4 ≈ 1100ms, not the
 * "600ms" an earlier draft of the docs claimed.
 *
 * Inside DSH the host's own copy always wins — the dynamic import resolves it
 * first, and the fallback is unreachable there. The fallback exists solely so
 * the standalone CLI is self-sufficient on a machine that has only the plugin.
 *
 * @module dsh-connect-workbuddy/host-peers
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Permission bits for a replacement inode: `0o600`, owner read/write only. */
export interface WriteAtomicOptions {
  /** Permission bits the replacement inode ends up with. */
  mode: number
  /** Permission bits applied when the parent directory must be created. */
  dirMode?: number
}

/** Acquisition options for {@link withFileLock}. */
export interface FileLockOptions {
  /** How long a contender waits before failing; defaults to the host's 2000ms. */
  waitMs?: number
}

// ---------------------------------------------------------------------------
// Host-first resolution
// ---------------------------------------------------------------------------

const ATOMIC_WRITE = '@deepseek-ai/dsh-atomic-write'

/** One module's shape as this plugin uses it, loaded from wherever it resolves. */
interface AtomicWriteModule {
  writeFileAtomic: (filename: string, content: string, options: WriteAtomicOptions) => Promise<void>
  withFileLock: <T>(filename: string, operation: () => Promise<T>, options?: FileLockOptions) => Promise<T>
}

/**
 * Load one peer, preferring whatever the host provides.
 *
 * The host's copy is resolved through the same ESM resolver this module is
 * loaded by, so the answer matches the import the plugin would otherwise have
 * made. Resolution failure is not an error here: it is the documented state of
 * a market install probed outside the host, and the caller falls back.
 *
 * Why ONE `catch` covers both "absent" and "broken": `import()` rejects with
 * `ERR_MODULE_NOT_FOUND` for the first and rethrows the module's own error for
 * the second, and there is nothing this plugin could do differently about
 * either — it cannot repair the host's copy. Falling back is strictly better
 * than crashing, and it is not SILENT: `doctor` reports which implementation
 * is in use, so a host copy that is present but unloadable shows up as
 * `fallback` on a machine where the host should have supplied it. Narrowing
 * the catch to `ERR_MODULE_NOT_FOUND` would instead turn a corrupt host
 * install into a hard crash inside a read-only `status`, which is exactly the
 * failure mode issue #47 is about.
 */
async function loadHostModule<T>(specifier: string): Promise<T | undefined> {
  try {
    return await import(specifier) as T
  } catch {
    return undefined
  }
}

let atomicWrite: Promise<AtomicWriteModule | undefined> | undefined

/** The host's atomic-write copy, or undefined when only the fallback is available. */
function hostAtomicWrite(): Promise<AtomicWriteModule | undefined> {
  atomicWrite ??= loadHostModule<AtomicWriteModule>(ATOMIC_WRITE)
  return atomicWrite
}

// ---------------------------------------------------------------------------
// Fallback implementations (transcribed from the host packages)
// ---------------------------------------------------------------------------

/** Directory name for the default DeepSeek Harness home under the OS home. */
const DSH_HOME_DIR_NAME = '.dsh'
/** Environment variable that overrides the default DeepSeek Harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Expand `~`, `~/`, and `~\` against the operating-system home. */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the default harness home without the host package.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
 * `~/.dsh`. A blank `$DSH_HOME` counts as unset, so an empty override can
 * never resolve the home to the current working directory. This is the whole
 * of `resolveDshHome`; the host package's other exports are not used here.
 */
function fallbackResolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const chosen = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME))
  return resolve(expandHomePath(chosen))
}

/** Windows errors that mean temporary interference with an atomic replacement. */
const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | undefined)?.code ?? '')
}

/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0; ; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error: unknown) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * Replace `filename` with `content` in one atomic step, creating parents.
 *
 * The content goes to a random-suffix sibling opened `wx`, so the open refuses
 * to follow a symlink planted at the temp path, and the fresh inode carries
 * `options.mode` through the rename. Same-directory keeps the rename on one
 * filesystem; a failure removes the temp file and rethrows.
 */
async function fallbackWriteFileAtomic(filename: string, content: string, options: WriteAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
  })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameAtomicTemp(temp, filename)
  } catch (error: unknown) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    return false
  }
}

const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
/** The host's own default: sized for a file-work-only critical section. */
const DEFAULT_LOCK_WAIT_MS = 2000

/**
 * Hold the cross-process writer lock for `filename` around one operation.
 *
 * The lock is a `wx`-created `<filename>.lock` sibling; paired with the
 * rename-based commit above, readers stay lock-free and only writers contend.
 * An `EPERM` counts as contention only when a fresh `lstat` confirms the lock
 * exists, which covers exclusive-create behavior on Windows. The contender
 * never removes an existing lock: file age cannot prove its owner stopped.
 */
async function fallbackWithFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  let retriedUnconfirmedPermissionError = false
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error: unknown) {
      if (!(await isLockContention(error, lockPath))) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        // One unconfirmed EPERM is retried on Windows: the holder can release
        // between the failed create and the probe.
        if (process.platform !== 'win32' || code !== 'EPERM' || retriedUnconfirmedPermissionError) throw error
        retriedUnconfirmedPermissionError = true
      }
    }
    if (Date.now() >= deadline) throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}

// ---------------------------------------------------------------------------
// The API the rest of the plugin uses
// ---------------------------------------------------------------------------

/**
 * Resolve the DeepSeek Harness home.
 *
 * Deliberately SYNCHRONOUS and self-contained rather than a host-first loader.
 * The host package's `resolveDshHome` is a pure function of its arguments and
 * `process.env` — it performs no I/O — and every call site in this plugin
 * passes NO argument. The zero-argument form is `$DSH_HOME` (when non-blank)
 * else `~/.dsh`, which is reproduced exactly below, so consulting the host
 * copy could not change a single answer while it WOULD have forced the
 * synchronous call sites (credential paths, the heartbeat path) to become
 * async. The host import is therefore dropped outright.
 *
 * Cost of being wrong: nothing. Precedence is transcribed, not guessed, and
 * the two branches are pinned by `tests/host-peers.spec.ts`.
 */
export function resolveDshHome(configured?: string): string {
  return fallbackResolveDshHome(configured)
}

/**
 * Replace `filename` with `content` atomically, under the sibling write lock.
 *
 * Async only because the host module is loaded lazily; inside DSH this is the
 * host's own implementation.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteAtomicOptions): Promise<void> {
  const host = await hostAtomicWrite()
  if (host === undefined) return fallbackWriteFileAtomic(filename, content, options)
  return host.writeFileAtomic(filename, content, options)
}

/** Hold the cross-process writer lock for `filename` around one operation. */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const host = await hostAtomicWrite()
  if (host === undefined) return fallbackWithFileLock(filename, operation, options)
  return host.withFileLock(filename, operation, options)
}

/**
 * Which atomic-write implementation this process would use.
 *
 * `doctor` reports it so the "works inside DSH, crashed under `plugin exec`"
 * split behind issue #47 is visible on demand instead of being inferred from a
 * stack trace. `fallback` is the expected answer outside a booted host.
 */
export async function hostPeersInfo(): Promise<{ atomicWrite: 'host' | 'fallback' }> {
  return { atomicWrite: (await hostAtomicWrite()) === undefined ? 'fallback' : 'host' }
}
