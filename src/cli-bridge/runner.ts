/**
 * One bridged CodeBuddy turn, and the credential walk around it.
 *
 * WHAT THIS ROUTE ACTUALLY ESCAPES — the honest version. The provider route has
 * to look like a CodeBuddy client to get past the gateway's channel check (code
 * 11128), which is an arms race the upstream fights with zero-width-space
 * perturbation. This route does not impersonate a client at all: the process
 * that talks to the gateway really is the CodeBuddy CLI. **That is a CLIENT
 * FINGERPRINT win, not an account win.** The credential this module hands the
 * CLI comes from the very same local vault the provider route uses, so an
 * account that the upstream restricted (code 11140, 「账号存在异常行为」) is
 * restricted on this route too. Do not describe it as a way around a ban.
 *
 * THE INPUT PROTOCOL, which is less obvious than it looks. `stream-json` is not
 * a one-way pipe. The CLI asks the driver for permission over the SAME channel
 * (`{"type":"control_request","request":{"subtype":"can_use_tool",…}}`) and
 * waits for a reply; if stdin was closed after the prompt was written, nobody
 * answers and in `plan` mode the process waits forever. So stdin stays OPEN
 * until the turn ends, every permission request is denied, and stdin is only
 * closed once a `result` frame arrives. The denial carries `interrupt: true`
 * ONLY for `ExitPlanMode`: without it `plan` hangs even after a denial, and
 * with it a denied Bash aborts the whole turn instead of letting the CLI pick a
 * different tool. Both directions were measured. See `denyPermission`.
 *
 * Two more decisions are load-bearing and easy to undo by accident:
 *
 * 1. **The prompt travels on stdin, never on argv**, and neither does anything
 *    else user-controlled: `--model` and `--append-system-prompt` come from the
 *    plugin config, and going through `cmd.exe` would let `&` / `|` / `>` in
 *    them become command separators.
 *
 * 2. **There is no shell, and no PATH fallback.** The CLI entry is always run as
 *    `node <entry>`, so no `.cmd` shim and no `shell: true` exists anywhere in
 *    this module. If the package cannot be located, the turn is refused and the
 *    user is told to set `cliBridge.binary` — because the alternative is
 *    spawning whatever `codebuddy` happens to be first on PATH, and that process
 *    would inherit a WorkBuddy token.
 *
 * @module dsh-connect-workbuddy/cli-bridge/runner
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactCliText } from './redact.ts'

/** Package that owns the CLI, under a global `node_modules`. */
const CLI_PACKAGE_PATH = join('@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy')

/** A single NDJSON line bigger than this is a broken build, not a big answer. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** How much stderr is kept for the error message. The TAIL is what matters. */
export const MAX_STDERR_CHARS = 16 * 1024

/** How much assistant text is accumulated before the turn is failed. */
export const MAX_ASSISTANT_CHARS = 2_000_000

/** How long the CLI gets to exit on its own after a `result` frame. */
export const EXIT_GRACE_MS = 3_000

/** Prefixes the CLI reads as "not a real denial" and therefore ignores. */
const SYNTHETIC_DENY_PREFIXES = [
  'cancelled',
  'timeout waiting for user response',
  'this is an unattended automated session',
] as const

/**
 * The reason sent with every denial.
 *
 * It must NOT start with one of `SYNTHETIC_DENY_PREFIXES`: the CLI treats those
 * as a cancelled prompt rather than a decision and lets the tool proceed, which
 * would turn "deny everything" into "allow everything" while looking correct.
 */
const DENY_REASON = 'dsh-connect-workbuddy runs this turn unattended; no human is at the terminal to approve tool use'

/** True when a denial reason would be read as a synthetic (ignored) denial. */
export function isSyntheticDenyReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase()
  return SYNTHETIC_DENY_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

/** One credential the bridge may use, already resolved from the vault. */
export interface BridgeCredential {
  token: string
  /** Human-readable origin, used only in log lines. Never the token itself. */
  source: string
  region: string
  /** Past `expiresAtMs`. Tried anyway, last: the field is not trustworthy. */
  expired: boolean
}

