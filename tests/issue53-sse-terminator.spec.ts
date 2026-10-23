/**
 * Issue #53: an unterminated frame must not swallow the synthetic `[DONE]`.
 *
 * The upstream died between a `data:` line and the blank line that would have
 * closed its event. `RecoveryStream.consume()` forwarded the half-frame as it
 * stood, and `finish()` then appended `data: [DONE]\n\n` — so the client
 * received
 *
 *     data: {"id":"chatcmpl-x",…}
 *     data: [DONE]
 *
 * as ONE event. A client that joins the several `data:` lines of an event with
 * `\n` and parses the result as a single JSON document (openai's `SSEDecoder`
 * does exactly that) reads two payloads as one and throws
 * "Unexpected non-whitespace character after JSON at position N" — where N is
 * precisely the length of the first chunk, because that is where the second
 * line starts. The host maps the failure to a non-retryable error code, so the
 * turn ends with no answer and no retry.
 *
 * The fix keeps every frame self-contained: the half-frame is closed before it
 * reaches the client, and the terminator that follows can no longer be glued
 * onto it. These tests assert at the BYTE level — the defect is byte-level
 * splicing, so only a byte-level assertion catches it. An event is split the
 * way the SSE spec defines it, and every event's joined `data:` lines must be
 * exactly one JSON document.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

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

/** A content frame the way the upstream emits it: one `data:` line, then a blank line. */
function contentFrame(content: string, finishReason = ''): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`
}

/**
 * The same frame with its BLANK LINE withheld — the upstream died between the
 * `data:` line and the separator that would have closed the event.
 *
 * This is the shape the reported failures came from, and it is the only shape
 * that reaches the half-frame path in `consume()` at all: `push()` cuts a frame
 * only at an empty line, so a frame that arrives WITH its terminator is already
 * complete and leaves nothing in `carry`. Feeding a complete frame here would
 * assert on the healthy path and pass for the wrong reason.
 */
function halfFrame(content: string, finishReason = ''): string {
  return contentFrame(content, finishReason).replace(/\n\n$/, '\n')
}

/**
 * Split an SSE body into events the way the protocol defines them, and join
 * each event's `data:` lines the way a decoding client does.
 *
 * Returns one entry per event: the `\n`-joined payload, plus whether the event
 * was terminated by a blank line at all. An empty `data` field is how a
 * client signals "no event here" (a stray separator), which is legal.
 */
function eventsOf(body: string): { payload: string, terminated: boolean }[] {
  const events: { payload: string, terminated: boolean }[] = []
  let data: string[] = []
  for (const line of body.split('\n')) {
    if (line === '') {
      if (data.length > 0) {
        events.push({ payload: data.join('\n'), terminated: true })
        data = []
      }
      continue
    }
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim())
    // Non-data lines (comments, `event:`) are ignored: openai's stream carries
    // none of them, and they do not affect how the payloads are joined.
  }
  // A trailing event that never got its blank line: the client would still be
  // waiting for it when the connection closes, so it is never dispatched.
  if (data.length > 0) events.push({ payload: data.join('\n'), terminated: false })
  return events
}

/** A response whose body fails after delivering `prefix` verbatim. */
function brokenStreamOf(prefix: string): Response {
  const encoder = new TextEncoder()
  let pulled = 0
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulled += 1
      if (pulled === 1) {
        controller.enqueue(encoder.encode(prefix))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 10))
      controller.error(new Error('upstream died'))
    },
  }))
}

function makeShim(chatStream: (body: string, call: number) => WorkBuddyChatResult): WorkBuddyShim {
  let calls = 0
  return createWorkBuddyShim({
    store,
    client: {
      chatStream: async (_credential: WorkBuddyCredential, body: string): Promise<WorkBuddyChatResult> => {
        calls += 1
        return chatStream(body, calls)
      },
    } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog(),
  })
}

async function post(target: WorkBuddyShim, body: string): Promise<string> {
  const response = await fetch(`${target.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${target.token()}`, 'content-type': 'application/json' },
    body,
  })
  expect(response.status).toBe(200)
  return await response.text()
}

const BODY = JSON.stringify({
  model: 'glm-5.3',
  messages: [{ role: 'user', content: 'hi' }],
})

describe('issue #53: frames are self-contained on the wire', () => {
  it('closes a half-frame cut off mid-answer, so the terminator cannot join it', async () => {
    // The reported shape: a COMPLETE `data:` line whose blank line never
    // arrived. Before the fix the client received one event holding two
    // payloads and threw on the joined parse.
    const half = halfFrame('答案的一半')
    shim = makeShim(() => ({ ok: true, response: brokenStreamOf(half) }))
    await shim.ready

    const body = await post(shim, BODY)
    const events = eventsOf(body)

    // Every event must be one parseable JSON document. This is the exact
    // failure openai's SSEDecoder produced: `{"…"}\n[DONE]` is two.
    for (const event of events) {
      if (event.payload === '[DONE]') continue
      expect(() => JSON.parse(event.payload)).not.toThrow()
    }
    // The terminator must be its own event, not a second `data:` line of the
    // last content event.
    expect(events.map(event => event.payload)).toContain('[DONE]')
    expect(events.at(-1)?.payload).toBe('[DONE]')
    // And the content that DID arrive must have been delivered rather than
    // silently dropped — without a terminator the client never dispatches it.
    const text = events
      .filter(event => event.payload !== '[DONE]')
      .flatMap(event => {
        const chunk = JSON.parse(event.payload) as { choices?: { delta?: { content?: string } }[] }
        const content = chunk.choices?.[0]?.delta?.content
        return typeof content === 'string' ? [content] : []
      })
      .join('')
    expect(text).toBe('答案的一半')
  })

  it('closes a frame cut off MID-LINE too, which needs the full terminator', async () => {
    // A frame severed inside the JSON payload: no newline at all. A single
    // `\n` would only end the LINE, not the EVENT, so the terminator would
    // still be appended to this event.
    const severed = 'data: {"choices":[{"index":0,"delta":{"content":"半'
    shim = makeShim(() => ({ ok: true, response: brokenStreamOf(severed) }))
    await shim.ready

    const body = await post(shim, BODY)
    const events = eventsOf(body)
    // The corrupted payload is not parseable — nothing can repair upstream
    // corruption — but it must not drag the terminator into its own event.
    expect(events.map(event => event.payload)).toContain('[DONE]')
    const done = events.find(event => event.payload === '[DONE]')
    expect(done?.terminated).toBe(true)
    expect(events.at(-1)?.payload).toBe('[DONE]')
  })

  it('leaves a fully-formed stream byte-for-byte unchanged', async () => {
    // The guard against over-normalizing: the ordinary path must be untouched.
    const chunks = [contentFrame('第一句。'), contentFrame('第二句。', 'stop'), 'data: [DONE]\n\n']
    shim = makeShim(() => ({ ok: true, response: streamOf(chunks) }))
    await shim.ready

    const body = await post(shim, BODY)
    expect(body).toBe(chunks.join(''))
    expect(eventsOf(body).every(event => event.terminated)).toBe(true)
  })

  it('closes the half-frame even when recovery is holding bytes', async () => {
    // With a hold window open, the half-frame is queued through `send` and
    // written by `closeWindow` — that path must complete the terminator too.
    const bodyWithTools = JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
    })
    shim = makeShim(() => ({ ok: true, response: brokenStreamOf(halfFrame('')) }))
    await shim.ready

    const body = await post(shim, bodyWithTools)
    const events = eventsOf(body)
    expect(events.map(event => event.payload)).toContain('[DONE]')
    expect(events.at(-1)?.payload).toBe('[DONE]')
    for (const event of events) {
      if (event.payload === '[DONE]') continue
      expect(() => JSON.parse(event.payload)).not.toThrow()
    }
  })
})

/** A response whose body is delivered as the given chunks, in order. */
function streamOf(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }))
}
