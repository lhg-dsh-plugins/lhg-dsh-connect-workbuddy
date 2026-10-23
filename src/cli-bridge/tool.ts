/**
 * `codebuddy_ask` — the model-side entrance to the CLI route.
 *
 * WHAT THIS ROUTE DOES AND DOES NOT ESCAPE. The provider route has to look like
 * a CodeBuddy client to get past the gateway's channel check, which is a
 * fingerprint arms race. Here the process that talks to the gateway really is
 * the CodeBuddy CLI, so there is no client to impersonate. But the credential is
 * the same local vault account, so this is a CLIENT-FINGERPRINT win only: an
 * account restricted upstream (code 11140) is restricted here too. See the
 * module comment in `./runner.ts` for the long version.
 *
 * THE PRICE, stated plainly: a bridged turn is a SEPARATE agent. It does not see
 * this session's conversation, so it re-explores the workspace from scratch. That
 * is fine for "review this module" and wrong for "continue what we were doing" —
 * which is why the tool takes a self-contained `message`.
 *
 * THE DIRECTORY RULE IS THE IMPORTANT PART OF THIS FILE. A bridged turn spawns
 * an agent that can edit files, and the directory it runs in is that agent's
 * whole world. So the directory is never taken on faith: it must exist, be a
 * directory, and resolve to somewhere this plugin is allowed to point a
 * file-editing agent at. A model that asks for `C:\Users\...\.ssh` gets a
 * refusal that says why, not a turn.
 *
 * @module dsh-connect-workbuddy/cli-bridge/tool
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { resolveCredentials, type BridgeCredentialRegion } from './credentials.ts'
import { TurnGate, type GateLimits } from './gate.ts'
import type { LiveBoard, LiveEntrance, LiveTurn } from './live.ts'
import { runAgent } from './runner.ts'
import type { BridgeLog, BridgeToolExecution, BridgeToolsService } from './services.ts'

/** Permission modes the CLI accepts for `--permission-mode`. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const

/** Reasoning levels the CLI accepts for `--effort`. */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Hard ceiling on one turn's agent budget, whatever the config says. */
export const MAX_TURNS_CAP = 100

/** Hard ceiling on one turn's wall clock, in seconds. */
export const TIMEOUT_SECS_CAP = 1800

/** How many distinct tools the result reports before the array is cut. */
export const TOOLS_CAP = 12

/** Hard ceiling on the reply length, in characters. */
export const MAX_REPLY_CHARS_CAP = 400_000

/**
 * What `cliBridge.sessionContinuity` accepts.
 *
 * `auto` threads the previous CLI session into the next call; `off` leaves every
 * call independent unless the caller passes `session_id` itself. There is no
 * `on`-with-a-different-mechanism value: the one that was measured to work is
 * `--session-id <existing>`, and offering `--continue` (whatever ran last in the
 * cwd) next to it would make two concurrent sessions race for one conversation.
 */
export const SESSION_CONTINUITY_MODES = ['auto', 'off'] as const

/** The normalized bridge settings, derived from the plugin config. */
export interface BridgeOptions {
  /** Whether the route is mounted at all. Off by default. */
  enabled: boolean
  binary: string
  model: string
  permissionMode: string
  effort: string
  maxTurns: number
  timeoutSecs: number
  regionOrder: readonly string[]
  /** Default directory when the caller names none. Must exist; `''` = none. */
  workingDir: string
  /**
   * Extra roots a turn may be pointed at, beyond its own session workspace.
   * Absolute paths, already normalized. Empty by default: with no entry here a
   * turn can only run in the session it was called from.
   */
  allowedDirs: readonly string[]
  appendSystemPrompt: string
  allowUnattended: boolean
  maxReplyChars: number
  injectResult: boolean
  /**
   * `auto` = a call with no explicit `session_id` continues the previous CLI
   * session of the same DSH session. `off` = every call starts fresh unless the
   * caller names a session itself.
   */
  sessionContinuity: (typeof SESSION_CONTINUITY_MODES)[number]
  /** Turns per hour in one session; 0 = unbounded. */
  maxTurnsPerSessionHour: number
  /** Turns per hour across the whole process; 0 = unbounded. */
  maxTurnsPerHour: number
}