/** Everything one turn needs. Built per call, never cached. */
export interface TurnOptions {
  prompt: string
  cwd: string
  /** Explicit CLI entry from config; `''` means auto-detect. */
  binary: string
  model: string
  permissionMode: string
  effort: string
  maxTurns: number
  timeoutMs: number
  appendSystemPrompt: string
  /** Continue this CLI session instead of starting a fresh one. */
  sessionId?: string
  /** Continue the most recent session for this working directory. */
  continueSession?: boolean
  signal?: AbortSignal
  /**
   * Called as the CLI's frames arrive, so the composer can say what is happening
   * while it is happening.
   *
   * A callback rather than an event emitter on purpose: the only consumer is the
   * live board (./live.ts), which merges the payload into one mutable object. The
   * runner therefore stays a pure function of its options — it owns no state a
   * later call could inherit, and the tests can pass nothing at all.
   *
   * It is called for EVERY frame that changes one of these numbers, i.e. once per
   * assistant block. That is a handful of calls per turn, not per token, and each
   * one is an `Object.assign`.
   */
  onProgress?: (progress: TurnProgress) => void
}

/** What one live update carries. Counts and names only — never the text. */
export interface TurnProgress {
  /** Tool calls seen so far in this turn, across every CLI session it used. */
  toolCalls: number
  /** The most recent tool the CLI asked for; `''` before the first one. */
  lastTool: string
  /** Assistant characters accumulated so far. A count, never the characters. */
  chars: number
}

/** What the CLI actually did, after one turn that reached a `result` frame. */
export interface TurnOutcome {
  text: string
  toolCounts: Map<string, number>
  /** Tools the CLI asked to use and this module refused. */
  deniedTools: readonly string[]
  sessionId: string | undefined
  usage: UsageCounts | undefined
  numTurns: number | undefined
  isError: boolean
  errors: readonly string[]
  subtype: string | undefined
  stderr: string
}

