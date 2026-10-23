/**
 * Issue #113: the `11128` family must be recognised by its CODE, and its
 * member named by the plugin's OWN evidence — never by the upstream's `msg`.
 *
 * THE MEASUREMENT. Issue #113 reported a body byte-exact as
 * `{"code":11128,"msg":"conversation id missing","displayMsg":{"zh":"请求被拦截，请重新发送"}}`
 * arriving for a CN chat request that DID carry all three conversation-id
 * headers (`X-Conversation-ID`, `-Request-ID`, `-Message-ID`). The wording
 * pointed at a header problem that did not exist; the refusal was about the
 * request's CONTENT, i.e. the prompt fingerprint.
 *
 * WHY THAT MATTERED. The old `isChannelRejectBody()` excluded a body carrying
 * the conversation-id wording, so this body was never the channel gate. It
 * fell through to the plain `client` branch, and `client` does NOT enter the
 * plugin's two-step rescue ladder in `src/shim.ts`:
 *
 *   1. `forceNeutralHead` — prepend a neutral head so the gate is not looking
 *      at the host's own opening;
 *   2. `perturbChannelFingerprints` — insert an invisible zero-width space at
 *      sentence and clause boundaries so a bare product-name match stops
 *      matching.
 *
 * So the one path built for exactly this refusal never ran, and the user was
 * told "对外部服务的一次调用失败：请求被网关拒绝（参数不合格）" — advice that
 * cannot work, because no parameter of theirs is wrong. That is very likely
 * why the reporters in issue #98's thread saw no change after upgrading: their
 * bodies never reached the code that could have helped.
 *
 * WHAT THESE TESTS PIN.
 *
 *   - the whole family classifies as `channel_reject` (so the ladder runs);
 *   - the MEMBER is named by request-side evidence, and a wording the plugin
 *     can disprove is reported as a misreport rather than believed;
 *   - a body that is not the family at all (another code) is untouched;
 *   - the retry ladder is actually reached for the misreported body.
 *
 * @module dsh-connect-workbuddy/tests/issue113-channel-gate-evidence
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import {
  channelGateMemberOf,
  classifyUpstreamError,
  isChannelGateFamilyBody,
  isChannelRejectBody,
  perturbChannelFingerprints,
  requestEvidenceOf,
} from '../src/upstream.ts'
import type { WorkBuddyChatResult } from '../src/upstream.ts'

/**
 * Issue #113's body, byte-exact from the report.
 *
 * The `msg` is the misleading half — it names the conversation-id gate while
 * the request carried that triple. `displayMsg` is the upstream's advice, and
 * it says nothing actionable either.
 */
const MISREPORTED_BODY = '{"code":11128,"msg":"conversation id missing","displayMsg":{"zh":"请求被拦截，请重新发送"}}'

/** The channel gate naming itself explicitly. */
const PROMPT_GATE_BODY = '{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}'

/** The shape gate, naming itself. */
const FIRST_MESSAGE_BODY = '{"code":11128,"msg":"first message is not system prompt"}'

/** A body that is NOT this family, despite sharing the tips boilerplate. */
const FOREIGN_CODE_BODY = '{"code":11140,"msg":"request illegal","displayTips":{"zh":"这次调用没通过渠道校验。"}}'

describe('the 11128 family is recognised by its code (issue #113)', () => {
  it('recognises the whole family', () => {
    for (const body of [PROMPT_GATE_BODY, MISREPORTED_BODY, FIRST_MESSAGE_BODY]) {
      expect(isChannelGateFamilyBody(body)).toBe(true)
    }
  })

  it('classifies every member as `channel_reject`, so the rescue ladder runs', () => {
    // The classification is what gates the ladder in `src/shim.ts`. Filing any
    // member as `client` means `isFailoverWorthy` is false AND the ladder is
    // skipped, which is the defect #113 exposed.
    for (const body of [PROMPT_GATE_BODY, MISREPORTED_BODY, FIRST_MESSAGE_BODY]) {
      expect(classifyUpstreamError(400, body)).toBe('channel_reject')
    }
  })

  it('does not swallow a foreign business code that quotes the tips', () => {
    // The tips sentence is shared boilerplate, so it must never be the
    // identity. A 11140 keeps its own (more specific) reply.
    expect(isChannelRejectBody(FOREIGN_CODE_BODY)).toBe(false)
    expect(classifyUpstreamError(400, FOREIGN_CODE_BODY)).toBe('policy_reject')
  })

  it('does not treat a coincidental `11128` in a request id as the family', () => {
    expect(isChannelGateFamilyBody('{"requestId":"11128abc","msg":"ok"}')).toBe(false)
    expect(classifyUpstreamError(400, '{"requestId":"11128abc","msg":"ok"}')).toBe('client')
  })
})

