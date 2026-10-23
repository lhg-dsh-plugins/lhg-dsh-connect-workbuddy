/**
 * The live-turn board and the two places that announce into it.
 *
 * The board is what the composer pill reads (../src/client/CodebuddyLive.tsx via
 * the read-only route), so these tests are about the two properties the pill
 * cannot verify for itself: that a turn is on the board for EXACTLY as long as it
 * is running, and that nothing but counts and names is ever recorded.
 */
import { describe, expect, it, vi } from 'vitest'
import { createLiveBoard, liveDocument } from '../src/cli-bridge/live.ts'
import type { LiveBoard } from '../src/cli-bridge/live.ts'
import { CLI_BRIDGE_DEFAULTS } from '../src/cli-bridge/mount.ts'
import type { BridgeOptions } from '../src/cli-bridge/tool.ts'
import { runAsk } from '../src/cli-bridge/tool.ts'
import { mountCodebuddyCommand } from '../src/cli-bridge/command.ts'
import type { BridgeCommandsService } from '../src/cli-bridge/services.ts'

function options(overrides: Partial<BridgeOptions> = {}): BridgeOptions {
  return {
    enabled: true,
    binary: '',
    model: '',
    permissionMode: CLI_BRIDGE_DEFAULTS.permissionMode,
    effort: '',
    maxTurns: 10,
    timeoutSecs: 900,
    regionOrder: ['cn', 'global'],
    workingDir: '',
    allowedDirs: [],
    appendSystemPrompt: '',
    allowUnattended: false,
    maxReplyChars: 60_000,
    injectResult: true,
  sessionContinuity: 'auto',
    maxTurnsPerSessionHour: 6,
    maxTurnsPerHour: 20,
    ...overrides,
  }
}

describe('the live board', () => {
  it('announces a turn with its directory, mode and entrance, and no counts yet', () => {
    const board = createLiveBoard()
    board.begin({
      entrance: 'command',
      workingDir: 'C:/repo',
      unattended: false,
      permissionMode: 'dontAsk',
      model: 'deepseek-v4-flash',
    })

    const document = board.snapshot(1_000)
    expect(document.turns).toHaveLength(1)
    expect(document.turns[0]).toMatchObject({
      entrance: 'command',
      workingDir: 'C:/repo',
      permissionMode: 'dontAsk',
      model: 'deepseek-v4-flash',
      phase: 'starting',
      toolCalls: 0,
      lastTool: '',
      chars: 0,
    })
    expect(document.serverTime).toBe(1_000)
  })

  it('derives elapsed time from the start rather than storing it', () => {
    const board = createLiveBoard()
    const turn = board.begin({
      entrance: 'tool',
      workingDir: 'C:/repo',
      unattended: false,
      permissionMode: 'dontAsk',
      model: '',
    })
    const startedAt = turn.startedAt
    expect(board.snapshot(startedAt + 4_321).turns[0]?.elapsedMs).toBe(4_321)
  })

  it('clamps a backwards clock to zero instead of printing a negative age', () => {
    const board = createLiveBoard()
    const turn = board.begin({
      entrance: 'tool',
      workingDir: 'C:/repo',
      unattended: false,
      permissionMode: 'dontAsk',
      model: '',
    })
    // An NTP correction or a resumed laptop can make "now" precede the start.
    expect(board.snapshot(turn.startedAt - 5_000).turns[0]?.elapsedMs).toBe(0)
  })

  it('retires a turn, and a second retire cannot take a sibling with it', () => {
    const board = createLiveBoard()
    const input = {
      entrance: 'tool' as const,
      workingDir: 'C:/repo',
      unattended: false,
      permissionMode: 'dontAsk',
      model: '',
    }
    const first = board.begin(input)
    const second = board.begin(input)
    expect(board.size()).toBe(2)

    board.end(first)
    expect(board.snapshot().turns.map(turn => turn.id)).toEqual([second.id])
    // A `finally` that runs twice must not splice out the wrong entry: `end`
    // looks the turn up by identity, not by position.
    board.end(first)
    expect(board.size()).toBe(1)
    board.end(second)
    expect(board.size()).toBe(0)
  })

  it('gives every turn a distinct id, even when two start in the same millisecond', () => {
    const board = createLiveBoard()
    const input = {
      entrance: 'tool' as const,
      workingDir: 'C:/repo',
      unattended: false,
      permissionMode: 'dontAsk',
      model: '',
    }
    const ids = [board.begin(input).id, board.begin(input).id, board.begin(input).id]
    expect(new Set(ids).size).toBe(3)
  })

  it('carries the CLI session id once the turn has one', () => {
    const board = createLiveBoard()
    const turn = board.begin({
      entrance: 'tool',
      workingDir: 'C:/repo',
      unattended: false,
      permissionMode: 'dontAsk',
      model: '',
    })
    expect(board.snapshot().turns[0]?.sessionId).toBe('')
    turn.sessionId = 'session-9'
    expect(board.snapshot().turns[0]?.sessionId).toBe('session-9')
  })
})