/** One tool tally in the result shape. */
export interface AskToolTally {
  name: string
  count: number
}

/** The complete result of one bridged turn — every field always present. */
export interface AskResult {
  ok: boolean
  reply: string
  session_id: string
  tools: AskToolTally[]
  denied_tools: string[]
  tool_calls: number
  num_turns: number
  tokens_in: number
  tokens_out: number
  cache_read_tokens: number
  credential_region: string
  working_dir: string
  unattended: boolean
  elapsed_ms: number
  truncated: boolean
  error: string
}

/** Every field defaulted, so the Host's closed schema always validates. */
function result(partial: Partial<AskResult>): AskResult {
  return {
    ok: partial.ok === true,
    reply: partial.reply ?? '',
    session_id: partial.session_id ?? '',
    tools: partial.tools ?? [],
    denied_tools: partial.denied_tools ?? [],
    tool_calls: partial.tool_calls ?? 0,
    num_turns: partial.num_turns ?? 0,
    tokens_in: partial.tokens_in ?? 0,
    tokens_out: partial.tokens_out ?? 0,
    cache_read_tokens: partial.cache_read_tokens ?? 0,
    credential_region: partial.credential_region ?? '',
    working_dir: partial.working_dir ?? '',
    unattended: partial.unattended === true,
    elapsed_ms: partial.elapsed_ms ?? 0,
    truncated: partial.truncated === true,
    error: partial.error ?? '',
  }
}

/** Clamp an optional numeric argument to a config default and a hard ceiling. */
function clampInt(value: unknown, fallback: number, cap: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(cap, number))
}

/**
 * Last CLI session id per DSH session, for automatic continuation.
 *
 * WHY A MAP AND NOT JUST A TOOL ARGUMENT. `--session-id <existing>` really does
 * resume the conversation — measured against the installed CLI: a number sent in
 * turn 1 came back from turn 2, and the CLI echoed the same id both times. But
 * that id only reaches the CLI when the CALLER passes it back as `session_id`,
 * which asks the model to copy a uuid out of the previous result. Best effort,
 * not a guarantee. Remembering the id here makes continuation the default rather
 * than a habit.
 *
 * IN MEMORY ON PURPOSE. The value is a uuid owned by the CLI, and an unknown id
 * is not an error there — the CLI silently starts a fresh session under it. So
 * the failure mode of a lost or stale entry is one new conversation, never a
 * mixed-up one, which is the right trade for a file the plugin would otherwise
 * have to garbage-collect. Bounded (FIFO) so a long-lived process cannot grow it
 * without limit.
 */
const CLI_SESSION_MEMORY = new Map<string, string>()
const CLI_SESSION_MEMORY_CAP = 256

/** Remember the CLI session a DSH session should continue next time. */
export function rememberCliSession(sessionKey: string, cliSessionId: string): void {
  if (sessionKey === '' || cliSessionId === '') return
  // Delete first so an updated key moves to the back of the insertion order.
  CLI_SESSION_MEMORY.delete(sessionKey)
  CLI_SESSION_MEMORY.set(sessionKey, cliSessionId)
  while (CLI_SESSION_MEMORY.size > CLI_SESSION_MEMORY_CAP) {
    const oldest = CLI_SESSION_MEMORY.keys().next()
    if (oldest.done === true) break
    CLI_SESSION_MEMORY.delete(oldest.value)
  }
}

/** The CLI session to continue for this DSH session, or `''` for a fresh one. */
export function recallCliSession(sessionKey: string): string {
  return CLI_SESSION_MEMORY.get(sessionKey) ?? ''
}

/** Drop one session's memory (used by tests and by an explicit reset). */
export function forgetCliSession(sessionKey: string): void {
  CLI_SESSION_MEMORY.delete(sessionKey)
}

/**
 * A throwaway directory for ONE unattended turn.
 *
 * ONE DIRECTORY PER CALL, not a fixed `dsh-codebuddy-scratch`. A single shared
 * path meant two concurrent unattended turns ran in the same writable space —
 * each could read and overwrite the other's files, and anything a previous turn
 * left behind was still there. `mkdtemp` guarantees a fresh, empty, uniquely
 * named directory, which is what makes the "exempt by construction" argument in
 * `resolveWorkingDir` actually true.
 */