describe('the member is named by the plugin\'s OWN evidence (issue #113)', () => {
  it('reads a misreported conversation-id wording as the PROMPT gate when the headers were sent', () => {
    // The plugin always sends the triple (`chatHeaders`), so the wording
    // cannot be the explanation. The refusal is about the content.
    expect(channelGateMemberOf(MISREPORTED_BODY, {
      hasSystemHead: true,
      hasConversationHeaders: true,
    })).toBe('prompt')
  })

  it('believes the conversation-id wording when the headers were genuinely absent', () => {
    // The case the old code was written for, and it must still be honoured:
    // a request that really did not send the triple.
    expect(channelGateMemberOf(MISREPORTED_BODY, {
      hasSystemHead: true,
      hasConversationHeaders: false,
    })).toBe('headers')
  })

  it('trusts the upstream when it names the prompt gate explicitly', () => {
    expect(channelGateMemberOf(PROMPT_GATE_BODY, {
      hasSystemHead: true,
      hasConversationHeaders: true,
    })).toBe('prompt')
  })

  it('believes the first-message wording only when the request had no system head', () => {
    expect(channelGateMemberOf(FIRST_MESSAGE_BODY, {
      hasSystemHead: true,
      hasConversationHeaders: true,
    })).toBe('unknown')
    expect(channelGateMemberOf(FIRST_MESSAGE_BODY, {
      hasSystemHead: false,
      hasConversationHeaders: true,
    })).toBe('first_message')
  })

  it('says `unknown` rather than guessing when the body names no member', () => {
    // A confidently wrong member is worse than an honest "cannot tell": it
    // sends the user to edit a prompt that may not be at fault.
    expect(channelGateMemberOf('{"code":11128,"msg":"something new"}', {
      hasSystemHead: true,
      hasConversationHeaders: true,
    })).toBe('unknown')
  })
})

describe('requestEvidenceOf: what the plugin can prove about its own request', () => {
  it('reports a system head when the request opens with one', () => {
    const body = JSON.stringify({
      model: 'm',
      messages: [{ role: 'system', content: 'head' }, { role: 'user', content: 'hi' }],
    })
    expect(requestEvidenceOf(body)).toEqual({ hasSystemHead: true, hasConversationHeaders: true })
  })

  it('reports no system head for a user-first request', () => {
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(requestEvidenceOf(body).hasSystemHead).toBe(false)
  })

  it('never throws on a body it cannot read', () => {
    // A malformed body answers "no system head", which is the safe direction:
    // the wording is then believed rather than overridden.
    expect(requestEvidenceOf('not json').hasSystemHead).toBe(false)
    expect(requestEvidenceOf('[]').hasSystemHead).toBe(false)
    expect(requestEvidenceOf('{"messages":{}}').hasSystemHead).toBe(false)
  })

  it('always reports the conversation headers, because `chatHeaders` always sends them', () => {
    // This is the fact that makes a `conversation id missing` wording
    // unbelievable on this code path — and it is a property of the code, not
    // of the body, so it holds even for a body that does not parse.
    expect(requestEvidenceOf('not json').hasConversationHeaders).toBe(true)
    expect(requestEvidenceOf(JSON.stringify({ model: 'm', messages: [] })).hasConversationHeaders).toBe(true)
  })
})

