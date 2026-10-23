/**
 * The half of the CLI route that actually runs a process: `runAgent` /
 * `runOneTurn` in `src/cli-bridge/runner.ts`.
 *
 * WHY THIS FILE EXISTS AT ALL. The first draft shipped 53 tests and not one of
 * them ever reached `spawn`. Every defect the maintainer found in the runner —
 * the permission handshake hanging, the credential walk continuing after a
 * timeout, stderr ending up in the transcript unredacted, the read buffers
 * having no ceiling — lived exactly in that blind spot. So the child process is
 * mocked here and those paths are asserted by name.
 *
 * WHY A MOCK INSTEAD OF THE REAL CLI. A test suite must not need a CodeBuddy
 * install, a vault account and the upstream gateway to pass, and it must not
 * spend an account quota on every CI run. What is worth pinning down is the
 * PROTOCOL this module speaks, and that is fully observable from the frames a
 * fake child emits.
 */
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const FAKE_HOME = vi.hoisted(() => 'C:\\Users\\tester')

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// The CLI-location list is built from `homedir()`, which must not be the machine
// running the suite: otherwise the Windows-root assertion would pass on a
// developer box and silently assert nothing on CI.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})

// Imported AFTER the mock is registered, which is what makes the module under
// test pick up the fake `spawn`.
import { cliEntryCandidates, isSyntheticDenyReason, looksLikeAuthFailure, runAgent, MAX_FRAME_BYTES } from '../src/cli-bridge/runner.ts'
import type { BridgeCredential, TurnOptions } from '../src/cli-bridge/runner.ts'
import { createLiveBoard } from '../src/cli-bridge/live.ts'
import type { LiveTurn } from '../src/cli-bridge/live.ts'
import { forgetCliSession, runAsk } from '../src/cli-bridge/tool.ts'
import type { BridgeOptions } from '../src/cli-bridge/tool.ts'

/** One fake child process, with the pieces `runner.ts` touches. */
interface FakeChild {
  pid: number
  stdin: {
    writes: string[]
    write: (chunk: string) => boolean
    end: () => void
    on: (event: string, listener: (...args: unknown[]) => void) => void
    ended: boolean
  }
  stdout: {
    setEncoding: () => void
    on: (event: string, listener: (chunk: string) => void) => void
  }
  stderr: {
    setEncoding: () => void
    on: (event: string, listener: (chunk: string) => void) => void
  }
  killed: boolean
  kill: () => boolean
  on: (event: string, listener: (...args: unknown[]) => void) => void
  /** Push a parsed frame to stdout as one NDJSON line. */
  emitFrame: (frame: unknown) => void
  /** Push raw bytes to stdout (for the "line too long" case). */
  emitRaw: (text: string) => void
  emitStderr: (text: string) => void
  close: (code: number | null) => void
  writesAfterEnd: () => string[]
}

function fakeChild(pid = 4242): FakeChild {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const stderrListeners: Array<(chunk: string) => void> = []
  const closeListeners: Array<(...args: unknown[]) => void> = []
  const errorListeners: Array<(...args: unknown[]) => void> = []

  const child: FakeChild = {
    pid,
    stdin: {
      writes: [],
      ended: false,
      write(chunk: string) {
        child.stdin.writes.push(chunk)
        return true
      },
      end() {
        child.stdin.ended = true
      },
      on() {},
    },
    stdout: {
      setEncoding() {},
      on(_event, listener) {
        stdoutListeners.push(listener)
      },
    },
    stderr: {
      setEncoding() {},
      on(_event, listener) {
        stderrListeners.push(listener)
      },
    },
    killed: false,
    kill() {
      child.killed = true
      return true
    },
    on(event, listener) {
      if (event === 'close') closeListeners.push(listener)
      if (event === 'error') errorListeners.push(listener)
    },
    emitFrame(frame) {
      const line = `${JSON.stringify(frame)}\n`
      for (const listener of stdoutListeners) listener(line)
    },
    emitRaw(text) {
      for (const listener of stdoutListeners) listener(text)
    },
    emitStderr(text) {
      for (const listener of stderrListeners) listener(text)
    },
    close(code) {
      for (const listener of closeListeners) listener(code)
    },
    /** Writes that arrived after `stdin.end()`, which would be a protocol bug. */
    writesAfterEnd() {
      // `stdin.end()` is only ever called at settle/fail time in runner.ts, so a
      // later write is only reachable through the deny path. Asserted instead as
      // "the deny went out before the end", which the tests check directly.
      return []
    },
  }
  void errorListeners
  return child
}

