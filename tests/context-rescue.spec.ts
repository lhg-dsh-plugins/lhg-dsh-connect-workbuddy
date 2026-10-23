import { describe, expect, it } from 'vitest'
import { createContextRescue } from '../src/context-rescue.ts'
import type { ContextRescueDeps, RescueMeasurement } from '../src/context-rescue.ts'

/**
 * Issue #59, second half. Once a session outgrew the window of the model it was
 * routed to, the host's overflow recovery could not break the cycle: it folded
 * the whole history inside a summarization request on that same small-window
 * route, so the rescue request overflowed exactly like the request it was
 * rescuing. The adapter sits on the only seam that sees the overflow while it
 * still holds the session id, so it folds the history itself — through the
 * host's own compaction transaction, with a range chosen to fit.
 *
 * These tests pin the two properties the fix depends on: a chunk never exceeds
 * the budget it was measured against, and the message the failing request
 * carried is never folded away underneath it.
 */

/** Tokens a folded chunk costs once the host replaces it with its summary. */
const SUMMARY_TOKENS = 20

interface FakeNode {
  seq: number
  tokens: number
}

/**
 * A host that behaves like the real one where the rescue can observe it: the
 * meter reports priced nodes head-to-tail, and one accepted fold collapses the
 * covered span into a single cheap node.
 */
class FakeHost {
  readonly sessionId: string
  nodes: FakeNode[]
  readonly calls: { start: number; end: number; coveredTokens: number }[] = []
  readonly refusedEnds = new Set<number>()
  /** Invoked with the rescue handle so a test can simulate a nested overflow. */
  nested: ((end: number) => Promise<unknown>) | undefined
  lastSignal: AbortSignal | undefined

  constructor(sessionId: string, nodes: FakeNode[]) {
    this.sessionId = sessionId
    this.nodes = nodes
  }

  private measure(): RescueMeasurement {
    return {
      totalTokens: this.nodes.reduce((total, node) => total + node.tokens, 0),
      nodes: this.nodes.map(node => ({ seq: node.seq, tokens: node.tokens })),
    }
  }

  deps(): ContextRescueDeps {
    return {
      meter: { measure: () => this.measure() },
      agents: { get: id => id === this.sessionId ? { session: { id } } : undefined },
      compaction: {
        compactRegion: async (start, end, _agent, signal) => {
          this.lastSignal = signal
          const covered = this.nodes.findIndex(node => node.seq === end)
          if (covered < 0) throw new Error(`missing range ${start}..${end}`)
          this.calls.push({
            start,
            end,
            coveredTokens: this.nodes
              .slice(0, covered + 1)
              .reduce((total, node) => total + node.tokens, 0),
          })
          if (this.nested !== undefined) await this.nested(end)
          if (this.refusedEnds.has(end)) throw new Error('unbalanced tool pairing at the tail edge')
          this.nodes.splice(0, covered + 1, { seq: -1, tokens: SUMMARY_TOKENS })
          return { kind: 'folded' }
        },
      },
      log: () => {},
    }
  }

  total(): number {
    return this.nodes.reduce((total, node) => total + node.tokens, 0)
  }
}

/** Twenty surface nodes of 100 tokens each: 2,000 tokens against a 1,000 window. */
function saturated(): FakeHost {
  return new FakeHost('session-a', Array.from({ length: 20 }, (_, index) => ({
    seq: index + 1,
    tokens: 100,
  })))
}