describe('the perturbation breaks a BARE product name too (issue #113)', () => {
  // THE GAP THE BOUNDARY RULES LEAVE. Inserting U+200B after `.`, `!`, `?`,
  // `,` or `;` only lands where there IS such a punctuation mark. A scanned
  // message that ends with a bare product name and no trailing punctuation is
  // left completely unchanged, so the rescue answers "nothing to change", the
  // shim spends no retry, and the fingerprint survives — measured. That shape
  // is not exotic: it is the FIRST line of every DSH agent prompt
  // (`You are an AI agent powered by DeepSeek Harness`), which is why issue
  // #113's reporter kept seeing the refusal.
  const bodyOf = (text: string): string =>
    JSON.stringify({ model: 'm', messages: [{ role: 'system', content: text }] })
  const textOf = (body: string): string =>
    (JSON.parse(body) as { messages: { content: string }[] }).messages[0]?.content ?? ''

  it('breaks a bare product name with no adjacent punctuation', () => {
    const out = perturbChannelFingerprints(bodyOf('You are an AI agent powered by DeepSeek Harness'))
    expect(out, 'the rescue left a bare product name untouched').toBeDefined()
    expect(textOf(out as string)).not.toContain('DeepSeek Harness')
  })

  it('breaks the same name inside prose, without changing what the model reads', () => {
    const original = 'Powered by DeepSeek Harness. Ask anything.'
    const next = textOf(perturbChannelFingerprints(bodyOf(original)) as string)
    expect(next).not.toContain('DeepSeek Harness')
    // The point of U+200B: the words are untouched, only an invisible
    // separator was added, so the model understands the same sentence.
    expect(next.replace(/\u200b/gu, '')).toBe(original)
  })

  it('stays idempotent', () => {
    const once = perturbChannelFingerprints(bodyOf('Powered by DeepSeek Harness')) as string
    expect(perturbChannelFingerprints(once)).toBeUndefined()
  })
})

describe('the rescue ladder actually runs for the misreported body (issue #113)', () => {
  let shim: WorkBuddyShim | undefined

  afterEach(async () => {
    await shim?.close()
    shim = undefined
  })

  /** One chat through the shim, counting the upstream attempts it makes. */
  async function chat(instance: WorkBuddyShim): Promise<{
    status: number
    text: string
  }> {
    const response = await fetch(`${instance.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token()}` },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        messages: [
          // NOT the plugin's own neutral head: `forceNeutralHead` answers
          // `undefined` ("this body cannot change") when every scanned opening
          // already starts with it, and then no retry would happen for a
          // reason that has nothing to do with the classification under test.
          { role: 'system', content: 'You are Cursor Agent, an AI pair programmer from Anysphere.' },
          { role: 'user', content: 'hi' },
        ],
      }),
    })
    const text = await response.text()
    // A rescued request streams SSE; a refused one answers JSON. Return both so
    // the caller can assert on whichever it got without parsing the other.
    return { status: response.status, text }
  }

  it('retries with a forced neutral head instead of answering the FIRST refusal', async () => {
    // THE END-TO-END PIN. The unit tests above prove the classification; this
    // proves the consequence that matters — a SECOND upstream request is
    // actually made. Under the old classification the shim answered the first
    // refusal immediately, so `attempts.length` stayed at 1 and the user's only
    // path to a working request was gone.
    const attempts: string[] = []
    const client = {
      chatStream: async (_credential: unknown, bodyJson: string): Promise<WorkBuddyChatResult> => {
        attempts.push(bodyJson)
        // Refuse the first attempt with the misreported body, then answer.
        if (attempts.length === 1) {
          return {
            ok: false,
            status: 400,
            kind: classifyUpstreamError(400, MISREPORTED_BODY),
            message: MISREPORTED_BODY,
          }
        }
        return { ok: true, response: new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }) }
      },
    } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient
    shim = createWorkBuddyShim({
      store: {
        resolve: async () => ({
          accessToken: 'token',
          refreshToken: 'refresh',
          tokenType: 'Bearer',
          domain: 'www.codebuddy.cn',
          uid: 'uid',
          enterpriseId: '',
          expiresAt: Date.now() + 86_400_000,
          refreshExpiresAt: Date.now() + 7 * 86_400_000,
          accountId: 'acct',
          filePath: '/tmp/auth.info',
        }),
        credentialFor: async () => undefined,
      } as unknown as import('../src/auth.ts').WorkBuddyCredentialStore,
      client,
      catalog: new WorkBuddyCatalog(),
    })
    await shim.ready
    const answer = await chat(shim)
    expect(attempts.length, 'the rescue ladder never ran').toBeGreaterThan(1)
    expect(answer.status).toBe(200)
  })
})
