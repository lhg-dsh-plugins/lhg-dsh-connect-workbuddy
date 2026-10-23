/**
 * A queue is reported ONCE, and no client above the plugin retries it
 * (2026-10-22, at the maintainer's request).
 *
 * THE DEFECT, in two halves that had to be fixed together.
 *
 * 1. The sentence said 「约 N 秒后自动重试」. Nothing retried: this plugin has no
 *    queue-polling loop and never resends (see "WHAT THIS MODULE DOES NOT DO
 *    YET" in `src/queue.ts`). That was the promise that had to go.
 * 2. The 429 carrying it invited EVERY layer above the plugin to retry anyway.
 *    `@deepseek-ai/dsh-llm` maps status 429 to the `RATE_LIMIT` code, `RATE_LIMIT`
 *    is in its `DEFAULT_RETRYABLE_CODES`, and the host therefore runs five
 *    in-place attempts with 0.5s→8s backoff — roughly 15 seconds, against a
 *    queue reported in thousands. Each attempt is a real request spent to be
 *    told the same position again.
 *
 * So the sentence stops promising and the response says `x-should-retry: false`,
 * which both clients in this stack honour BEFORE their status-based rules. The
 * two changes are one decision: a diagnostic that declares itself final must
 * actually be final.
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

/** The reporter's shape from issue #94: 8,777th of 9,021, retry_after 7. */
const WAITING_BODY = JSON.stringify({
  code: 6020,
  msg: 'queueing',
  data: { queue_position: 8777, queue_size: 9021, retry_after: 7 },
})

/** A queue rides on whatever status the gateway chose; 200 is measured. */
const QUEUED: WorkBuddyChatResult = { ok: false, status: 200, kind: 'model_queue', message: WAITING_BODY }

function mount(result: WorkBuddyChatResult): WorkBuddyShim {
  const client = { chatStream: async () => result } as unknown as WorkBuddyUpstreamClient
  return createWorkBuddyShim({ store, client, catalog: new WorkBuddyCatalog() })
}

async function request(instance: WorkBuddyShim): Promise<Response> {
  await instance.ready
  return await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
      stream: true,
    }),
  })
}

describe('a queued request is reported once and not retried', () => {
  it('sets x-should-retry: false, which the clients check BEFORE their status rules', async () => {
    // Without this the 429 becomes RATE_LIMIT in the host's classifier, and
    // RATE_LIMIT is in its retry set purely on the strength of the status.
    const instance = mount(QUEUED)
    shim = instance
    const response = await request(instance)
    expect(response.status).toBe(429)
    expect(response.headers.get('x-should-retry')).toBe('false')
  })

  it('also sends retry-after: 0, the standard spelling of the same instruction', async () => {
    // A client that honours `Retry-After` over the vendor header would otherwise
    // still wait before collecting the same refusal.
    const instance = mount(QUEUED)
    shim = instance
    expect((await request(instance)).headers.get('retry-after')).toBe('0')
  })

  it('does not forward the upstream retry_after, because no wait would help', async () => {
    // Seven seconds cannot clear a queue of 9,021 either; forwarding it would
    // only make the client wait before being told the same thing.
    const instance = mount(QUEUED)
    shim = instance
    const retryAfter = (await request(instance)).headers.get('retry-after')
    expect(retryAfter).not.toBe('7')
    expect(Number(retryAfter)).toBe(0)
  })

  it('still reports the position and the queue size in the message', async () => {
    // Removing the false promise must not remove the diagnostic: knowing you are
    // 8,777th is the entire answer to "wait or switch".
    const instance = mount(QUEUED)
    shim = instance
    const text = await (await request(instance)).text()
    expect(text).toContain('8777')
    expect(text).toContain('9021')
  })

  it('does not promise an automatic retry in the message either', async () => {
    // A message and a header that disagree about whether a retry happens would
    // be worse than either alone.
    const instance = mount(QUEUED)
    shim = instance
    const text = await (await request(instance)).text()
    expect(text).not.toContain('自动重试')
  })

  it('leaves OTHER 429s retryable, so the suppression is not blanket', async () => {
    // `model_busy` (14003) is a MODEL-scoped throttle that genuinely clears in
    // about a minute, and the host's retry is the right response to it.
    // Suppressing retries for both would turn a recoverable throttle into an
    // instant failure — the opposite of this change's intent.
    const busy: WorkBuddyChatResult = {
      ok: false,
      status: 429,
      kind: 'model_busy',
      message: JSON.stringify({ code: 14003, msg: 'model busy', displayMsg: { zh: '模型繁忙' } }),
    }
    const instance = mount(busy)
    shim = instance
    const response = await request(instance)
    expect(response.status).toBe(429)
    expect(response.headers.get('x-should-retry')).toBeNull()
  })
})
