/**
 * Wiring the CLI route into the plugin, and normalizing its settings.
 *
 * THE ROUTE IS OPT-IN AND NON-BREAKING. It is `enabled: false` by default, and
 * its two host surfaces are mounted reactively by the caller (`ctx.inject`), not
 * sampled once at apply time. That combination is deliberate: this plugin is
 * installed by people whose only interest is the provider, and a new hard
 * dependency would either fail their mount or silently remove their models.
 *
 * THE MOUNT IS TWO INDEPENDENT SURFACES ON PURPOSE. `codebuddy_ask` and
 * `/codebuddy` come from two different host services that become available at
 * different moments (and can come and go). So the settings are normalized ONCE
 * into a `CliBridgeRuntime` — options plus the shared turn gate — and each
 * surface mounts and disposes on its own. That is why the mid-sized fact "the
 * tool and the command share one budget" survives a re-mount: the gate lives on
 * the runtime, not on either surface.
 *
 * WHY THE ROUTE EXISTS AT ALL, stated honestly. The provider route has to look
 * like a CodeBuddy client to get past the gateway's channel check, and that is an
 * arms race the upstream fights with zero-width-space perturbation (see
 * `perturbChannelFingerprints`). This route does not impersonate anything — but
 * it uses the SAME vault account, so it is a client-fingerprint win, NOT a way
 * around an account restriction (code 11140). The first draft's README claimed
 * otherwise; do not let that claim come back.
 *
 * @module dsh-connect-workbuddy/cli-bridge/mount
 */
import { mountCodebuddyCommand } from './command.ts'
import type { BridgeCredentialRegion } from './credentials.ts'
import { createLiveBoard } from './live.ts'
import type { LiveBoard } from './live.ts'
import type { BridgeCommandsService, BridgeLog, BridgeToolsService } from './services.ts'
import { gateFor } from './tool.ts'
import { EFFORT_LEVELS, MAX_REPLY_CHARS_CAP, MAX_TURNS_CAP, PERMISSION_MODES, SESSION_CONTINUITY_MODES, TIMEOUT_SECS_CAP, mountAskTool } from './tool.ts'
import type { AskDeps, BridgeOptions } from './tool.ts'

/**
 * The `cliBridge` settings as they arrive from the config schema.
 *
 * Every field is optional because the schema may hand over a partial object, and
 * a user who edits only one key must not have to restate the rest.
 */
export interface CliBridgeSettings {
  enabled?: boolean
  binary?: string
  model?: string
  permissionMode?: string
  effort?: string
  maxTurns?: number
  timeoutSecs?: number
  regionOrder?: string
  workingDir?: string
  allowedDirs?: string
  appendSystemPrompt?: string
  allowUnattended?: boolean
  maxReplyChars?: number
  injectResult?: boolean
  sessionContinuity?: string
  maxTurnsPerSessionHour?: number
  maxTurnsPerHour?: number
}

/**
 * Defaults, mirroring the schema so a missing key behaves the same either way.
 *
 * `permissionMode` is `dontAsk`, NOT `acceptEdits` and not `plan`. Measured
 * against the real CLI under `-p`: `acceptEdits` lets the agent edit files in a
 * directory a model chose; `plan` asks the driver to approve an `ExitPlanMode`
 * hand-off and a bridge can only deny it, so the turn dies without findings;
 * `dontAsk` auto-approves the read half and refuses the write half without ever
 * waiting for a human. That is the only one of the three that is both safe and
 * useful when nobody is watching.
 */
export const CLI_BRIDGE_DEFAULTS = {
  enabled: false,
  binary: '',
  model: '',
  permissionMode: 'dontAsk',
  effort: '',
  maxTurns: 10,
  timeoutSecs: 900,
  regionOrder: 'cn,global',
  workingDir: '',
  allowedDirs: '',
  appendSystemPrompt: '',
  allowUnattended: false,
  maxReplyChars: 60_000,
  injectResult: true,
  // `auto`: a second `/codebuddy` in the same session continues the first one's
  // conversation instead of re-exploring the workspace. Measured to work through
  // `--session-id <existing>`. `off` restores one-shot calls for anyone who wants
  // each turn to be independent.
  sessionContinuity: 'auto',
  // Bounded by default: an unbounded default is how one curious model turns a
  // feature into a bill. 0 would mean "no limit" if a user insists.
  maxTurnsPerSessionHour: 6,
  maxTurnsPerHour: 20,
} as const

