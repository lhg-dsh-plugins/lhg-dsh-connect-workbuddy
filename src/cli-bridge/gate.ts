/**
 * The gate every bridged turn passes through: one at a time per session, and a
 * bounded number per hour.
 *
 * WHY A GATE AND NOT JUST THE `inFlight` SET. The first draft only stopped two
 * `/codebuddy` lines from overlapping in the same session. That is the least
 * interesting case: the expensive one is a model that has just discovered
 * `codebuddy_ask` and calls it eight times in one turn, or a human pressing
 * enter every time the previous review lands. Each call spawns a full CodeBuddy
 * agent against the same account quota, and nothing in that loop is visible to
 * the human until the bill arrives.
 *
 * WHAT IS COUNTED. A turn is one accepted call, not one successful one: a
 * credential walk that 401s twice before working still spent two spawns. The
 * budget is therefore charged on ENTRY and kept even when the turn fails, which
 * is also what makes it a useful brake against a retry loop.
 *
 * WHAT IS NOT COUNTED. `0` means "no bound" for every limit, so an existing
 * config that never mentioned this gate keeps behaving exactly as before. The
 * defaults are bounded because a default that allows an unbounded spend is not a
 * default.
 *
 * @module dsh-connect-workbuddy/cli-bridge/gate
 */

/** Why a turn was not started. Named, so the refusal can say which limit. */
export interface GateRefusal {
  ok: false
  code: 'busy' | 'session-quota' | 'global-quota'
  error: string
}

/** A turn that may proceed. `release` must run in a `finally`. */
export interface GateEntry {
  ok: true
  release: () => void
}

export type GateDecision = GateEntry | GateRefusal

/** The limits, already normalized (0 = unbounded). */
export interface GateLimits {
  /** Turns per hour, per session. */
  perSessionPerHour: number
  /** Turns per hour, across every session in this process. */
  globalPerHour: number
  /** Whether a second turn in the same session may overlap the first. */
  allowConcurrentPerSession: boolean
}

/** Hour in milliseconds. */
const WINDOW_MS = 60 * 60 * 1000

/**
 * Tracks what has been spent in the last hour.
 *
 * Deliberately in-memory and per-process: a restart forgets the history, which
 * is the right failure direction (a restart cannot lock anyone out of their own
 * tool) and the honest scope for a plugin that cannot see other processes.
 */
export class TurnGate {
  /** Session key → arrival timestamps inside the window, oldest first. */
  private readonly perSession = new Map<string, number[]>()
  /** Every arrival in the window, oldest first. */
  private readonly global: number[] = []
  /** Session keys with a turn currently running. */
  private readonly running = new Set<string>()

  constructor(
    private readonly limits: GateLimits,
    /** Injectable so tests do not have to wait for wall-clock time. */
    private readonly now: () => number = Date.now,
  ) {}

  /** Drop everything older than the window. Called before every decision. */
  private prune(at: number): void {
    const cutoff = at - WINDOW_MS
    while (this.global.length > 0 && (this.global[0] ?? 0) <= cutoff) this.global.shift()
    for (const [key, arrivals] of this.perSession) {
      while (arrivals.length > 0 && (arrivals[0] ?? 0) <= cutoff) arrivals.shift()
      if (arrivals.length === 0) this.perSession.delete(key)
    }
  }

  /** Whether a turn is running in this session right now. */
  isBusy(sessionKey: string): boolean {
    return this.running.has(sessionKey)
  }

  /** How many turns this session has started inside the window. */
  spentBySession(sessionKey: string): number {
    this.prune(this.now())
    return this.perSession.get(sessionKey)?.length ?? 0
  }

  /** How many turns this process has started inside the window. */
  spentTotal(): number {
    this.prune(this.now())
    return this.global.length
  }

  /**
   * Ask to start a turn.
   *
   * On success the caller OWNS the slot until `release()` runs; on refusal
   * nothing was charged and nothing needs releasing.
   */
  tryEnter(sessionKey: string, onRefused: (message: string) => void): GateDecision {
    const at = this.now()
    this.prune(at)

    if (!this.limits.allowConcurrentPerSession && this.running.has(sessionKey)) {
      return {
        ok: false,
        code: 'busy',
        error: '这个会话已有一个 CodeBuddy 回合在跑，等它结束再发一次。',
      }
    }

    const { perSessionPerHour, globalPerHour } = this.limits
    if (perSessionPerHour > 0) {
      const spent = this.perSession.get(sessionKey)?.length ?? 0
      if (spent >= perSessionPerHour) {
        const message = `本会话最近一小时已经跑了 ${String(spent)} 次 CodeBuddy（上限 ${String(perSessionPerHour)} 次/小时）。等窗口过去，或调高插件配置 cliBridge.maxTurnsPerSessionHour。`
        onRefused(message)
        return { ok: false, code: 'session-quota', error: message }
      }
    }
    if (globalPerHour > 0 && this.global.length >= globalPerHour) {
      const message = `最近一小时全场已经跑了 ${String(this.global.length)} 次 CodeBuddy（上限 ${String(globalPerHour)} 次/小时）。等窗口过去，或调高插件配置 cliBridge.maxTurnsPerHour。`
      onRefused(message)
      return { ok: false, code: 'global-quota', error: message }
    }

    // Charge on entry: a turn that fails after three credential walks still
    // spent three spawns, so the budget must reflect the attempt, not the win.
    const arrivals = this.perSession.get(sessionKey) ?? []
    arrivals.push(at)
    this.perSession.set(sessionKey, arrivals)
    this.global.push(at)
    this.running.add(sessionKey)

    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        this.running.delete(sessionKey)
      },
    }
  }

  /** Forget every counter. Used by the mount's disposer. */
  clear(): void {
    this.perSession.clear()
    this.global.length = 0
    this.running.clear()
  }
}