/** The CLI's own token accounting for the turn. */
export interface UsageCounts {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** The settled answer of a whole bridged call. */
export interface AgentOutcome {
  ok: boolean
  text: string
  toolCounts: Map<string, number>
  deniedTools: readonly string[]
  sessionId: string | undefined
  usage: UsageCounts | undefined
  numTurns: number | undefined
  credential: BridgeCredential
  elapsedMs: number
  error: string | undefined
}

/**
 * Directories that ARE a `node_modules` root a global install can live in,
 * most likely first.
 *
 * WHY THE LIST IS THIS LONG. The first draft knew only about `%APPDATA%\npm`
 * and the two `/usr/*` prefixes, so every nvm, fnm, volta, pnpm, yarn, brew,
 * `~/.local` and `/opt/homebrew` user got "CLI not found" even though it was
 * installed. The version-manager roots cannot be listed statically (they carry
 * a version or a hash in the path), so `versionedCliRoots` globs one level.
 *
 * WHY EVERY ENTRY SPELLS OUT ITS OWN LAYOUT. A global npm prefix is not shaped
 * the same way on every platform. On POSIX a prefix holds
 * `<prefix>/lib/node_modules`; on Windows the prefix `%APPDATA%\npm` holds
 * `<prefix>\node_modules` directly and has no `lib` level at all. Appending
 * `lib/node_modules` to every root — which an earlier revision of this list
 * did — produced paths that exist on no Windows machine, so auto-detection
 * failed for every Windows user while the POSIX roots kept working. The
 * pnpm and yarn stores are their own `node_modules` root for the same reason.
 *
 * None of these are probed through PATH, and `cbc` is not a separate target: it
 * is an alias of the same `bin/codebuddy` file inside the package.
 */
function cliModuleDirs(): readonly string[] {
  const home = homedir()
  const dirs: string[] = []

  // Windows: the npm prefix is `%APPDATA%\npm`, packages sit directly under it.
  const appData = process.env['APPDATA']
  if (typeof appData === 'string' && appData !== '') dirs.push(join(appData, 'npm', 'node_modules'))
  // Windows installations that predate the AppData redirect (same shape).
  dirs.push(join(home, 'AppData', 'Roaming', 'npm', 'node_modules'))

  // POSIX npm prefixes, including `npm config get prefix` and Homebrew's.
  for (const prefix of [join(home, '.npm-global'), '/usr/local', '/opt/homebrew', join(home, '.local')]) {
    dirs.push(join(prefix, 'lib', 'node_modules'))
  }

  // pnpm's and yarn's global stores are themselves the module root, and their
  // default location is platform-specific: pnpm keeps its global dir under
  // `%LOCALAPPDATA%\pnpm` on Windows and `~/Library/pnpm` on macOS, while yarn
  // 1.x keeps it under `%LOCALAPPDATA%\Yarn\Data` on Windows. These are the
  // defaults each tool documents; a wrong guess costs one `existsSync`, so the
  // cost of listing them is zero and the cost of omitting them is "CLI not
  // found" on a platform nobody tested.
  dirs.push(join(home, '.local', 'share', 'pnpm', 'global', '5', 'node_modules'))
  dirs.push(join(home, 'Library', 'pnpm', 'global', '5', 'node_modules'))
  const localAppData = process.env['LOCALAPPDATA']
  if (typeof localAppData === 'string' && localAppData !== '') {
    dirs.push(join(localAppData, 'pnpm', 'global', '5', 'node_modules'))
    dirs.push(join(localAppData, 'Yarn', 'Data', 'global', 'node_modules'))
  }
  dirs.push(join(home, '.config', 'yarn', 'global', 'node_modules'))

  return dirs
}

/** Directories whose children are node version roots (`.../versions/node/<v>`). */
function versionedCliRoots(): readonly string[] {
  const home = homedir()
  const roots: string[] = [
    join(home, '.nvm', 'versions', 'node'),
    join(home, 'n', 'versions', 'node'),
    join(home, '.fnm', 'node-versions'),
    join(home, '.local', 'share', 'fnm', 'node-versions'),
    // Volta keeps one image per tool version, so its packages live one level
    // deeper than a plain prefix: `tools/image/node/<version>/lib/node_modules`.
    join(home, '.volta', 'tools', 'image', 'node'),
  ]
  // fnm's default base directory is `%APPDATA%\fnm` on Windows; the two above
  // are its POSIX and portable locations.
  const appData = process.env['APPDATA']
  if (typeof appData === 'string' && appData !== '') roots.push(join(appData, 'fnm', 'node-versions'))
  return roots
}

/** Expand one directory's children into CLI entries, ignoring unreadable ones. */
function childrenOf(dir: string, separator: readonly string[]): readonly string[] {
  const out: string[] = []
  try {
    for (const child of readdirSync(dir)) out.push(join(dir, child, ...separator))
  } catch {
    // Missing or unreadable: this root simply has no install in it.
  }
  return out
}

/** Every path a global install of the CLI could live at, most likely first. */
export function cliEntryCandidates(): readonly string[] {
  const out: string[] = [...cliModuleDirs().map(dir => join(dir, CLI_PACKAGE_PATH))]
  for (const versions of versionedCliRoots()) {
    out.push(...childrenOf(versions, ['lib', 'node_modules', CLI_PACKAGE_PATH]))
    out.push(...childrenOf(versions, ['installation', 'lib', 'node_modules', CLI_PACKAGE_PATH]))
  }
  // `%APPDATA%\npm` and `~/AppData/Roaming/npm` are the same directory on a
  // normal Windows machine. Deduplicate so the list reports how many distinct
  // places were actually probed, instead of listing one of them twice.
  return [...new Set(out)]
}

/** Where the CLI entry was found, or why it was not. */
export interface CliEntryChoice {
  ok: boolean
  entry: string
  /** True when the path came from `cliBridge.binary`, so it is taken literally. */
  configured: boolean
  reason: string
}

/**
 * Locate the CLI's JS entry.
 *
 * An explicit `binary` from config wins and is taken literally — never
 * second-guessed with a fallback, because a typo answered by a different
 * working executable is a bug nobody can reproduce. A `.cmd`/`.bat` path is
 * REJECTED rather than executed, because running one means going through a
 * shell, and that is the exact injection surface this module exists to avoid.
 */
export function resolveCliEntry(binary: string): CliEntryChoice {
  if (binary !== '') {
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(binary)) {
      return {
        ok: false,
        entry: '',
        configured: true,
        reason:
          `cliBridge.binary 指向了 ${binary}，那是一个批处理包装，运行它要经过 cmd.exe，` +
          '会把配置里的 --model / --append-system-prompt 当成命令解释。请改成同一个包里的 JS 入口，' +
          `例如 ${join(binary.replace(/\.(?:cmd|bat)$/iu, ''), '..', 'node_modules', CLI_PACKAGE_PATH)}。`,
      }
    }
    if (!existsSync(binary)) {
      return { ok: false, entry: '', configured: true, reason: `cliBridge.binary 指定的路径不存在：${binary}` }
    }
    return { ok: true, entry: binary, configured: true, reason: '' }
  }

  for (const candidate of cliEntryCandidates()) {
    if (existsSync(candidate)) return { ok: true, entry: candidate, configured: false, reason: '' }
  }

