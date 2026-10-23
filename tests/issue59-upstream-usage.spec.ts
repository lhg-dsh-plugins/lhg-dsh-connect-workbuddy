/**
 * Issue #59, charged side: the shim must report what the UPSTREAM counted.
 *
 * The body report already recorded what was SENT (`bodyBytes`, `chars`, block
 * composition). That alone leaves every capture ambiguous, because from the
 * sent side alone these two worlds are identical:
 *
 *   - the gateway counted the same bytes differently (upstream's business); or
 *   - the two bodies were not the same after all (ours to fix).
 *
 * `onUpstreamUsage` closes that gap. It exists because the `usage` block rides
 * the STREAM, not the request: it is only knowable once the answer is over, at a
 * point the request-side hook has long since returned.
 *
 * Two properties are load-bearing and each has a case below:
 *   1. it fires on a frame that carries `usage` — which on a real stream has NO
 *      `choices`, so a hook placed after the choices check would never fire;
 *   2. an ABSENT measurement is not a measurement of zero.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'
import type { WorkBuddyUsageCounts } from '../src/body-report.ts'

let shim: WorkBuddyShim | undefined
afterEach(async () => { await shim?.close(); shim = undefined })

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: Date.now() + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid',
  source: 'desktop',
  filePath: '/tmp/auth.info',
}

const store = {
  resolve: async () => CREDENTIAL,
} as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

const BODY = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  stream: true,
  messages: [{ role: 'user', content: 'hi' }],
})

function contentFrame(content: string, finishReason = ''): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`
}

/** The final frame of a streamed answer: `usage`, and deliberately NO `choices`. */
function usageFrame(usage: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-1', usage })}\n\n`
}

const DONE = 'data: [DONE]\n\n'

function sseOf(...frames: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join('')))
      controller.close()
    },
  }))
}

function makeShim(
  answer: () => Response,
  onUpstreamUsage?: (usage: WorkBuddyUsageCounts) => void,
): WorkBuddyShim {
  return createWorkBuddyShim({
    store,
    client: {
      chatStream: async (): Promise<WorkBuddyChatResult> => ({ ok: true, response: answer() }),
    } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
    ...onUpstreamUsage === undefined ? {} : { onUpstreamUsage },
  })
}

async function post(target: WorkBuddyShim): Promise<string> {
  // `baseUrl()` is only meaningful once the server has a listening address.
  await target.ready
  const response = await fetch(`${target.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${target.token()}`, 'content-type': 'application/json' },
    body: BODY,
  })
  expect(response.status).toBe(200)
  return await response.text()
}

describe('the shim reports what the upstream counted', () => {
  it('fires on the final usage frame, which carries no choices', async () => {
    // The frame that matters has `usage` and no `choices`. Any hook placed after
    // the choices check sees nothing — that is the defect this pins.
    const seen: WorkBuddyUsageCounts[] = []
    shim = makeShim(
      () => sseOf(contentFrame('hello'), usageFrame({ prompt_tokens: 708000, completion_tokens: 12 }), DONE),
      usage => seen.push(usage),
    )
    await post(shim)
    expect(seen).toEqual([{ promptTokens: 708000, completionTokens: 12 }])
  })

  it('reports nothing, rather than zero, when the stream carries no usage', async () => {
    // The distinction the whole #59 comparison turns on: an upstream that said
    // nothing is not an upstream that charged nothing.
    const seen: WorkBuddyUsageCounts[] = []
    shim = makeShim(() => sseOf(contentFrame('hello'), DONE), usage => seen.push(usage))
    await post(shim)
    expect(seen).toEqual([])
  })

  it('fires at most once per stream', async () => {
    const seen: WorkBuddyUsageCounts[] = []
    shim = makeShim(
      () => sseOf(contentFrame('a'), usageFrame({ prompt_tokens: 1 }), usageFrame({ prompt_tokens: 2 }), DONE),
      usage => seen.push(usage),
    )
    await post(shim)
    // The FIRST measurement wins: it is the one belonging to the serve.
    expect(seen).toEqual([{ promptTokens: 1 }])
  })

  it('passes the client the same answer when the usage shape is unusable', async () => {
    const seen: WorkBuddyUsageCounts[] = []
    shim = makeShim(
      () => sseOf(contentFrame('hello'), usageFrame({ prompt_tokens: 'many' }), DONE),
      usage => seen.push(usage),
    )
    const text = await post(shim)
    expect(seen).toEqual([])
    // The answer itself is untouched — a diagnostic never rewrites the stream.
    expect(text).toContain('hello')
  })

  it('does not fail the request when the usage callback throws', async () => {
    shim = makeShim(
      () => sseOf(contentFrame('hello'), usageFrame({ prompt_tokens: 5 }), DONE),
      () => { throw new Error('diagnostic exploded') },
    )
    const text = await post(shim)
    expect(text).toContain('hello')
  })
})