export function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-codebuddy-scratch-'))
}

/** Best-effort removal: a locked file must not turn a finished turn into an error. */
function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Left for the OS temp cleaner; the turn itself already succeeded.
  }
}

/** Where a turn will run, or why it cannot run at all. */
export interface WorkingDirChoice {
  ok: boolean
  dir: string
  unattended: boolean
  reason: string
}

/** Case-fold a path on the platforms whose filesystems ignore case. */
function foldCase(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
}

/** Resolve symlinks when we can; fall back to the lexical path when we cannot. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** True when `child` is `parent` itself or lives underneath it. */
function isInside(parent: string, child: string): boolean {
  const outer = foldCase(canonical(parent))
  const inner = foldCase(canonical(child))
  if (inner === outer) return true
  return inner.startsWith(outer.endsWith(sep) ? outer : outer + sep)
}

/** The session directory this tool call came from, when the Host supplies one. */
function sessionDirOf(execution: BridgeToolExecution | undefined): string {
  const cwd = execution?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string') return ''
  const trimmed = cwd.trim()
  // The session service already rejects relative headers; re-check anyway so a
  // hand-built agent in a test cannot smuggle one through this path.
  return trimmed !== '' && isAbsolute(trimmed) ? trimmed : ''
}

/**
 * Decide the directory one turn runs in.
 *
 * THE ORDER IS A LADDER, and the last rung is a refusal rather than a guess.
 * Explicit argument → the calling agent's session cwd → the configured default →
 * an explicitly allowed scratch dir → refuse.
 *
 * THE LADDER IS NOT THE SAFETY PROPERTY; the check after it is. Whatever rung
 * wins, the directory must (a) already exist, (b) be a directory, and (c) resolve
 * inside an allowed root — the session it was called from, the configured
 * default, or one of `allowedDirs`. That third clause is what stops a model from
 * asking for `/` or `~/.ssh`: those exist and are directories, so existence
 * alone would happily accept them.
 *
 * A scratch turn is exempt by construction: it is a fresh empty temp directory
 * the bridge just created, so there is nothing in it to leak.
 */