/** The options one turn needs, with the CLI entry pointed at a real file. */
function turnOptions(entry: string, overrides: Partial<TurnOptions> = {}): TurnOptions {
  return {
    prompt: 'do the thing',
    cwd: process.cwd(),
    binary: entry,
    model: '',
    permissionMode: 'dontAsk',
    effort: '',
    maxTurns: 3,
    timeoutMs: 5_000,
    appendSystemPrompt: '',
    ...overrides,
  }
}

const credential: BridgeCredential = { token: 'token-abcdef123456', source: 'cn/one', region: 'cn', expired: false }

let dir = ''
let entry = ''

beforeEach(async () => {
  spawnMock.mockReset()
  dir = await mkdtemp(join(tmpdir(), 'wb-cli-bridge-'))
  entry = join(dir, 'codebuddy')
  // `resolveCliEntry` takes an explicit path literally, but only after it exists.
  await writeFile(entry, '#!/usr/bin/env node\n')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Make the next spawn return this fake child. */
function useChild(child: FakeChild): void {
  spawnMock.mockImplementation(() => child)
}

/** Frames a real CLI emits before the turn's result, kept minimal. */
function initFrames(child: FakeChild): void {
  child.emitFrame({ type: 'system', subtype: 'init', session_id: 'session-1' })
}

describe('runOneTurn protocol', () => {
  it('keeps stdin open and answers every permission request with a REAL denial', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry), [credential], () => {})

    initFrames(child)
    child.emitFrame({
      type: 'control_request',
      request_id: 'perm_1',
      request: { subtype: 'can_use_tool', tool_name: 'Write' },
    })

    // The denial is answered ON stdin, while the turn is still running.
    const denial = child.stdin.writes
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(frame => frame['type'] === 'control_response')
    expect(denial).toBeDefined()
    const response = denial!['response'] as Record<string, unknown>
    expect(response['subtype']).toBe('success')
    expect(response['request_id']).toBe('perm_1')
    const decision = response['response'] as Record<string, unknown>
    expect(decision['allowed']).toBe(false)
    // INTERRUPT IS PER-TOOL. For an ordinary tool the CLI records the denial and
    // tries something else, so the turn still produces a reply; setting
    // `interrupt: true` here would abort the whole turn (measured against the
    // real CLI: acceptEdits + Bash denial → is_error, empty reply, 4.2s). Only
    // `ExitPlanMode` needs it — see the next test.
    expect(decision['interrupt']).toBeUndefined()
    // A reason the CLI reads as synthetic would be IGNORED — i.e. the tool would
    // proceed as if allowed. Never ship such a reason.
    expect(isSyntheticDenyReason(String(decision['reason']))).toBe(false)

    // Nothing has ended stdin yet: the prompt was written, the pipe stays open.
    expect(child.stdin.ended).toBe(false)

    child.emitFrame({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })
    child.emitFrame({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'done' })
    const outcome = await running

    expect(outcome.ok).toBe(true)
    expect(outcome.text).toBe('done')
    expect(outcome.deniedTools).toEqual(['Write'])
    // The prompt travelled on stdin, and stdin is closed only after `result`.
    expect(child.stdin.writes[0]).toContain('"type":"user"')
    expect(child.stdin.writes[0]).toContain('do the thing')
    expect(child.stdin.ended).toBe(true)
  })

  it('adds interrupt ONLY for ExitPlanMode, which otherwise wedges plan mode', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry), [credential], () => {})

    initFrames(child)
    child.emitFrame({
      type: 'control_request',
      request_id: 'perm_plan',
      request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode' },
    })

    const denial = child.stdin.writes
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(frame => frame['type'] === 'control_response')
    expect(denial).toBeDefined()
    const decision = (denial!['response'] as Record<string, unknown>)['response'] as Record<string, unknown>
    expect(decision['allowed']).toBe(false)
    // Measured: deny WITHOUT interrupt in `plan` mode hangs >70s until timeout;
    // with it the turn ends in milliseconds.
    expect(decision['interrupt']).toBe(true)

    child.emitFrame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok' })
    const outcome = await running
    expect(outcome.deniedTools).toEqual(['ExitPlanMode'])
  })

  it('counts tool_use blocks and keeps every assistant text block', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry), [credential], () => {})
    initFrames(child)
    child.emitFrame({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Grep' },
          { type: 'text', text: 'second' },
        ],
      },
    })
    child.emitFrame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 })
    const outcome = await running
    expect(outcome.text).toBe('first\nsecond')
    expect([...outcome.toolCounts.entries()]).toEqual([['Read', 2], ['Grep', 1]])
  })

  it('reads usage, session id and the error channel off the result frame', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry), [credential], () => {})
    initFrames(child)
    child.emitFrame({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 4,
      session_id: 'session-9',
      errors: ['boom'],
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7 },
    })
    const outcome = await running
    expect(outcome.ok).toBe(false)
    expect(outcome.sessionId).toBe('session-9')
    expect(outcome.numTurns).toBe(4)
    expect(outcome.usage?.cache_read_input_tokens).toBe(7)
    expect(outcome.error).toContain('boom')
  })

  it('redacts the credential and any token-shaped text from everything it returns', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry), [credential], () => {})
    initFrames(child)
    child.emitFrame({
      type: 'assistant',
      message: {
        content: [
          // A CLI that echoes its own environment must not put the token in the
          // transcript, where it survives in the session history forever.
          { type: 'text', text: `the env had ${credential.token} in it` },
          { type: 'text', text: 'and a bearer: Bearer aaaaaaaaaaaaaaaaaaaa' },
        ],
      },
    })
    child.emitFrame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, errors: [`401 for ${credential.token}`] })
    const outcome = await running
    expect(outcome.text).not.toContain(credential.token)
    expect(outcome.text).toContain('[redacted credential]')
    expect(outcome.text).not.toContain('aaaaaaaaaaaaaaaaaaaa')
    // The result-frame errors take the same treatment: the credential is in this
    // process's environment, so it can appear in any channel the CLI prints.
    expect(String(outcome.error)).not.toContain(credential.token)
  })

  it('fails on a single absurdly long line instead of buffering it forever', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry), [credential], () => {})
    initFrames(child)
    child.emitRaw('x'.repeat(MAX_FRAME_BYTES + 1))
    await expect(running).rejects.toThrow(/longer than/)
    expect(child.stdin.ended).toBe(true)
  })

  it('fails when the process exits without a result frame, and keeps the stderr tail', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry), [credential], () => {})
    initFrames(child)
    child.emitStderr('Error: cannot find module\n  at somewhere')
    child.close(1)
    await expect(running).rejects.toThrow(/exited with code 1 and emitted no result frame/)
    await expect(running).rejects.toThrow(/cannot find module/)
  })

  it('fails on its own timeout and takes the process tree down', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry, { timeoutMs: 30 }), [credential], () => {})
    initFrames(child)
    await expect(running).rejects.toThrow(/exceeded its/)
    expect(child.stdin.ended).toBe(true)
    // On Windows the tree is taken down through taskkill; either way something
    // was killed rather than the child being left to run.
    const killed = child.killed || spawnMock.mock.calls.some(call => call[0] === 'taskkill')
    expect(killed).toBe(true)
  })

  it('honours a host cancellation and reports it as such', async () => {
    const child = fakeChild()
    useChild(child)
    const controller = new AbortController()
    const running = runAgent(turnOptions(entry, { signal: controller.signal }), [credential], () => {})
    initFrames(child)
    controller.abort()
    await expect(running).rejects.toThrow('cancelled by the host')
  })

  it('reports a missing CLI instead of spawning whatever is on PATH', async () => {
    const missing = join(dir, 'nope', 'codebuddy')
    await expect(runAgent(turnOptions(missing), [credential], () => {})).rejects.toThrow(/不存在/)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('runAgent credential walk', () => {
  it('moves to the next account ONLY on a recognised credential refusal', async () => {
    // Realistic pids, NOT 1/2: `killTree` feeds this pid to `process.kill(-pid)` as a real
    // process-group id, so a fabricated low pid escapes the mock and signals the actual OS.
    const first = fakeChild(51_001)
    const second = fakeChild(51_002)
    spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second)
    const other: BridgeCredential = { token: 'token-zzzzzzzzzzzz', source: 'global/two', region: 'global', expired: false }

    const running = runAgent(turnOptions(entry), [credential, other], () => {})
    first.emitFrame({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['401 Authentication required. Please use /login command to sign in'],
    })
    // The second credential answers properly.
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    second.emitFrame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 })
    second.emitFrame({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })

    const outcome = await running
    expect(outcome.credential.region).toBe('global')
    expect(outcome.ok).toBe(true)
  })

  it('does NOT burn another account on a timeout or a crash', async () => {
    const first = fakeChild(51_001)
    useChild(first)
    /** Spawns of the CLI itself, ignoring the Windows `taskkill` used to clean up. */
    const cliSpawns = (): number =>
      spawnMock.mock.calls.filter(call => !String(call[0]).endsWith('taskkill')).length
    // Two credentials are available; a timeout on the first attempt must not
    // become two 900-second attempts.
    await expect(
      (async () => {
        const running = runAgent(turnOptions(entry, { timeoutMs: 30 }), [credential, credential], () => {})
        first.emitFrame({ type: 'system', subtype: 'init' })
        return running
      })(),
    ).rejects.toThrow(/exceeded its/)
    expect(cliSpawns()).toBe(1)
  })

  it('does not retry the LAST account either, so a 401 with one account fails fast', async () => {
    const only = fakeChild(51_001)
    useChild(only)
    const running = runAgent(turnOptions(entry), [credential], () => {})
    only.emitFrame({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['401 Authentication required'] })
    const outcome = await running
    expect(outcome.ok).toBe(false)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to walk when there is no credential at all', async () => {
    await expect(runAgent(turnOptions(entry), [], () => {})).rejects.toThrow(/no credential worked/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('never turns a child pid of 1 into a signal for every process of the user', async () => {
    // Regression, with a real blast radius: a fake (or already-reaped) child can report
    // `pid: 1`, and `process.kill(-1, 'SIGTERM')` does not fail for it — it signals EVERY
    // process this user may signal. On a desktop that is the whole login session: Finder,
    // Dock, the user's chat apps, and every running DSH host all died, then DSH relaunched
    // and looked like it was "restarting itself". The guard must degrade to the single-child
    // kill instead of aiming at a non-positive process group.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const only = fakeChild(1)
      useChild(only)
      await expect(
        runAgent(turnOptions(entry, { timeoutMs: 30 }), [credential], () => {}),
      ).rejects.toThrow(/exceeded its/)
      const targets = killSpy.mock.calls.map(([target]) => target)
      expect(targets.filter(target => typeof target === 'number' && target < 0)).toEqual([])
      expect(only.killed).toBe(true)
    } finally {
      killSpy.mockRestore()
    }
  })
})

describe('looksLikeAuthFailure', () => {
  it('reads only the CLI error channel, never the assistant正文', () => {
    // A review that simply QUOTES an HTTP 401 in its own prose must not be read
    // as "the token was refused" — that used to discard a good turn and re-run
    // it on the next account.
    expect(looksLikeAuthFailure({ isError: false, errors: [], subtype: 'success' })).toBe(false)
    expect(looksLikeAuthFailure({ isError: true, errors: ['401 Authentication required'], subtype: undefined })).toBe(true)
    expect(looksLikeAuthFailure({ isError: true, errors: ['please run the /login command'], subtype: undefined })).toBe(true)
    expect(looksLikeAuthFailure({ isError: true, errors: ['invalid_api_key'], subtype: undefined })).toBe(true)
    // Non-credential failures stay put: a 429 or a model error would just burn
    // the next account's quota for the same answer.
    expect(looksLikeAuthFailure({ isError: true, errors: ['429 rate limited'], subtype: undefined })).toBe(false)
    expect(looksLikeAuthFailure({ isError: true, errors: [], subtype: 'error_during_execution' })).toBe(false)
  })
})

describe('isSyntheticDenyReason', () => {
  it('rejects the prefixes the CLI silently ignores', () => {
    // Those reasons mean "the human went away", not "the human said no" — the
    // CLI drops the denial and lets the tool run.
    expect(isSyntheticDenyReason('cancelled')).toBe(true)
    expect(isSyntheticDenyReason('Cancelled by user')).toBe(true)
    expect(isSyntheticDenyReason('timeout waiting for user response')).toBe(true)
    expect(isSyntheticDenyReason('This is an unattended automated session.')).toBe(true)
    expect(isSyntheticDenyReason('dsh-connect-workbuddy runs this turn unattended')).toBe(false)
  })
})

/**
 * The CLI-location list, which had no test at all in the first draft — and that
 * is exactly how a list that finds the CLI on no Windows machine shipped with a
 * green windows-latest CI leg.
 */
describe('cliEntryCandidates', () => {
  const PKG = join('@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy')
  const withAppData = (value: string | undefined, body: () => void): void => {
    const previous = process.env['APPDATA']
    if (value === undefined) delete process.env['APPDATA']
    else process.env['APPDATA'] = value
    try {
      body()
    } finally {
      if (previous === undefined) delete process.env['APPDATA']
      else process.env['APPDATA'] = previous
    }
  }

  it('looks directly under the Windows npm prefix, with no lib level', () => {
    withAppData('C:\\Users\\tester\\AppData\\Roaming', () => {
      const candidates = cliEntryCandidates()
      const prefix = join('C:\\Users\\tester\\AppData\\Roaming', 'npm')
      // What actually exists on a Windows machine.
      expect(candidates).toContain(join(prefix, 'node_modules', PKG))
      // What does not, and what an earlier revision wrongly built.
      expect(candidates).not.toContain(join(prefix, 'lib', 'node_modules', PKG))
    })
  })

  it('keeps the lib/node_modules layout for POSIX prefixes', () => {
    const candidates = cliEntryCandidates()
    for (const prefix of ['/usr/local', '/opt/homebrew', join(FAKE_HOME, '.npm-global')]) {
      expect(candidates).toContain(join(prefix, 'lib', 'node_modules', PKG))
    }
  })

  it('treats the pnpm and yarn stores as module roots themselves', () => {
    const candidates = cliEntryCandidates()
    expect(candidates).toContain(join(FAKE_HOME, '.local', 'share', 'pnpm', 'global', '5', 'node_modules', PKG))
    expect(candidates).toContain(join(FAKE_HOME, '.config', 'yarn', 'global', 'node_modules', PKG))
  })

  it('probes each distinct path once', () => {
    // `%APPDATA%\npm` and `~/AppData/Roaming/npm` are the same directory on a
    // normal Windows machine; the list must not claim to have tried it twice.
    withAppData(join(FAKE_HOME, 'AppData', 'Roaming'), () => {
      const candidates = cliEntryCandidates()
      expect(new Set(candidates).size).toBe(candidates.length)
    })
  })

  it('finds the Windows pnpm, yarn and fnm stores where those tools put them', async () => {
    // The same defect as the npm prefix, one level down: every one of these
    // stores moves under `%LOCALAPPDATA%` / `%APPDATA%` on Windows, and a list
    // that only knows the POSIX path silently finds nothing there. fnm is a
    // versioned root, so a real directory has to exist for it to be expanded.
    const local = await mkdtemp(join(tmpdir(), 'cb-localappdata-'))
    const roaming = await mkdtemp(join(tmpdir(), 'cb-appdata-'))
    const previousLocal = process.env['LOCALAPPDATA']
    const previousRoaming = process.env['APPDATA']
    process.env['LOCALAPPDATA'] = local
    process.env['APPDATA'] = roaming
    try {
      await mkdir(join(roaming, 'fnm', 'node-versions', 'v22.0.0', 'lib', 'node_modules'), { recursive: true })
      const candidates = cliEntryCandidates()
      expect(candidates).toContain(join(local, 'pnpm', 'global', '5', 'node_modules', PKG))
      expect(candidates).toContain(join(local, 'Yarn', 'Data', 'global', 'node_modules', PKG))
      expect(candidates).toContain(join(roaming, 'fnm', 'node-versions', 'v22.0.0', 'lib', 'node_modules', PKG))
    } finally {
      if (previousLocal === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = previousLocal
      if (previousRoaming === undefined) delete process.env['APPDATA']
      else process.env['APPDATA'] = previousRoaming
      await rm(local, { recursive: true, force: true })
      await rm(roaming, { recursive: true, force: true })
    }
  })
})

describe('live progress reporting', () => {
  it('reports every assistant block, counting tools and characters', async () => {
    const child = fakeChild()
    useChild(child)
    const seen: Array<{ toolCalls: number; lastTool: string; chars: number }> = []
    const running = runAgent(turnOptions(entry, {
      onProgress: progress => { seen.push({ ...progress }) },
    }), [credential], () => {})

    initFrames(child)
    child.emitFrame({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', name: 'Grep', id: 't1' },
        ],
      },
    })
    child.emitFrame({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', id: 't2' },
          { type: 'text', text: ' and then' },
        ],
      },
    })
    child.emitFrame({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'done' })
    await running

    // One call per block that changed a number, in frame order. The text block
    // reports the tool count SO FAR, which is what makes the pill's two numbers
    // consistent with each other at every moment.
    expect(seen).toEqual([
      { toolCalls: 0, lastTool: '', chars: 11 },
      { toolCalls: 1, lastTool: 'Grep', chars: 11 },
      { toolCalls: 2, lastTool: 'Read', chars: 11 },
      { toolCalls: 2, lastTool: 'Read', chars: 20 },
    ])
  })

  it('never reports the text itself', async () => {
    const child = fakeChild()
    useChild(child)
    const payloads: string[] = []
    const running = runAgent(turnOptions(entry, {
      onProgress: progress => { payloads.push(JSON.stringify(progress)) },
    }), [credential], () => {})

    initFrames(child)
    child.emitFrame({ type: 'assistant', message: { content: [{ type: 'text', text: 'SECRET-ANSWER' }] } })
    child.emitFrame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'SECRET-ANSWER' })
    await running

    // The pill is a COUNT, never a copy: shipping the text here would put a
    // second, growing copy of the answer in a place nobody asked for.
    expect(payloads.join('')).not.toContain('SECRET-ANSWER')
  })

  it('reports nothing when no callback is supplied', async () => {
    const child = fakeChild()
    useChild(child)
    const running = runAgent(turnOptions(entry), [credential], () => {})
    initFrames(child)
    child.emitFrame({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', id: 't1' }] } })
    child.emitFrame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok' })
    // The point is that this resolves rather than throwing on an absent callback.
    await expect(running).resolves.toMatchObject({ ok: true })
  })
})

