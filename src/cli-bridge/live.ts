/**
 * What the CLI route is doing RIGHT NOW, for the composer readout.
 *
 * WHY A SIDE CHANNEL AT ALL. A Host tool answers once: `execute()` returns a
 * value and the card is rendered from it. There is no progress channel on the
 * execution object (`{ signal, cwd, agent }` — see ./services.ts), so a turn that
 * runs for minutes is a black box for every one of them: the card sits on its
 * spinner and the user cannot tell a 40-second first token from a hung CLI. The
 * only place to say otherwise is a side channel the browser can read while the
 * turn is still running, which is what this module is: an in-memory board of live
 * turns, serialized by one read-only route (see ../web-status.ts) and polled by
 * the composer chip (../client/CodebuddyLive.tsx).
 *
 * WHY THE BOARD IS PER RUNTIME, NOT A MODULE SINGLETON. `createCliBridgeRuntime`
 * is rebuilt whenever the settings change, and the mount is re-run with it. A
 * module-level board would outlive that rebuild and keep describing turns that
 * belong to a runtime nothing reads any more; it would also leak between tests,
 * where two boards in one process are normal. The caller that owns the runtime
 * owns the board, and the route reads it through the same runtime reference.
 *
 * THE COST OF THAT CHOICE, stated rather than left to be discovered: a turn that
 * is already running when the settings change disappears from the readout. The
 * runner keeps writing into the old board object through its own closure, so
 * nothing crashes and nothing is corrupted — the pill simply stops mentioning a
 * turn that is still going, and the tool card remains the record of it. The
 * alternative (a module singleton) trades that for boards that outlive the
 * runtime that drives them, which is worse: it would report turns for options
 * that no longer apply, and it would keep a rebuild from ever starting clean.
 *
 * WHY COUNTS AND NAMES, NEVER CONTENT. The turn's answer is delivered once, in
 * full, through the tool result. Streaming a partial copy into the composer would
 * be a second, worse copy of a deliverable rendered somewhere nobody asked for —
 * and it would keep growing after the turn was truncated. `chars` is a count for
 * the same reason: it answers "is it producing anything" without shipping the
 * text.
 *
 * @module dsh-connect-workbuddy/cli-bridge/live
 */

/** Which entrance started the turn. Only ever used to label the readout. */
export type LiveEntrance = 'tool' | 'command'

/**
 * Where a turn is in its life.
 *
 * `starting` is the window before the CLI is spawned (credential resolution), and
 * it is a real phase rather than a rounding error: a vault with several regions
 * can spend seconds there, and a chip that only appears at spawn would look like
 * the click did nothing.
 */
export type LivePhase = 'starting' | 'running' | 'finishing'

/**
 * One turn as the host tracks it.
 *
 * Mutable on purpose: the runner writes `toolCalls`/`lastTool`/`chars` in place as
 * frames arrive, which is what makes the board cheap enough to update per frame
 * instead of per second.
 */
export interface LiveTurn {
  /** Opaque and unique within the process; the browser only echoes it back. */
  readonly id: string
  /** Epoch ms, taken BEFORE credential resolution — see `startedAt` below. */
  readonly startedAt: number
  readonly entrance: LiveEntrance
  workingDir: string
  unattended: boolean
  permissionMode: string
  model: string
  sessionId: string
  phase: LivePhase
  toolCalls: number
  lastTool: string
  chars: number
}

/** One turn as the browser receives it. `elapsedMs` is derived, never stored. */
export interface LiveTurnView {
  id: string
  startedAt: number
  elapsedMs: number
  entrance: LiveEntrance
  workingDir: string
  unattended: boolean
  permissionMode: string
  model: string
  sessionId: string
  phase: LivePhase
  toolCalls: number
  lastTool: string
  chars: number
}

/** The whole document the route answers with. */
export interface LiveSnapshot {
  turns: LiveTurnView[]
  /**
   * The host's clock when the document was built.
   *
   * Shipped so the browser can compute an age from its OWN clock against
   * `startedAt` without trusting the two machines to agree: a laptop whose clock
   * is a minute off would otherwise render a turn as starting in the future and
   * the chip would print a negative age.
   */
  serverTime: number
}

/** What `begin` needs; everything else starts at zero. */
export interface LiveTurnInput {
  entrance: LiveEntrance
  workingDir: string
  unattended: boolean
  permissionMode: string
  model: string
  sessionId?: string
}

/** The board the runtime owns. */
export interface LiveBoard {
  begin(input: LiveTurnInput): LiveTurn
  /** Retire a turn. Idempotent: a double `finally` must not remove a sibling. */
  end(turn: LiveTurn): void
  /** A consistent view at `now` (defaults to the host clock). */
  snapshot(now?: number): LiveSnapshot
  /** Live count, for the mount log line and for tests. */
  size(): number
}

/**
 * Build a board.
 *
 * Ordering is "oldest first", which is the order a human reads a queue in; the
 * chip draws the newest as the headline because that is the one the last click
 * started.
 */
export function createLiveBoard(): LiveBoard {
  const turns: LiveTurn[] = []
  let counter = 0

  const begin = (input: LiveTurnInput): LiveTurn => {
    counter += 1
    const startedAt = Date.now()
    const turn: LiveTurn = {
      // The counter alone is not enough across a runtime rebuild (a new board
      // restarts it), and the browser keys rows by this id, so the timestamp is
      // part of it. Base 36 keeps it short enough to read in a log line.
      id: `${startedAt.toString(36)}-${String(counter)}`,
      startedAt,
      entrance: input.entrance,
      workingDir: input.workingDir,
      unattended: input.unattended,
      permissionMode: input.permissionMode,
      model: input.model,
      sessionId: input.sessionId ?? '',
      phase: 'starting',
      toolCalls: 0,
      lastTool: '',
      chars: 0,
    }
    turns.push(turn)
    return turn
  }

  const end = (turn: LiveTurn): void => {
    const at = turns.indexOf(turn)
    if (at >= 0) turns.splice(at, 1)
  }

  const snapshot = (now: number = Date.now()): LiveSnapshot => ({
    turns: turns.map(turn => ({
      id: turn.id,
      startedAt: turn.startedAt,
      // Clamped at zero: a clock that stepped backwards (NTP correction, a
      // suspended laptop) must not print a negative age.
      elapsedMs: Math.max(0, now - turn.startedAt),
      entrance: turn.entrance,
      workingDir: turn.workingDir,
      unattended: turn.unattended,
      permissionMode: turn.permissionMode,
      model: turn.model,
      sessionId: turn.sessionId,
      phase: turn.phase,
      toolCalls: turn.toolCalls,
      lastTool: turn.lastTool,
      chars: turn.chars,
    })),
    serverTime: now,
  })

  return { begin, end, snapshot, size: () => turns.length }
}

/**
 * The route's document, tolerant of "the route exists but the route is off".
 *
 * `undefined` is the normal state when `cliBridge.enabled` is false: the route is
 * registered unconditionally (so toggling the feature does not re-register
 * routes), and this answers an empty document rather than a 404 or a 500. An
 * empty document is exactly what the chip needs to render nothing, and it keeps
 * the disabled state indistinguishable from "no turn running" — which is the
 * truth.
 */
export function liveDocument(board: LiveBoard | undefined, now: number = Date.now()): LiveSnapshot {
  return board === undefined ? { turns: [], serverTime: now } : board.snapshot(now)
}