/** Clamp an optional number to a default and a hard ceiling. */
function clampInt(value: unknown, fallback: number, cap: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(cap, number))
}

/** Read a non-negative integer setting where 0 legitimately means "unbounded". */
function clampQuota(value: unknown, fallback: number): number {
  if (value === 0) return 0
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(0, number)
}

/** Read a string setting, trimmed, falling back when it is not a string. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Split a comma-separated list, dropping empties. */
function list(value: string): readonly string[] {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
}

/**
 * Turn raw settings into the normalized options one turn runs on.
 *
 * An out-of-range enum is REPORTED and then replaced by the default rather than
 * rejected: a typo in `permissionMode` should not take the whole plugin down, but
 * it must not silently run under a permission level the user did not pick
 * either. `onRejected` is how the caller turns that into a log line.
 */
export function normalizeCliBridgeOptions(
  settings: CliBridgeSettings | undefined,
  onRejected?: (message: string) => void,
): BridgeOptions {
  const raw = settings ?? {}
  const reject = onRejected ?? (() => {})

  const permissionMode = text(raw.permissionMode, CLI_BRIDGE_DEFAULTS.permissionMode)
  const safePermissionMode = (PERMISSION_MODES as readonly string[]).includes(permissionMode)
    ? permissionMode
    : CLI_BRIDGE_DEFAULTS.permissionMode
  if (safePermissionMode !== permissionMode) {
    reject(`permissionMode "${permissionMode}" 不是合法值，已回退到 ${safePermissionMode}；合法值：${PERMISSION_MODES.join(', ')}`)
  }

  const effort = text(raw.effort, CLI_BRIDGE_DEFAULTS.effort)
  const safeEffort = effort === '' || (EFFORT_LEVELS as readonly string[]).includes(effort) ? effort : ''
  if (safeEffort !== effort) {
    reject(`effort "${effort}" 不是合法值，已回退到 CLI 默认；合法值：${EFFORT_LEVELS.join(', ')}`)
  }

  const regionOrder = text(raw.regionOrder, CLI_BRIDGE_DEFAULTS.regionOrder)
  const sessionContinuity = text(raw.sessionContinuity, CLI_BRIDGE_DEFAULTS.sessionContinuity)
  const safeSessionContinuity = (SESSION_CONTINUITY_MODES as readonly string[]).includes(sessionContinuity)
    ? (sessionContinuity as (typeof SESSION_CONTINUITY_MODES)[number])
    : CLI_BRIDGE_DEFAULTS.sessionContinuity
  if (safeSessionContinuity !== sessionContinuity) {
    reject(
      `sessionContinuity "${sessionContinuity}" 不是合法值，已回退到 ${CLI_BRIDGE_DEFAULTS.sessionContinuity}；` +
        `合法值：${SESSION_CONTINUITY_MODES.join(', ')}`,
    )
  }
  return {
    enabled: raw.enabled === true,
    binary: text(raw.binary, CLI_BRIDGE_DEFAULTS.binary),
    model: text(raw.model, CLI_BRIDGE_DEFAULTS.model),
    permissionMode: safePermissionMode,
    effort: safeEffort,
    maxTurns: clampInt(raw.maxTurns, CLI_BRIDGE_DEFAULTS.maxTurns, MAX_TURNS_CAP),
    timeoutSecs: clampInt(raw.timeoutSecs, CLI_BRIDGE_DEFAULTS.timeoutSecs, TIMEOUT_SECS_CAP),
    regionOrder: list(regionOrder),
    workingDir: text(raw.workingDir, CLI_BRIDGE_DEFAULTS.workingDir),
    allowedDirs: list(text(raw.allowedDirs, CLI_BRIDGE_DEFAULTS.allowedDirs)),
    appendSystemPrompt: text(raw.appendSystemPrompt, CLI_BRIDGE_DEFAULTS.appendSystemPrompt),
    allowUnattended: raw.allowUnattended === true,
    maxReplyChars: clampInt(raw.maxReplyChars, CLI_BRIDGE_DEFAULTS.maxReplyChars, MAX_REPLY_CHARS_CAP),
    injectResult: raw.injectResult !== false,
    sessionContinuity: safeSessionContinuity,
    maxTurnsPerSessionHour: clampQuota(raw.maxTurnsPerSessionHour, CLI_BRIDGE_DEFAULTS.maxTurnsPerSessionHour),
    maxTurnsPerHour: clampQuota(raw.maxTurnsPerHour, CLI_BRIDGE_DEFAULTS.maxTurnsPerHour),
  }
}