/**
 * The board row is the composer pill's only source, so the ID it carries decides
 * whether the pill shows the turn at all: the browser keeps the rows whose
 * `sessionId` equals the session the pill is mounted in.
 *
 * There are TWO ids in play and they are not interchangeable — the DSH session
 * the turn was called from (`execution.agent.id`, what the pill filters on) and
 * the CLI's own session uuid (reported to the caller as `session_id`). The first
 * draft wrote the second over the first at "finishing" time, which made the pill
 * drop its own row for the last seconds of every turn. This locks the separation.
 */
describe('the live board row identity', () => {
  const baseOptions: BridgeOptions = {
    enabled: true,
    binary: '',
    model: '',
    permissionMode: 'dontAsk',
    effort: '',
    maxTurns: 3,
    timeoutSecs: 30,
    regionOrder: [],
    workingDir: '',
    allowedDirs: [],
    appendSystemPrompt: '',
    allowUnattended: false,
    maxReplyChars: 1_000,
    injectResult: false,
    sessionContinuity: 'off',
    maxTurnsPerSessionHour: 0,
    maxTurnsPerHour: 0,
  }

  it('keeps the DSH session id after the CLI reports its own session uuid', async () => {
    const child = fakeChild()
    useChild(child)
    const board = createLiveBoard()
    const opened: LiveTurn[] = []
    const begin = board.begin
    board.begin = input => {
      const turn = begin(input)
      opened.push(turn)
      return turn
    }

    const previous = process.env['CODEBUDDY_AUTH_TOKEN']
    process.env['CODEBUDDY_AUTH_TOKEN'] = 'token-abcdef123456'
    try {
      const running = runAsk(
        { message: 'do the thing', working_dir: dir },
        { agent: { id: 'session-dsh' } },
        {
          options: { ...baseOptions, binary: entry, allowedDirs: [dir] },
          regions: [],
          log: () => {},
          live: board,
          // The gate has its own suite; here it must simply not refuse.
          gate: { tryEnter: () => ({ ok: true, release: () => {} }) } as never,
        },
      )
      await vi.waitFor(() => {
        expect(spawnMock).toHaveBeenCalled()
      })
      initFrames(child)
      child.emitFrame({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })
      child.emitFrame({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        result: 'done',
        session_id: 'cli-session-uuid',
      })
      const outcome = await running

      expect(outcome.ok).toBe(true)
      // The caller still gets the CLI's uuid, which is what resumes the CLI session.
      expect(outcome.session_id).toBe('cli-session-uuid')
      // The board row keeps the DSH id — the only value the pill can match.
      expect(opened).toHaveLength(1)
      expect(opened[0]?.sessionId).toBe('session-dsh')
      // And the row is retired, so the pill stops claiming a turn.
      expect(board.size()).toBe(0)
    } finally {
      if (previous === undefined) delete process.env['CODEBUDDY_AUTH_TOKEN']
      else process.env['CODEBUDDY_AUTH_TOKEN'] = previous
    }
  })
})