describe('liveDocument', () => {
  it('answers an empty document when the bridge is switched off', () => {
    // The route is registered unconditionally, so "off" must be a 200 with
    // nothing in it rather than a 404 the pill would have to special-case.
    expect(liveDocument(undefined, 7_000)).toEqual({ turns: [], serverTime: 7_000 })
  })

  it('passes the board through when there is one', () => {
    const board = createLiveBoard()
    board.begin({
      entrance: 'tool',
      workingDir: 'C:/repo',
      unattended: false,
      permissionMode: 'dontAsk',
      model: '',
    })
    expect(liveDocument(board, 9_000).turns).toHaveLength(1)
    expect(liveDocument(board, 9_000).serverTime).toBe(9_000)
  })
})

/** A board that records what was done to it, without keeping any state. */
function spyBoard(): LiveBoard & { begun: unknown[]; ended: unknown[] } {
  const begun: unknown[] = []
  const ended: unknown[] = []
  return {
    begun,
    ended,
    begin(input) {
      const turn = {
        id: `spy-${String(begun.length)}`,
        startedAt: Date.now(),
        entrance: input.entrance,
        workingDir: input.workingDir,
        unattended: input.unattended,
        permissionMode: input.permissionMode,
        model: input.model,
        sessionId: input.sessionId ?? '',
        phase: 'starting' as const,
        toolCalls: 0,
        lastTool: '',
        chars: 0,
      }
      begun.push(turn)
      return turn
    },
    end(turn) {
      ended.push(turn)
    },
    snapshot() {
      return { turns: [], serverTime: Date.now() }
    },
    size() {
      return 0
    },
  }
}

describe('announcing a turn', () => {
  it('announces a tool turn and retires it even when the turn fails', async () => {
    const board = spyBoard()
    // No credentials: `runAsk` fails before spawning, which is exactly the path
    // a chip left behind would come from.
    const value = await runAsk({ message: 'look at this', working_dir: process.cwd() }, undefined, {
      options: options({ allowedDirs: [process.cwd()] }),
      regions: [],
      log: () => {},
      live: board,
    })

    expect(value.ok).toBe(false)
    expect(board.begun).toHaveLength(1)
    expect(board.begun[0]).toMatchObject({ entrance: 'tool', workingDir: process.cwd() })
    // Retired in `finally`, so a thrown or failed turn cannot leave a pill
    // describing work that already finished.
    expect(board.ended).toHaveLength(1)
    expect(board.ended[0]).toBe(board.begun[0])
  })

  it('labels a command turn as a command', async () => {
    const board = spyBoard()
    const registered: Array<{ handler: (invocation: unknown) => Promise<{ kind: string }> }> = []
    const service: BridgeCommandsService = {
      register: definition => {
        registered.push(definition as never)
        return () => {}
      },
    }
    mountCodebuddyCommand(service, {
      options: options(),
      regions: [],
      log: () => {},
      live: board,
    })

    const handler = registered[0]?.handler
    expect(handler).toBeDefined()
    await handler?.({
      agent: { id: 'session-1', session: { header: { cwd: process.cwd() } }, inject: vi.fn(), steer: vi.fn() },
      rawInput: 'do something',
    })

    expect(board.begun[0]).toMatchObject({ entrance: 'command' })
    expect(board.ended).toHaveLength(1)
  })

  it('runs unobserved when no board is supplied', async () => {
    // Every caller that predates the pill (and every hand-built test `deps`)
    // must keep working: no board means no announcement, not an error.
    const value = await runAsk({ message: 'look', working_dir: process.cwd() }, undefined, {
      options: options({ allowedDirs: [process.cwd()] }),
      regions: [],
      log: () => {},
    })
    expect(value.ok).toBe(false)
  })

  it('does not announce a turn the directory rule refused', async () => {
    // The announcement happens AFTER every precondition, so a call that never
    // becomes a turn cannot flash a pill for work that was never started.
    const board = spyBoard()
    const value = await runAsk({ message: 'look', working_dir: process.cwd() }, undefined, {
      options: options(),
      regions: [],
      log: () => {},
      live: board,
    })
    expect(value.ok).toBe(false)
    expect(value.error).toContain('不在本回合允许的范围内')
    expect(board.begun).toHaveLength(0)
  })
})