export function resolveWorkingDir(
  args: Record<string, unknown>,
  options: BridgeOptions,
  execution: BridgeToolExecution | undefined,
): WorkingDirChoice {
  const sessionDir = sessionDirOf(execution)
  const explicit = typeof args['working_dir'] === 'string' ? args['working_dir'].trim() : ''

  let chosen = ''
  let fromArgument = false
  if (explicit !== '') {
    if (!isAbsolute(explicit)) {
      return {
        ok: false,
        dir: '',
        unattended: false,
        reason: `working_dir "${explicit}" 不是绝对路径。请传一个绝对路径（宿主的工具调用不携带会话 cwd）。`,
      }
    }
    chosen = explicit
    fromArgument = true
  } else if (sessionDir !== '') {
    chosen = sessionDir
  } else if (options.workingDir !== '') {
    chosen = options.workingDir
  } else if (args['allow_unattended'] === true || options.allowUnattended) {
    return { ok: true, dir: scratchDir(), unattended: true, reason: '' }
  } else {
    return {
      ok: false,
      dir: '',
      unattended: false,
      reason:
        'no working directory。宿主目前不把会话 cwd 传给插件工具，所以这个值必须由调用方给：' +
        '① 传 working_dir 指定一个已存在的绝对路径目录；② 在插件配置里设 cliBridge.workingDir；' +
        '③ 若本回合只是通用问答、不需要任何目录，传 allow_unattended: true' +
        '（会在一个临时目录里跑，该目录是它的读写边界，不碰你的 home 或会话工作区）。',
    }
  }

  if (!existsSync(chosen)) {
    return { ok: false, dir: '', unattended: false, reason: `working_dir "${chosen}" 不存在。` }
  }
  let isDir = false
  try {
    isDir = statSync(chosen).isDirectory()
  } catch (error) {
    return {
      ok: false,
      dir: '',
      unattended: false,
      reason: `working_dir "${chosen}" 无法读取：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!isDir) {
    return { ok: false, dir: '', unattended: false, reason: `working_dir "${chosen}" 不是一个目录。` }
  }

  // A turn called from a session may always run in that session, and the
  // configured default is trusted by definition (an operator wrote it).
  const roots: string[] = []
  if (sessionDir !== '') roots.push(sessionDir)
  if (options.workingDir !== '') roots.push(options.workingDir)
  roots.push(...options.allowedDirs)

  const allowed = roots.some(root => root !== '' && isInside(root, chosen))
  if (!allowed) {
    const listed = roots.filter(root => root !== '')
    return {
      ok: false,
      dir: '',
      unattended: false,
      reason:
        `working_dir "${chosen}" 不在本回合允许的范围内。` +
        (fromArgument
          ? '工具不能把可写文件的 agent 指向任意目录——请从下面这些根里选一个（或子目录），' +
            '要放开别的目录得在插件配置 cliBridge.allowedDirs 里显式列出。'
          : '') +
        (listed.length > 0
          ? `允许的根：${listed.join(' / ')}。`
          : '当前没有任何允许的根：本会话没有 cwd，配置里也没有 cliBridge.workingDir 或 cliBridge.allowedDirs。'),
    }
  }

  return { ok: true, dir: canonical(chosen), unattended: false, reason: '' }
}

/** The closed output schema the Host validates every result against. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '本回合是否正常完成' },
    reply: { type: 'string', description: 'CodeBuddy 的最终回复文本' },
    session_id: { type: 'string', description: '本回合的 CLI 会话 id；空字符串表示未报' },
    tools: {
      type: 'array',
      description: `本回合用过的工具及次数，最多 ${String(TOOLS_CAP)} 条（超出见 tool_calls，它是真实总数）`,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name', 'count'],
        additionalProperties: false,
      },
    },
    denied_tools: {
      type: 'array',
      description: '本回合 CLI 请求过、但被本插件拒绝的工具。非空说明它想动手但没被允许',
      items: { type: 'string' },
    },
    tool_calls: { type: 'number', description: '本回合工具调用总次数（tools 数组可能被截断，这个数是真实的）' },
    num_turns: { type: 'number', description: 'CLI 自报的 agent 轮数' },
    tokens_in: { type: 'number', description: '本回合输入 token 数（含缓存命中部分）' },
    tokens_out: { type: 'number', description: '本回合输出 token 数' },
    cache_read_tokens: {
      type: 'number',
      description: '输入里命中提示缓存的部分。它通常占 tokens_in 的绝大部分——名义输入看着很大，新增计费其实很小',
    },
    credential_region: { type: 'string', description: '本次实际用的凭据区域（cn / global / env）' },
    working_dir: { type: 'string', description: '本回合实际使用的工作目录（它的读写边界）；空字符串表示本回合在拒绝前就结束了' },
    unattended: {
      type: 'boolean',
      description: '本回合是否因为调用方传了 allow_unattended 而在临时目录里跑（工具可能在那里写文件）',
    },
    elapsed_ms: { type: 'number', description: '本回合墙钟毫秒数' },
    truncated: { type: 'boolean', description: 'reply 超过上限被截断（截断处有标记）；长内容应让它落盘再读' },
    error: { type: 'string', description: '失败原因；空字符串表示没有错误' },
  },
  required: [
    'ok',
    'reply',
    'session_id',
    'tools',
    'denied_tools',
    'tool_calls',
    'num_turns',
    'tokens_in',
    'tokens_out',
    'cache_read_tokens',
    'credential_region',
    'working_dir',
    'unattended',
    'elapsed_ms',
    'truncated',
    'error',
  ],
  additionalProperties: false,
} as const

/** What `mountAskTool` needs from the host half. */
export interface AskDeps {
  options: BridgeOptions
  regions: readonly BridgeCredentialRegion[]
  log: BridgeLog
  /** Shared by the tool and the command, so their budgets cannot drift apart. */
  gate?: TurnGate
  /**
   * Where live turns are announced for the composer readout.
   *
   * Optional so every existing caller (and every test that builds a `deps` by
   * hand) keeps working with no board at all — a turn then simply runs
   * unobserved, which is the pre-feature behaviour rather than an error.
   */
  live?: LiveBoard
}

/** The gate this call must pass, built once per normalized option set. */
export function gateFor(options: BridgeOptions): TurnGate {
  const limits: GateLimits = {
    perSessionPerHour: options.maxTurnsPerSessionHour,
    globalPerHour: options.maxTurnsPerHour,
    allowConcurrentPerSession: false,
  }
  return new TurnGate(limits)
}

/** The session key a call is charged to, from whichever handle it arrived on. */
function sessionKeyOf(execution: BridgeToolExecution | undefined, fallback: string): string {
  const id = execution?.agent?.id
  return typeof id === 'string' && id !== '' ? id : fallback
}

/**
 * Run one bridged turn and return the complete result object.
 *
 * Exported because the `/codebuddy` slash command needs the same turn with the
 * same validation — a command that re-implemented this would drift from the tool
 * the first time either side gained a knob.
 */
/**
 * Everything `runAsk` decided before the turn started.
 *
 * Passed as one object rather than as eight parameters so the live-turn branch
 * and the plain branch cannot drift apart: there is exactly one place that knows
 * what a turn was asked for.
 */
interface TurnRunContext {
  startedAt: number
  dir: WorkingDirChoice
  message: string
  effort: string
  mode: string
  modelArg: string
  effectiveMode: string
  /** The budget slot this turn holds; released by the caller, never here. */
  entry: { release(): void }
  liveTurn?: LiveTurn
}

/** The part of a turn that runs once the budget and the directory are settled. */
async function runAskTurn(
  args: Record<string, unknown>,
  execution: BridgeToolExecution | undefined,
  deps: AskDeps,
  context: TurnRunContext,
): Promise<AskResult> {
  const { startedAt, dir, message, effort, modelArg, effectiveMode, liveTurn } = context
  const { options, regions, log } = deps

  let credentials
  try {
    credentials = await resolveCredentials(regions, options.regionOrder, log)
  } catch (error) {
    return result({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }

  const sessionIdArg = typeof args['session_id'] === 'string' ? args['session_id'].trim() : ''
  const signal = execution?.signal

  // Continuation: an explicit `session_id` always wins, because the caller may be
  // deliberately branching to a different conversation. Otherwise `auto` picks up
  // whatever this DSH session ran last, so `/codebuddy` twice in a row shares one
  // CodeBuddy conversation without the model having to copy a uuid forward.
  const sessionKey = sessionKeyOf(execution, 'codebuddy_ask')
  const continuedSessionId =
    sessionIdArg !== ''
      ? sessionIdArg
      : options.sessionContinuity === 'auto'
        ? recallCliSession(sessionKey)
        : ''

  if (liveTurn !== undefined) liveTurn.phase = 'running'

  const outcome = await runAgent(
    {
      prompt: message,
      cwd: dir.dir,
      binary: options.binary,
      model: modelArg !== '' ? modelArg : options.model,
      permissionMode: effectiveMode,
      effort: effort !== '' ? effort : options.effort,
      appendSystemPrompt: options.appendSystemPrompt,
      maxTurns: clampInt(args['max_turns'], options.maxTurns, MAX_TURNS_CAP),
      timeoutMs: clampInt(args['timeout_secs'], options.timeoutSecs, TIMEOUT_SECS_CAP) * 1000,
      ...(continuedSessionId !== '' ? { sessionId: continuedSessionId } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(liveTurn === undefined
        ? {}
        : {
            onProgress: (progress: { toolCalls: number; lastTool: string; chars: number }) => {
              // Written in place: the board serializes this object on the route's
              // own thread, and copying it per frame would allocate for no reason.
              liveTurn.toolCalls = progress.toolCalls
              liveTurn.lastTool = progress.lastTool
              liveTurn.chars = progress.chars
            },
          }),
    },
    credentials,
    log,
  )

  // The CLI has answered; what is left is truncation and rendering, which is fast
  // but not instant on a 400 KB reply. Saying `finishing` keeps the chip honest
  // about the difference between "still working" and "about to disappear".
  if (liveTurn !== undefined) {
    liveTurn.phase = 'finishing'
    // NOT `liveTurn.sessionId = outcome.sessionId`. Those are two different ids:
    // the board's `sessionId` is the DSH session this turn belongs to (taken from
    // `execution.agent.id` when the row was opened, and what the composer pill
    // filters on), while `outcome.sessionId` is the CLI's OWN session uuid, which
    // is reported in the tool result as `session_id`. Overwriting one with the
    // other used to make every finished turn look like it belonged to a session
    // that does not exist, so the pill dropped its own row the moment the turn
    // started finishing.
  }

  let reply = outcome.text
  let truncated = false
  if (reply.length > options.maxReplyChars) {
    const omitted = reply.length - options.maxReplyChars
    reply =
      `${reply.slice(0, options.maxReplyChars)}\n\n` +
      `[truncated by dsh-connect-workbuddy: ${String(omitted)} more characters. ` +
      'Have CodeBuddy write the full text to a file and read it back.]'
    truncated = true
  }

  const tools = [...outcome.toolCounts.entries()]
    .slice(0, TOOLS_CAP)
    .map(([name, count]) => ({ name, count }))

  // Recorded even when the turn failed: a session the CLI opened is resumable
  // whether or not this particular turn reached a conclusion, and resuming it
  // next time is strictly better than re-exploring the workspace from zero.
  // Recorded regardless of `sessionContinuity`, because the setting decides what
  // is READ, not what is kept — flipping it back to `auto` then picks up the most
  // recent conversation instead of the one before the setting was turned off.
  rememberCliSession(sessionKey, outcome.sessionId ?? '')

  return result({
    ok: outcome.ok,
    reply,
    session_id: outcome.sessionId ?? '',
    tools,
    denied_tools: [...outcome.deniedTools],
    tool_calls: [...outcome.toolCounts.values()].reduce((sum, count) => sum + count, 0),
    num_turns: outcome.numTurns ?? 0,
    tokens_in: outcome.usage?.input_tokens ?? 0,
    tokens_out: outcome.usage?.output_tokens ?? 0,
    cache_read_tokens: outcome.usage?.cache_read_input_tokens ?? 0,
    credential_region: outcome.credential.region,
    working_dir: dir.dir,
    unattended: dir.unattended,
    elapsed_ms: Date.now() - startedAt,
    truncated,
    error: outcome.error ?? '',
  })
}

export async function runAsk(
  args: Record<string, unknown>,
  execution: BridgeToolExecution | undefined,
  deps: AskDeps,
  entrance: LiveEntrance = 'tool',
): Promise<AskResult> {
  const startedAt = Date.now()
  const { options, log } = deps

  const mode = typeof args['permission_mode'] === 'string' ? args['permission_mode'].trim() : ''
  if (mode !== '' && !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    return result({ ok: false, error: `permission_mode "${mode}" 不是合法值；合法值：${PERMISSION_MODES.join(', ')}` })
  }

  const effort = typeof args['effort'] === 'string' ? args['effort'].trim() : ''
  if (effort !== '' && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    return result({ ok: false, error: `effort "${effort}" 不是合法值；合法值：${EFFORT_LEVELS.join(', ')}` })
  }

  const message = typeof args['message'] === 'string' ? args['message'] : ''
  if (message.trim() === '') {
    return result({ ok: false, error: 'message 不能为空：要说清楚这一轮让 CodeBuddy 做什么。' })
  }

  const dir = resolveWorkingDir(args, options, execution)
  if (!dir.ok) return result({ ok: false, error: dir.reason })

  // Charge the budget BEFORE resolving credentials: the gate exists to bound how
  // often a spawned agent happens, and a call that fails during setup still cost
  // the user a decision to make it.
  const gate = deps.gate ?? gateFor(options)
  const entry = gate.tryEnter(sessionKeyOf(execution, 'codebuddy_ask'), message => log(message))
  if (!entry.ok) {
    // The directory above was already created for this turn. A refused turn must
    // not leave it behind: a client retrying against a full quota would otherwise
    // litter the OS temp directory with one empty directory per attempt — the
    // same class of leak that per-call `mkdtemp` was introduced to close.
    if (dir.unattended) removeScratch(dir.dir)
    return result({ ok: false, error: entry.error })
  }

  try {
    // Announced BEFORE the credential lookup: resolving across several regions
    // can take seconds, and a chip that only appears at spawn makes that window
    // look like the click was ignored. `phase` is what distinguishes the two.
    const modelArg = typeof args['model'] === 'string' ? args['model'].trim() : ''
    const effectiveMode = mode !== '' ? mode : options.permissionMode
    const liveTurn: LiveTurn | undefined = deps.live?.begin({
      entrance,
      workingDir: dir.dir,
      unattended: dir.unattended,
      permissionMode: effectiveMode,
      model: modelArg !== '' ? modelArg : options.model,
      ...(execution?.agent?.id !== undefined ? { sessionId: execution.agent.id } : {}),
    })
    try {
      return await runAskTurn(args, execution, deps, {
        startedAt,
        dir,
        message,
        effort,
        mode,
        modelArg,
        effectiveMode,
        entry,
        ...(liveTurn === undefined ? {} : { liveTurn }),
      })
    } catch (error) {
      // A thrown turn is reported as a failed RESULT, not as a rejection: the
      // tool contract is that the model reads why it failed and can retry, and a
      // rejected `execute` would surface as a crashed tool call instead.
      return result({ ok: false, error: error instanceof Error ? error.message : String(error), elapsed_ms: Date.now() - startedAt })
    } finally {
      // Retiring the turn is the LAST thing that happens, whatever path was
      // taken: a chip left behind by a thrown turn would sit on the composer
      // forever, describing work that already finished.
      if (liveTurn !== undefined) deps.live?.end(liveTurn)
    }
  } finally {
    entry.release()
    // A scratch directory is this turn's alone and holds nothing worth keeping.
    // Removing it here is also what stops a writable CLI turn from leaving
    // files behind in the OS temp directory for the next process to find.
    if (dir.unattended) removeScratch(dir.dir)
  }
}

/**
 * Register `codebuddy_ask`, returning the disposer.
 *
 * `tools` is passed in rather than looked up so a Host without the service
 * degrades to "no tool" instead of failing the mount.
 */
export function mountAskTool(tools: BridgeToolsService | undefined, deps: AskDeps): () => void {
  if (tools === undefined || typeof tools.register !== 'function') return () => {}

  try {
    return tools.register({
      name: 'codebuddy_ask',
      description:
        '把一个独立的任务交给本机的 CodeBuddy CLI 跑一轮完整 agent（它自己读文件、改文件、跑命令），返回它的结论。' +
        '适合"独立审一块代码 / 跑一轮调查 / 让另一个 agent 复核"，不适合"接着我们刚才的思路改"——它看不到本会话的对话，会重新探索工作区。' +
        `每次调用都会真实消耗一份 CodeBuddy 账号额度（一轮通常几万输入 token，多数命中缓存）；` +
        `本会话每小时上限 ${String(deps.options.maxTurnsPerSessionHour === 0 ? '不限' : deps.options.maxTurnsPerSessionHour)} 次、` +
        `全场每小时上限 ${String(deps.options.maxTurnsPerHour === 0 ? '不限' : deps.options.maxTurnsPerHour)} 次，超了会被具名拒绝。` +
        '默认只能在本会话的工作区（或在配置里显式列出的目录）里跑；要指定别处的目录得先把它加进 cliBridge.allowedDirs。',
      timeoutMs: (deps.options.timeoutSecs + 30) * 1000,
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: '交给 CodeBuddy 的完整任务描述。它看不到本会话，所以要自包含：目标、范围、验收标准。',
          },
          working_dir: {
            type: 'string',
            description:
              '本回合的工作目录（它的读写边界），必须是已存在的绝对路径，且落在本会话工作区或配置的 allowedDirs 之内。不传则用本会话的工作区。',
          },
          model: {
            type: 'string',
            description: `可选：本回合模型 id，默认取插件配置（当前 ${deps.options.model === '' ? 'CLI 自己的设置' : deps.options.model}）。`,
          },
          permission_mode: {
            type: 'string',
            description:
              '可选：本回合权限模式。默认取插件配置（dontAsk = 只读工具放行、写工具被拒，且不会卡住等审批）；' +
              'plan = 只读，纯审查可用（注意 plan 在 -p 下会请求 ExitPlanMode 审批，被拒才结束）；' +
              'acceptEdits = 允许改文件；bypassPermissions = 全部放行。default / auto 也接受。传其它值会被拒绝并列出合法值。',
          },
          effort: {
            type: 'string',
            description: `可选：本回合推理力度。合法值：${EFFORT_LEVELS.join(', ')}。不传取插件配置。`,
          },
          max_turns: {
            type: 'number',
            description: `可选：本回合 agent 轮数上限，默认取插件配置（当前 ${String(deps.options.maxTurns)}），上限 ${String(MAX_TURNS_CAP)}。用尽会标记为截断，不当作成功。`,
          },
          timeout_secs: {
            type: 'number',
            description: `可选：本回合墙钟超时秒数，默认取插件配置（当前 ${String(deps.options.timeoutSecs)}），上限 ${String(TIMEOUT_SECS_CAP)}；超时会被杀掉并报错。`,
          },
          session_id: {
            type: 'string',
            description:
              '可选：要续接的 CLI 会话 id。留空 = 由插件自动续接本会话上一轮的 CodeBuddy 对话'
              + '（cliBridge.sessionContinuity=auto 时；=off 时留空就是每次开新会话）。'
              + '只有想故意开一条新对话、或切到另一条对话时才显式传。',
          },
          allow_unattended: {
            type: 'boolean',
            description:
              '可选：本回合不需要任何目录时设为 true，会在一个临时目录里跑（该目录是它的读写边界）。默认 false：一个能改文件的 agent 不该被指向没人选过的目录。',
          },
        },
        required: ['message'],
      },
      output: {
        schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        render(_args: unknown, value: unknown) {
          const typed = value as AskResult
          if (!typed.ok) {
            return [{ type: 'text', text: `CodeBuddy 调用失败: ${typed.error === '' ? '(未给出原因)' : typed.error}` }]
          }
          const lines = ['CodeBuddy 回复:', typed.reply === '' ? '(空回复)' : typed.reply, '']
          if (typed.truncated) {
            lines.push('[注意：reply 已截断。让 CodeBuddy 把完整内容写到文件里再读，别只靠这一份摘要]', '')
          }
          if (typed.denied_tools.length > 0) {
            lines.push(
              `[注意：本回合 CodeBuddy 请求过这些工具但被拒绝：${typed.denied_tools.join(', ')}。` +
                '如果任务本来就要求它们动手，说明默认权限模式（dontAsk）挡住了——明确传 permission_mode 再试]',
              '',
            )
          }
          if (typed.unattended) {
            lines.push(
              `[注意：本回合未指定 working_dir，按调用方的 allow_unattended 在临时目录里执行（${typed.working_dir}）。` +
                '它读不到你的仓库；要针对某个仓库请显式传 working_dir]',
              '',
            )
          }
          const toolList =
            typed.tools.length > 0
              ? typed.tools.map(tool => (tool.count > 1 ? `${tool.name}×${String(tool.count)}` : tool.name)).join(', ')
              : '无'
          lines.push(
            `[session_id=${typed.session_id === '' ? '?' : typed.session_id} turns=${String(typed.num_turns)} tool_calls=${String(typed.tool_calls)} ` +
              `tools=${toolList} tokens=${String(typed.tokens_in)}in/${String(typed.tokens_out)}out ` +
              `(cache_read=${String(typed.cache_read_tokens)}) elapsed_ms=${String(typed.elapsed_ms)} cred=${typed.credential_region}` +
              (typed.working_dir !== '' ? ` dir=${typed.working_dir}` : '') +
              ']',
          )
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args: unknown, execution: BridgeToolExecution) {
        const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
        return runAsk(record, execution, deps)
      },
    })
  } catch (error) {
    deps.log(`tool registration failed: ${error instanceof Error ? error.message : String(error)}`)
    return () => {}
  }
}
