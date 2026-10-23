/**
 * Skipping the doomed first attempt once the gateway has proven it refuses the
 * plain body (measured 2026-10-22).
 *
 * THE DEFECT. The retry ladder is discover-by-failing: send the plain body, get
 * `11128`, re-send a perturbed copy. Correct the first time, wasteful every time
 * after — the prompt SHAPE does not change between turns, so the plugin paid a
 * refused request (~209ms measured) on EVERY request.
 *
 * WHAT MUST HOLD. After one perturbation succeeds, the next request starts
 * perturbed; and if a perturbed body is ever refused, the preference is cleared
 * so the plugin rediscovers what works instead of being stuck.
 *
 * The flag is process-local on purpose: the gateway's fingerprint list can be
 * withdrawn as easily as extended, and a persisted flag would outlive the
 * condition that justified it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult, WorkBuddyUpstreamClient } from '../src/upstream.ts'

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  uin: 'selected',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}
const store = {
  resolve: async () => CREDENTIAL,
  credentialFor: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

/** A refusal with the channel gate's business code, so classification is real. */
const CHANNEL_REFUSAL = JSON.stringify({
  code: 11128,
  msg: 'Illegal API invocation from an unapproved channel',
  displayMsg: { zh: '可能不是官方客户端发出的' },
})

const REFUSED: WorkBuddyChatResult = { ok: false, status: 400, kind: 'channel_reject', message: CHANNEL_REFUSAL }

/** An SSE body a successful chat returns. */
const OK_STREAM = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}',
  'data: {"usage":{"prompt_tokens":10,"completion_tokens":1}}',
  'data: [DONE]',
  '',
].join('\n\n')

/** A successful result carrying a real stream, so the shim can relay it. */
function okResult(): WorkBuddyChatResult {
  return { ok: true, response: new Response(OK_STREAM) }
}

/**
 * Mount a shim whose client records every body it was asked to send.
 *
 * `answers` is consumed in order, so a test states the gateway's behaviour per
 * attempt rather than guessing at indices.
 */
function mount(answers: readonly WorkBuddyChatResult[]): {
  instance: WorkBuddyShim
  bodies: string[]
} {
  const bodies: string[] = []
  let index = 0
  const client = {
    chatStream: async (_credential: unknown, bodyJson: string) => {
      bodies.push(bodyJson)
      const answer = answers[Math.min(index, answers.length - 1)]
      index += 1
      return answer as WorkBuddyChatResult
    },
  } as unknown as WorkBuddyUpstreamClient
  const instance = createWorkBuddyShim({ store, client, catalog: new WorkBuddyCatalog() })
  return { instance, bodies }
}

/** Count the zero-width spaces a body carries, i.e. whether it was perturbed. */
function perturbations(bodyJson: string): number {
  return (bodyJson.match(/\u200b/gu) ?? []).length
}

/**
 * Drive one chat request whose prompt carries a sentence boundary to perturb.
 *
 * The default prompt deliberately ALREADY starts with the neutral head, which is
 * the real DSH shape: `prepareChatBody` prepends it, so by the time the ladder
 * runs, `forceNeutralHead` finds every opening already neutralised and returns
 * `undefined` — a no-op. That is precisely the measured condition under which the
 * PERTURBATION is the rung that succeeds, and therefore the only condition in
 * which this file's subject (remembering it) can be reached.
 *
 * A prompt WITHOUT the neutral head would make rung 1 succeed instead, and the
 * test would silently measure a different path.
 */
async function chat(
  instance: WorkBuddyShim,
  prompt = 'You are a helpful assistant.\n\nYou are an AI agent. It is a test. Say hi.',
): Promise<string> {
  await instance.ready
  const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'hi' }],
      // `stream: true` because the upstream refuses non-streaming chat.
      stream: true,
    }),
  })
  return await response.text()
}

