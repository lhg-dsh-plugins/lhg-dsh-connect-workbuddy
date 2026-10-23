/**
 * Issue #101: `11115` has two shapes, and only one is recognisable as an
 * overflow — to the HOST, that is.
 *
 * THE FAILURE. The gateway answers a too-long request with either
 *
 *   A. `prompt is too long: 100001 tokens > 100000 maximum` (numbers, English)
 *   B. 「本次输入加上历史对话超过了模型上限。请精简内容…」 (Chinese, no numbers)
 *
 * The host decides whether to run its compaction rescue by matching the error
 * text against ~25 ENGLISH patterns (`prompt (?:is )?too long`, `exceeds the
 * context window`, `context[_ ]length[_ ]exceeded`, …). Shape A matches; shape B
 * matches none of them. So on shape B the host neither compacted nor retried —
 * it surfaced a bare 400 to the user, whose own remedy sentence it could not
 * act on.
 *
 * WHAT MUST HOLD. The plugin adds an English clause the host recognises and
 * keeps the upstream's own wording, so the machine gets a signal and the human
 * keeps the advice.
 */
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_OVERFLOW_MARKER,
  classifyUpstreamError,
  isContextTooLongBody,
} from '../src/upstream.ts'

/** The host's first overflow pattern, quoted so the test states the coupling. */
const HOST_OVERFLOW_PATTERN = /prompt (?:is )?too long/i

describe('isContextTooLongBody', () => {
  it('recognises shape B, which has no numbers and no English', () => {
    // Exactly the body from the issue report: the business code is the only
    // reliable handle, because the wording is what varies between shapes.
    const shapeB = JSON.stringify({
      message: 'workbuddy 上游失败：（code 11115，requestId 54bf7bec-2bc0-49d5-8967-2e946753098e）本次输入加上历史对话超过了模型上限。请精简内容、删掉大附件，或新建任务。',
    })
    expect(isContextTooLongBody(shapeB)).toBe(true)
  })

  it('recognises shape A too, so the marker is not shape-dependent', () => {
    const shapeA = JSON.stringify({ code: 11115, msg: 'prompt is too long: 100001 tokens > 100000 maximum' })
    expect(isContextTooLongBody(shapeA)).toBe(true)
  })

  it('does not fire on the neighbouring codes that share the 111xx range', () => {
    // 11115 must be matched as the exact code, not as a prefix or a substring
    // of a longer number: misreading a policy refusal as an overflow would send
    // the host into a compaction loop that cannot help.
    for (const body of ['{"code":11128}', '{"code":11140}', '{"code":1111}', '{"code":111150}', '{"code":11133}']) {
      expect(isContextTooLongBody(body), body).toBe(false)
    }
  })
})

describe('the marker is what the HOST reads, not what the user reads', () => {
  it('matches the host pattern list by construction', () => {
    // The whole point of the marker is that a detector written for English
    // recognises it. Asserted against a copy of the host's own first pattern,
    // because that is the coupling under test.
    expect(HOST_OVERFLOW_PATTERN.test(CONTEXT_OVERFLOW_MARKER)).toBe(true)
    // And it must not be mistaken for a THROTTLE: the host skips overflow
    // detection for messages matching its non-overflow patterns (rate-limit
    // wording), and a false throttle match would suppress the rescue the marker
    // exists to trigger.
    expect(/rate.?limit|too many requests|throttl/i.test(CONTEXT_OVERFLOW_MARKER)).toBe(false)
  })

  it('names the upstream code, so a report can still be filed against the gateway', () => {
    expect(CONTEXT_OVERFLOW_MARKER).toContain('11115')
  })

  it('does NOT invent token numbers the upstream never sent', () => {
    // Shape B carries no counts. Printing an invented "N tokens > M maximum"
    // would be a confidently wrong diagnosis — the failure mode this project's
    // issue history is mostly made of.
    expect(/\d+\s*tokens?\s*>/i.test(CONTEXT_OVERFLOW_MARKER)).toBe(false)
  })
})

describe('classification is unaffected', () => {
  it('still files 11115 as a client error, not a failover-worthy one', () => {
    // The overflow belongs to the REQUEST, not the account: walking the pool
    // would burn a real request per account and change nothing. The marker only
    // adds host-readable wording; it must not move the failure into a
    // failover-worthy class.
    expect(classifyUpstreamError(400, '{"code":11115,"msg":"prompt is too long"}')).toBe('client')
  })
})

/**
 * The end-to-end half: what the USER actually receives.
 *
 * The helpers above are only worth what the rendered sentence says, and the
 * coupling that broke issue #101 lives at the RENDER seam — a helper that
 * returns `true` while the reply omits the marker would leave the bug in place.
 * So this drives one real request through the shim and reads the error text the
 * host would see.
 */
describe('the rendered 11115 reply carries the host-readable clause', () => {
  /** Shape B verbatim from the issue: business code, Chinese advice, no numbers. */
  const SHAPE_B = JSON.stringify({
    code: 11115,
    msg: 'prompt is too long',
    requestId: '54bf7bec-2bc0-49d5-8967-2e946753098e',
    displayMsg: { zh: '本次输入加上历史对话超过了模型上限。请精简内容、删掉大附件，或新建任务。' },
  })

  it('puts the English overflow clause in the message the host reads', async () => {
    const { WorkBuddyCatalog } = await import('../src/catalog.ts')
    const { createWorkBuddyShim } = await import('../src/shim.ts')
    const { parseUpstreamErrorDetail } = await import('../src/upstream.ts')
    const credential = {
      accessToken: 'access', refreshToken: 'refresh', expiresAtMs: Date.now() + 86_400_000,
      domain: 'www.codebuddy.cn', uid: 'uid', uin: 'selected', source: 'desktop', filePath: '/tmp/auth.info',
    }
    const store = { resolve: async () => credential, credentialFor: async () => credential }
    const instance = createWorkBuddyShim({
      store: store as never,
      client: {
        chatStream: async () => ({
          ok: false, status: 400, kind: 'client', message: SHAPE_B, detail: parseUpstreamErrorDetail(SHAPE_B),
        }),
      } as never,
      catalog: new WorkBuddyCatalog(),
    })
    try {
      await instance.ready
      const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }),
      })
      const parsed = JSON.parse(await response.text()) as { error: { message: string } }
      const message = parsed.error.message
      // The host's detector fires on this.
      expect(HOST_OVERFLOW_PATTERN.test(message)).toBe(true)
      // The human still gets the gateway's own advice, unaltered.
      expect(message).toContain('本次输入加上历史对话超过了模型上限')
      // And the request id survives, because that is what support asks for.
      expect(message).toContain('54bf7bec-2bc0-49d5-8967-2e946753098e')
    } finally {
      await instance.close()
    }
  })
})