  return {
    ok: false,
    entry: '',
    configured: false,
    reason:
      '没有找到本机安装的 CodeBuddy CLI（已查过 npm/pnpm/yarn/volta 全局目录与 nvm/fnm 的版本目录）。' +
      '请先安装 @tencent-ai/codebuddy-code，或在插件配置里用 cliBridge.binary 指定它的绝对路径' +
      '（要指向包内的 bin/codebuddy，不要指向 .cmd 包装）。' +
      '不会回退到 PATH 上的 codebuddy —— 那样会把 WorkBuddy 凭据交给一个来源不明的程序。',
  }
}

/**
 * Whether a finished-but-failed run failed specifically because the credential
 * was refused.
 *
 * ONLY the CLI's own error channel is read. The first draft also scanned the
 * assistant text, which meant a review that merely QUOTED `HTTP 401` looked like
 * a rejected token: the bridge then discarded a perfectly good turn and re-ran
 * the whole thing on the next account. `text` is deliberately not a parameter
 * here so that cannot come back.
 */
export function looksLikeAuthFailure(out: Pick<TurnOutcome, 'isError' | 'errors' | 'subtype'>): boolean {
  if (!out.isError) return false
  const channel = `${out.errors.join('\n')}\n${out.subtype ?? ''}`
  return /\b401\b|Authentication required|\/login command|invalid[_-]?api[_-]?key/i.test(channel)
}

/** Shape of one NDJSON frame, as far as this module cares. */
interface CliFrame {
  type?: string
  request_id?: string
  request?: { subtype?: string; tool_name?: string }
  message?: { content?: unknown }
  content?: unknown
  session_id?: string
  usage?: UsageCounts
  num_turns?: number
  is_error?: boolean
  errors?: unknown
  subtype?: string
}

/** One content block inside an assistant frame. */
interface ContentBlock {
  type?: string
  text?: string
  name?: string
}

function blocksOf(frame: CliFrame): readonly ContentBlock[] {
  const fromMessage = frame.message?.content
  if (Array.isArray(fromMessage)) return fromMessage as readonly ContentBlock[]
  const topLevel = frame.content
  if (Array.isArray(topLevel)) return topLevel as readonly ContentBlock[]
  return []
}

/** Whether `pid` may be used as a process-GROUP id for `process.kill(-pid, …)`. */
function usableGroupPid(pid: number | undefined): pid is number {
  // `process.kill(-pid)` never means "signal child pid": it means "signal process GROUP pid".
  // Two values are not merely wrong but catastrophic, because they stop naming a child tree
  // and start naming everything around us:
  //   -pid === 0  -> the CALLER's own process group (the host that spawned us)
  //   -pid === -1 -> every process this user may signal; on a desktop host that is the whole
  //                  login session (Finder, Dock, the user's chat apps, DSH itself)
  // A mocked, stubbed, or already-reaped child can hand us either value (a unit test that
  // fabricates `pid: 1` to distinguish two fake children used to SIGTERM the entire Mac),
  // so only a real group-leader id may take the group-kill path.
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

/** Kill a child AND everything it spawned (git, npm, a test runner). */
function killTree(child: { pid?: number | undefined; kill: (signal?: NodeJS.Signals) => boolean }): void {
  const pid = child.pid
  if (!usableGroupPid(pid)) {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
    return
  }
  if (process.platform === 'win32') {
    // Windows has no process groups reachable through `process.kill(-pid)`;
    // `taskkill /T` is the only documented way to take the tree down.
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    } catch {
      // Fall through to the single-process kill below.
    }
    try {
      child.kill()
    } catch {
      // Already gone.
    }
    return
  }
  try {
    // Negative pid = the whole process group, which exists because every turn is
    // spawned with `detached: true`.
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone.
      return
    }
  }
  // Escalate if it ignores SIGTERM; unref'd so it never keeps the process alive.
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Exited between SIGTERM and now — the normal case.
    }
  }, 1_000)
  escalate.unref()
}