/**
 * Automatic session continuation (`cliBridge.sessionContinuity`).
 *
 * MEASURED BEFORE IT WAS WIRED, not assumed: against the installed CLI,
 * `--session-id <existing>` really does resume the conversation (a number sent in
 * turn 1 came back from turn 2, same id echoed both times), and an UNKNOWN id is
 * NOT an error — the CLI silently opens a fresh session under it. That second
 * fact is why a stale entry here costs one new conversation instead of a
 * corrupted one, and it is also why these tests assert the ARGUMENT rather than
 * pretending to assert the model's memory.
 *
 * The rule being locked: an explicit `session_id` argument always wins, because a
 * caller may be deliberately branching; otherwise `auto` reuses what this DSH
 * session ran last, and `off` reuses nothing.
 */
describe('automatic session continuation', () => {
  const autoOptions: BridgeOptions = {
    enabled: true,
    binary: '',
    model: '',
    permissionMode: 'dontAsk',
    effort: '',
    maxTurns: 3,
    timeoutSecs: 30,
    regionOrder: [],
    workingDir: '',
    allowedDirs: [],
    appendSystemPrompt: '',
    allowUnattended: false,
    maxReplyChars: 1_000,
    injectResult: false,
    sessionContinuity: 'auto',
    maxTurnsPerSessionHour: 0,
    maxTurnsPerHour: 0,
  }

  let previousToken: string | undefined

  beforeEach(() => {
    // Recording is unconditional (the setting decides what is READ, not kept), so
    // a key shared with an earlier test would otherwise start this suite already
    // pointing at a conversation.
    forgetCliSession('session-cont')
    previousToken = process.env['CODEBUDDY_AUTH_TOKEN']
    process.env['CODEBUDDY_AUTH_TOKEN'] = 'token-abcdef123456'
  })

  afterEach(() => {
    if (previousToken === undefined) delete process.env['CODEBUDDY_AUTH_TOKEN']
    else process.env['CODEBUDDY_AUTH_TOKEN'] = previousToken
  })

  /** The argv of every real spawn (the Windows taskkill helper excluded). */
  function spawnedArgs(): string[][] {
    return spawnMock.mock.calls
      .filter(call => !String(call[0]).endsWith('taskkill'))
      .map(call => (Array.isArray(call[1]) ? (call[1] as string[]) : []))
  }

  /** Run one bridged turn against `child`, which reports `cliSessionId`. */
  async function runTurn(
    child: FakeChild,
    args: Record<string, unknown>,
    options: BridgeOptions,
    cliSessionId: string,
    agentId = 'session-cont',
  ): Promise<Awaited<ReturnType<typeof runAsk>>> {
    const running = runAsk(args, { agent: { id: agentId } }, {
      options: { ...options, binary: entry, allowedDirs: [dir] },
      regions: [],
      log: () => {},
      gate: { tryEnter: () => ({ ok: true, release: () => {} }) } as never,
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    initFrames(child)
    child.emitFrame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      result: 'done',
      session_id: cliSessionId,
    })
    return await running
  }

  it('threads the previous CLI session into the next call in the same DSH session', async () => {
    const first = fakeChild(5001)
    const second = fakeChild(5002)
    spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second)

    const one = await runTurn(first, { message: 'first', working_dir: dir }, autoOptions, 'cli-uuid-1')
    expect(one.ok).toBe(true)
    expect(one.session_id).toBe('cli-uuid-1')

    const two = await runTurn(second, { message: 'second', working_dir: dir }, autoOptions, 'cli-uuid-2')
    expect(two.ok).toBe(true)

    const args = spawnedArgs()
    expect(args).toHaveLength(2)
    // Turn one had nothing to continue, so it must NOT pass an id at all.
    expect(args[0]).not.toContain('--session-id')
    // Turn two continues the uuid turn one reported.
    expect(args[1]).toContain('--session-id')
    expect(args[1]?.[args[1].indexOf('--session-id') + 1]).toBe('cli-uuid-1')
  })

  it('lets an explicit session_id override the remembered one', async () => {
    const first = fakeChild(5011)
    const second = fakeChild(5012)
    spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second)

    await runTurn(first, { message: 'first', working_dir: dir }, autoOptions, 'cli-uuid-1')
    await runTurn(
      second,
      { message: 'second', working_dir: dir, session_id: 'explicit-id' },
      autoOptions,
      'cli-uuid-2',
    )

    const args = spawnedArgs()
    expect(args[1]?.[args[1].indexOf('--session-id') + 1]).toBe('explicit-id')
  })

  it('starts fresh every time when sessionContinuity is off', async () => {
    const first = fakeChild(5021)
    const second = fakeChild(5022)
    spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second)

    const off: BridgeOptions = { ...autoOptions, sessionContinuity: 'off' }
    await runTurn(first, { message: 'first', working_dir: dir }, off, 'cli-uuid-1')
    await runTurn(second, { message: 'second', working_dir: dir }, off, 'cli-uuid-2')

    for (const args of spawnedArgs()) expect(args).not.toContain('--session-id')
  })

  it('keeps sessions apart: one DSH session never continues another', async () => {
    const first = fakeChild(5031)
    const second = fakeChild(5032)
    spawnMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second)

    await runTurn(first, { message: 'first', working_dir: dir }, autoOptions, 'cli-uuid-1', 'session-a')
    await runTurn(second, { message: 'second', working_dir: dir }, autoOptions, 'cli-uuid-2', 'session-b')

    const args = spawnedArgs()
    expect(args[1]).not.toContain('--session-id')
  })
})