describe('context overflow rescue', () => {
  it('folds history until the surface fits the window', async () => {
    const host = saturated()
    const rescue = createContextRescue(() => host.deps())

    expect(await rescue.rescue(host.sessionId, 1_000)).toBe(true)

    // Target is 60% of the window. The surface cannot land exactly on it: the
    // last fold leaves a summary node behind, and shrinking that node again
    // costs as much as it saves. One summary node of slack is the floor.
    expect(host.total()).toBeLessThanOrEqual(600 + SUMMARY_TOKENS)
    expect(host.total()).toBeLessThan(2_000)
    expect(host.calls.length).toBeGreaterThan(0)
  })

  it('folded chunks stay within the chunk budget derived from the window', async () => {
    const host = saturated()
    const rescue = createContextRescue(() => host.deps())
    await rescue.rescue(host.sessionId, 1_000)

    // 35% of a 1,000-token window is 350. A chunk stops at the first node that
    // pushes it past that, so one 100-token node of overshoot is expected and
    // anything beyond it would mean the range outgrew the budget.
    const budget = 350
    for (const call of host.calls) {
      expect(call.coveredTokens).toBeGreaterThan(0)
      expect(call.coveredTokens).toBeLessThanOrEqual(budget + 100)
    }
    expect(host.calls.every(call => call.end >= call.start)).toBe(true)
  })

  it('does nothing when the surface already fits', async () => {
    const host = new FakeHost('session-b', [{ seq: 1, tokens: 100 }, { seq: 2, tokens: 100 }])
    const rescue = createContextRescue(() => host.deps())

    expect(await rescue.rescue(host.sessionId, 1_000)).toBe(false)
    expect(host.calls).toHaveLength(0)
  })

  it('never folds the message the failing request carried', async () => {
    // Two nodes only: the eldest is foldable, the in-flight one is not.
    const host = new FakeHost('session-c', [{ seq: 1, tokens: 5_000 }, { seq: 2, tokens: 300 }])
    const rescue = createContextRescue(() => host.deps())
    await rescue.rescue(host.sessionId, 1_000)

    expect(host.calls.every(call => call.end === 1)).toBe(true)
    expect(host.nodes.at(-1)?.seq).toBe(2)
  })

  it('moves the tail edge inward when the host refuses the range', async () => {
    const host = saturated()
    // Refuse the first chunk the rescue would choose, then accept anything else.
    const firstEnd = 4
    host.refusedEnds.add(firstEnd)
    const rescue = createContextRescue(() => host.deps())

    expect(await rescue.rescue(host.sessionId, 1_000)).toBe(true)
    expect(host.calls.some(call => call.end === firstEnd)).toBe(true)
    // The refusal moved the edge, and a later attempt still succeeded.
    expect(host.calls.some(call => call.end < firstEnd)).toBe(true)
  })

  it('reports nothing folded when the host has no compaction service', async () => {
    const host = saturated()
    const rescue = createContextRescue(() => ({ ...host.deps(), compaction: undefined }))
    expect(await rescue.rescue(host.sessionId, 1_000)).toBe(false)
    expect(host.total()).toBe(2_000)
  })

  it('reports nothing folded when the session is not live', async () => {
    const host = saturated()
    const rescue = createContextRescue(() => host.deps())
    expect(await rescue.rescue('session-unknown', 1_000)).toBe(false)
    expect(host.calls).toHaveLength(0)
  })

  it('does not re-enter itself from the summarization request', async () => {
    const host = saturated()
    const rescue = createContextRescue(() => host.deps())
    const nestedResults: boolean[] = []
    // The host's compaction transaction issues its summary through the same
    // adapter, so an overflow inside it reaches this guard.
    host.nested = async () => {
      nestedResults.push(await rescue.rescue(host.sessionId, 1_000))
    }

    expect(await rescue.rescue(host.sessionId, 1_000)).toBe(true)
    expect(nestedResults.every(result => result === false)).toBe(true)
  })

  it('stops once folding can no longer shrink the surface', async () => {
    // The in-flight message alone outgrows the window, so every fold the host
    // accepts buys nothing. The rescue must notice instead of looping.
    const host = new FakeHost('session-d', [{ seq: 1, tokens: 300 }, { seq: 2, tokens: 5_000 }])
    const rescue = createContextRescue(() => host.deps())

    await rescue.rescue(host.sessionId, 1_000)
    expect(host.calls.length).toBeLessThanOrEqual(2)
    expect(host.nodes.at(-1)?.seq).toBe(2)
  })

  it('survives a host that rejects every range', async () => {
    const host = saturated()
    for (let seq = 1; seq <= 20; seq += 1) host.refusedEnds.add(seq)
    const rescue = createContextRescue(() => host.deps())

    expect(await rescue.rescue(host.sessionId, 1_000)).toBe(false)
    expect(host.total()).toBe(2_000)
  })
})