/** Run exactly one CLI turn with exactly one token. */
function runOneTurn(options: TurnOptions, token: string): Promise<TurnOutcome> {
  const entryChoice = resolveCliEntry(options.binary)
  if (!entryChoice.ok) return Promise.reject(new Error(entryChoice.reason))

  const args = [
    entryChoice.entry,
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(options.maxTurns),
    '--permission-mode', options.permissionMode,
  ]
  if (options.model !== '') args.push('--model', options.model)
  if (options.effort !== '') args.push('--effort', options.effort)
  if (options.appendSystemPrompt !== '') args.push('--append-system-prompt', options.appendSystemPrompt)
  if (options.sessionId !== undefined && options.sessionId !== '') args.push('--session-id', options.sessionId)
  if (options.continueSession === true) args.push('--continue')

  const env = {
    ...process.env,
    CODEBUDDY_AUTH_TOKEN: token,
    // A single-shot `-p` turn cannot receive background task events, so the
    // background variants are removed from the tool schema entirely.
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
  }

  return new Promise<TurnOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env,
      // Never true. See the module comment: this is the injection surface.
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // A process group, so a timeout can take down the CLI's own children.
      detached: process.platform !== 'win32',
    })

    let settled = false
    const assistantText: string[] = []
    let assistantChars = 0
    const toolCounts = new Map<string, number>()
    // Running totals for the live board. Kept alongside `toolCounts` rather than
    // recomputed from it: the board is updated per frame, and summing the map on
    // every update would make the cost of a turn quadratic in its tool calls.
    let liveToolCalls = 0
    let lastToolName = ''
    const deniedTools: string[] = []
    let stderr = ''
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const redact = (text: string): string => redactCliText(text, [token])

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
    }

    const closeStdin = (): void => {
      // The CLI may have closed its end first; a broken pipe is noise here.
      try {
        child.stdin.end()
      } catch {
        // Nothing to do: the result frame is what decides the turn.
      }
    }

    /** After a settle, give the CLI a moment to exit; then take the tree down. */
    const scheduleReaper = (): void => {
      graceTimer = setTimeout(() => {
        killTree(child)
      }, EXIT_GRACE_MS)
      graceTimer.unref()
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      closeStdin()
      killTree(child)
      reject(error)
    }

    const onAbort = (): void => {
      fail(new Error('cancelled by the host'))
    }

    const settle = (frame: CliFrame): void => {
      if (settled) return
      settled = true
      cleanup()
      // Closing stdin is what lets the CLI shut down cleanly; it does so in
      // well under a second when it has already emitted `result`.
      closeStdin()
      scheduleReaper()
      const errors = Array.isArray(frame.errors)
        ? frame.errors.filter((value): value is string => typeof value === 'string').map(redact)
        : []
      const text = redact(assistantText.join('\n').trim())
      resolve({
        text,
        toolCounts,
        deniedTools,
        sessionId: typeof frame.session_id === 'string' ? frame.session_id : undefined,
        usage: frame.usage,
        numTurns: typeof frame.num_turns === 'number' ? frame.num_turns : undefined,
        isError: frame.is_error === true,
        errors,
        subtype: typeof frame.subtype === 'string' ? frame.subtype : undefined,
        stderr: redact(stderr),
      })
    }

    /**
     * Answer one permission request. Always a denial; see `DENY_REASON`.
     *
     * `interrupt` IS PER-TOOL, NOT A BLANKET FLAG. Measured against the real CLI:
     *
     * - `plan` asks for approval of `ExitPlanMode`. A plain denial there is
     *   answered by waiting for yet another decision and the process never ends
     *   (>70s, until `timeoutSecs`). `interrupt: true` ends it immediately.
     * - Every other tool (Bash, Write, …) is fine to deny WITHOUT `interrupt`:
     *   the CLI records the denial and tries a different tool, so the turn still
     *   produces a normal reply. Adding `interrupt: true` there aborts the whole
     *   turn instead — measured: `acceptEdits` + Bash denial → `is_error: true`,
     *   empty reply, `Permission denied for tool(s): Bash`, 4.2s.
     *
     * So `interrupt` rides along only when the request is `ExitPlanMode`. That
     * keeps `plan` from hanging without turning every blocked Bash into a failed
     * turn.
     */
    const denyPermission = (frame: CliFrame): void => {
      const toolName = typeof frame.request?.tool_name === 'string' ? frame.request.tool_name : ''
      if (toolName !== '') deniedTools.push(toolName)
      const requestId = typeof frame.request_id === 'string' ? frame.request_id : ''
      if (requestId === '') return
      const mustInterrupt = toolName === 'ExitPlanMode'
      try {
        child.stdin.write(
          `${JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response: {
                allowed: false,
                reason: DENY_REASON,
                ...(mustInterrupt ? { interrupt: true } : {}),
              },
            },
          })}\n`,
        )
      } catch {
        // A dead pipe means the CLI already gave up; the result frame (or the
        // timeout) decides the turn either way.
      }
    }

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        fail(new Error('cancelled by the host'))
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      fail(new Error(`codebuddy exceeded its ${Math.round(options.timeoutMs / 1000)}s budget`))
    }, options.timeoutMs)

    child.stdin.on('error', () => {})
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: options.prompt }] },
      })}\n`,
    )
    // NOT closed here — see the module comment: the CLI asks for permissions on
    // this same pipe and `plan` mode hangs forever if it is already gone.

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      buffer += chunk
      if (buffer.length > MAX_FRAME_BYTES) {
        fail(new Error(`codebuddy emitted a single line longer than ${String(MAX_FRAME_BYTES)} bytes; the CLI build is probably broken`))
        return
      }
      // stream-json is NDJSON; the trailing partial line stays in the buffer.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let frame: CliFrame
        try {
          frame = JSON.parse(trimmed) as CliFrame
        } catch {
          continue // a non-JSON line is noise, not a fatal error
        }
        if (frame.type === 'control_request') {
          denyPermission(frame)
          continue
        }
        // An assistant turn arrives as {type:'assistant', message:{content:[…]}};
        // some builds put the blocks at the top level, so accept both.
        if (frame.type === 'assistant') {
          for (const block of blocksOf(frame)) {
            if (block.type === 'text' && typeof block.text === 'string') {
              assistantChars += block.text.length
              if (assistantChars > MAX_ASSISTANT_CHARS) {
                fail(new Error(`codebuddy produced more than ${String(MAX_ASSISTANT_CHARS)} characters of assistant text in one turn`))
                return
              }
              assistantText.push(block.text)
              options.onProgress?.({ toolCalls: liveToolCalls, lastTool: lastToolName, chars: assistantChars })
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1)
              liveToolCalls += 1
              lastToolName = block.name
              options.onProgress?.({ toolCalls: liveToolCalls, lastTool: lastToolName, chars: assistantChars })
            }
          }
        }
        if (frame.type === 'result') {
          settle(frame)
          return
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      // Keep the TAIL: an error message's useful lines are the last ones, and an
      // unbounded `+=` here is how one chatty CLI turns into a memory leak.
      if (stderr.length > MAX_STDERR_CHARS * 2) stderr = stderr.slice(-MAX_STDERR_CHARS)
    })

    child.on('error', (error: Error) => fail(error))
    child.on('close', (code: number | null) => {
      if (settled) return
      const tail = redact(stderr.trim().split('\n').slice(-6).join('\n'))
      fail(
        new Error(
          `codebuddy exited with code ${String(code)} and emitted no result frame` + (tail !== '' ? `\n${tail}` : ''),
        ),
      )
    })
  })
}

/**
 * Run one bridged turn, walking the credential list until a turn completes or
 * the list runs out.
 *
 * WHEN IT MOVES ON, AND WHEN IT STOPS. A wrong-region token 401s, and the only
 * way to know which region this CLI build targets is to ask it — one wasted turn
 * is cheaper than making the user choose a region they cannot know. But ONLY a
 * recognised credential failure is worth another account. The first draft also
 * continued after timeouts, crashes and ENOENT, which with ten vault accounts
 * meant a single bad call could spend 10 × 900s; those errors are identical for
 * every account, so they are raised on the first attempt.
 */
export async function runAgent(
  options: TurnOptions,
  credentials: readonly BridgeCredential[],
  log: (message: string) => void,
): Promise<AgentOutcome> {
  const startedAt = Date.now()
  let lastError: Error | undefined

  for (let index = 0; index < credentials.length; index += 1) {
    const candidate = credentials[index]
    if (candidate === undefined) continue
    if (candidate.expired) {
      log(`${candidate.source} is past its expiry; trying it anyway`)
    }

    const out = await runOneTurn(options, candidate.token)

    const isLast = index === credentials.length - 1
    if (looksLikeAuthFailure(out) && !isLast) {
      log(`${candidate.source} was refused (401); trying the next credential`)
      lastError = new Error(out.errors[0] ?? '401')
      continue
    }

    return {
      ok: !out.isError,
      text: out.text,
      toolCounts: out.toolCounts,
      deniedTools: out.deniedTools,
      sessionId: out.sessionId,
      usage: out.usage,
      numTurns: out.numTurns,
      credential: candidate,
      elapsedMs: Date.now() - startedAt,
      error: out.isError ? (out.errors.join('\n') || out.subtype || 'the turn reported an error') : undefined,
    }
  }

  throw lastError ?? new Error('no credential worked')
}