describe('the perturbed form is remembered after it works', () => {
  it('sends the PLAIN body first when nothing is known yet', async () => {
    // The first request of a process must go out unmodified: that attempt is
    // what discovers whether the gate is on at all.
    const { instance, bodies } = mount([okResult()])
    shim = instance
    await chat(instance)
    expect(bodies.length).toBe(1)
    expect(perturbations(bodies[0] as string)).toBe(0)
  })

  it('sends the PERTURBED body FIRST on the next request, skipping the doomed attempt', async () => {
    // Attempt 1 refused, attempt 2 (perturbed) succeeds — the discovery pass.
    // Attempt 3 opens the second request, and must ALREADY be perturbed.
    const { instance, bodies } = mount([REFUSED, okResult(), okResult()])
    shim = instance
    await chat(instance)
    expect(bodies.length).toBe(2)
    expect(perturbations(bodies[0] as string)).toBe(0)
    expect(perturbations(bodies[1] as string)).toBeGreaterThan(0)

    await chat(instance)
    // TWO bodies total for the second request would mean it still paid the
    // doomed attempt; the assertion is that the THIRD body — the first of the
    // second request — is already perturbed.
    expect(bodies.length).toBe(3)
    expect(perturbations(bodies[2] as string)).toBeGreaterThan(0)
  })

  it('does not remember anything when the plain body was accepted', async () => {
    // A gateway that is not refusing must keep receiving unmodified prompts:
    // perturbing every request would be a behaviour change nobody asked for.
    const { instance, bodies } = mount([okResult(), okResult()])
    shim = instance
    await chat(instance)
    await chat(instance)
    expect(bodies.length).toBe(2)
    expect(perturbations(bodies[0] as string)).toBe(0)
    expect(perturbations(bodies[1] as string)).toBe(0)
  })

  it('clears the preference when a perturbed body is refused too', async () => {
    // The rule was withdrawn, or a different model sits behind the same gateway.
    // The plugin must rediscover what works rather than stay stuck.
    const { instance, bodies } = mount([
      REFUSED, okResult(),      // request 1: discovers perturbation
      REFUSED,                  // request 2 attempt 1: perturbed, now refused
      okResult(),               // request 2 attempt 2: plain, accepted
    ])
    shim = instance
    await chat(instance)
    expect(bodies.length).toBe(2)

    await chat(instance)
    // Attempt 1 was perturbed (the learned shape), attempt 2 fell back to plain.
    expect(perturbations(bodies[2] as string)).toBeGreaterThan(0)
    expect(perturbations(bodies[3] as string)).toBe(0)
  })

  it('after clearing, the NEXT request starts plain again', async () => {
    // The recovery is not a one-off: once the preference is cleared the process
    // is back to the discover-by-failing state.
    const { instance, bodies } = mount([
      REFUSED, okResult(),   // request 1: learns
      REFUSED,               // request 2: perturbed refused
      okResult(),            // request 2: plain accepted
      okResult(),            // request 3: plain, no experiment
    ])
    shim = instance
    await chat(instance)
    await chat(instance)
    await chat(instance)
    expect(perturbations(bodies[2] as string)).toBeGreaterThan(0)
    expect(perturbations(bodies[3] as string)).toBe(0)
    expect(perturbations(bodies[4] as string)).toBe(0)
  })

  it('stops after the ladder instead of retrying forever', async () => {
    // The invariant is BOUNDEDNESS, not a particular count. A body that every
    // rung leaves identical must not be re-sent — the transforms return
    // `undefined` for exactly that reason — so the ladder always terminates.
    //
    // The count here is three because the prompt can still be changed at every
    // rung: the neutral head is prepended (rung 1), and that head's own full stop
    // is itself a sentence boundary the perturbation can act on (rung 2). A body
    // no rung can change gets only the rungs that could act on it.
    const { instance, bodies } = mount([REFUSED])
    shim = instance
    const text = await chat(instance, 'You are a helpful assistant and nothing else follows')
    expect(bodies.length).toBeLessThanOrEqual(3)
    // The user still gets the failure, with the gate's advice intact.
    expect(text).toContain('上游失败')
  })

  it('never learns a preference from a ladder that never succeeded', async () => {
    // `channelNeedsPerturbation` is set on SUCCESS only. A perturbation that is
    // also refused teaches nothing about what the gateway wants, and setting the
    // flag would make every later request start from a shape that is known to
    // fail.
    const { instance, bodies } = mount([REFUSED])
    shim = instance
    await chat(instance)
    const firstRunAttempts = bodies.length
    await chat(instance)
    // The second request must take the SAME path: no memorised shortcut.
    const secondRunAttempts = bodies.length - firstRunAttempts
    expect(secondRunAttempts).toBe(firstRunAttempts)
    expect(perturbations(bodies[firstRunAttempts] as string)).toBe(0)
  })
})