/**
 * The normalized state both surfaces share.
 *
 * Built once by the caller, so a re-mount of one surface cannot reset the other's
 * budget or change its options mid-flight.
 */
export interface CliBridgeRuntime {
  options: BridgeOptions
  deps: AskDeps
  /**
   * The live-turn board the composer readout polls.
   *
   * Owned by the runtime so it is rebuilt with it: a settings change replaces the
   * runtime, and a board carried over would keep describing turns whose options
   * no longer apply. It is NOT part of `deps` for the same reason the gate is
   * built here — both surfaces must announce into the same board, and there must
   * be exactly one.
   */
  live: LiveBoard
}

/**
 * Build the runtime, or `undefined` when the route is disabled.
 *
 * Returning `undefined` rather than an enabled flag keeps every caller honest:
 * there is no "mounted but disabled" state to accidentally treat as live.
 */
export function createCliBridgeRuntime(
  settings: CliBridgeSettings | undefined,
  regions: readonly BridgeCredentialRegion[],
  log: BridgeLog,
): CliBridgeRuntime | undefined {
  const options = normalizeCliBridgeOptions(settings, message => log(message))
  if (!options.enabled) return undefined
  const live = createLiveBoard()
  // One gate for both surfaces: the budget must not depend on which entrance the
  // call arrived through.
  return { options, deps: { options, regions, log, gate: gateFor(options), live }, live }
}

/** Mount `codebuddy_ask` on a tools service, returning its disposer. */
export function mountToolSurface(runtime: CliBridgeRuntime, tools: BridgeToolsService | undefined): () => void {
  return mountAskTool(tools, runtime.deps)
}

/** Mount `/codebuddy` on a commands service, returning its disposer. */
export function mountCommandSurface(runtime: CliBridgeRuntime, commands: BridgeCommandsService | undefined): () => void {
  return mountCodebuddyCommand(commands, runtime.deps)
}

/** Everything the one-shot mount needs, resolved by the caller. */
export interface CliBridgeMountInput {
  settings: CliBridgeSettings | undefined
  /** Region-scoped credential stores, in the order the plugin built them. */
  regions: readonly BridgeCredentialRegion[]
  log: BridgeLog
  /** Optional host services; absent means "this Host has no such surface". */
  tools: BridgeToolsService | undefined
  commands: BridgeCommandsService | undefined
}

/**
 * Mount both surfaces at once, returning one disposer.
 *
 * For hosts that hand over both services in the same breath (and for tests). The
 * plugin itself uses `createCliBridgeRuntime` plus the two surface mounts, so a
 * surface that appears later can be attached without re-mounting the other.
 */
export function mountCliBridge(input: CliBridgeMountInput): () => void {
  const runtime = createCliBridgeRuntime(input.settings, input.regions, input.log)
  if (runtime === undefined) return () => {}

  const disposeTool = mountToolSurface(runtime, input.tools)
  const disposeCommand = mountCommandSurface(runtime, input.commands)

  const { options } = runtime
  const surfaces = [input.tools === undefined ? '' : 'codebuddy_ask', input.commands === undefined ? '' : '/codebuddy']
    .filter(part => part !== '')
    .join(' + ')
  input.log(
    surfaces === ''
      ? 'CLI 路线已开启，但这个宿主既没有 tools 也没有 commands 服务，两个入口都没挂上'
      : `CLI 路线已开启：${surfaces}（权限模式 ${options.permissionMode}，模型 ${options.model === '' ? 'CLI 默认' : options.model}，` +
        `每小时上限 ${String(options.maxTurnsPerSessionHour)} 次/会话、${String(options.maxTurnsPerHour)} 次/全场）`,
  )

  return () => {
    disposeCommand()
    disposeTool()
    runtime.deps.gate?.clear()
  }
}
