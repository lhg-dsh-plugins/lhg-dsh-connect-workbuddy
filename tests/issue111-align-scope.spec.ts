/**
 * Issue #111: `alignAssistantIdentities` must only rewrite the messages THIS
 * plugin produced.
 *
 * THE DEFECT. `alignAssistantIdentities()` exists to repair a real problem
 * (issue #102): the host hands back a durable transcript whose
 * `source.provider` is the ROUTE id, while this adapter stamps
 * `provider: WORKBUDDY_MODEL_IDENTITY` on its models — so a global session's
 * historical thinking blocks never matched `isSameModel` and were flattened
 * into plain text on every turn.
 *
 * The repair was applied to EVERY `role: 'assistant'` message. Its docblock
 * justified that with "the transcript never contains another provider's
 * assistant turns (`dsh-llm` splits history by provider before the API sees
 * it)" — and that premise is FALSE. `dsh-llm`'s `forAdapter()` only STRIPS
 * `replayState` from a message whose `source.provider` belongs to another
 * adapter; it keeps the message in the list. So a session that moved between
 * providers hands this adapter foreign assistant turns, and the old code
 * relabelled them as this plugin's own model output.
 *
 * WHY THAT MATTERS. The host clears `replayState` on a foreign turn precisely
 * so it will NOT be replayed as if it came from the current model. Rewriting
 * `provider` to this plugin's identity and `api` to `openai-completions` puts
 * such a turn back into `isSameModel`'s "same model" branch — the door the
 * host had just closed — and makes the transcript assert a provenance that is
 * not true.
 *
 * WHAT THESE TESTS PIN. A message stamped with this bundle's route ids (or
 * already carrying the identity) is aligned as before; a message from any
 * other provider is returned UNCHANGED, both `provider` and `api`.
 *
 * @module dsh-connect-workbuddy/tests/issue111-align-scope
 */

import { describe, expect, it } from 'vitest'
import {
  alignAssistantIdentities,
  WORKBUDDY_GLOBAL_PROVIDER,
  WORKBUDDY_MODEL_IDENTITY,
  WORKBUDDY_PROVIDER,
  HOST_FOREIGN_API,
} from '../src/adapter.ts'
import type { Context } from '@earendil-works/pi-ai'

/** Build a pi-ai-shaped context with the given assistant messages. */
function contextOf(messages: readonly Record<string, unknown>[]): Context {
  return { messages: [...messages] } as unknown as Context
}

/** One assistant message in the shape `foreignAssistant()` produces. */
function assistant(provider: string, api: string = HOST_FOREIGN_API): Record<string, unknown> {
  return {
    role: 'assistant',
    provider,
    api,
    model: 'glm-5.3',
    content: [{ type: 'text', text: 'hi' }],
    usage: { input: 1, output: 1 },
    stopReason: 'stop',
    timestamp: 1,
  }
}

/** The messages after alignment, as plain records. */
function aligned(context: Context): Record<string, unknown>[] {
  return (context.messages as unknown as Record<string, unknown>[])
}

describe('alignAssistantIdentities keeps this plugin\'s own turns aligned (issue #102 stays fixed)', () => {
  it('repairs the CN route id, which differs from the identity only for global', () => {
    // CN is the coincidence case: route id === identity, so only `api` needs
    // the host fallback repaired.
    const input = contextOf([assistant(WORKBUDDY_PROVIDER)])
    const [message] = aligned(alignAssistantIdentities(input))
    expect(message?.['provider']).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(message?.['api']).toBe('openai-completions')
  })

  it('repairs the GLOBAL route id — the case #102 was filed for', () => {
    const input = contextOf([assistant(WORKBUDDY_GLOBAL_PROVIDER)])
    const [message] = aligned(alignAssistantIdentities(input))
    expect(message?.['provider']).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(message?.['api']).toBe('openai-completions')
  })

  it('leaves an already-aligned message untouched, by identity', () => {
    const original = assistant(WORKBUDDY_MODEL_IDENTITY, 'openai-completions')
    const input = contextOf([original])
    // The very same object, i.e. no allocation in the common case.
    expect(aligned(alignAssistantIdentities(input))[0]).toBe(original)
  })
})

describe('alignAssistantIdentities leaves FOREIGN turns alone (issue #111)', () => {
  it('does not relabel a message from another provider', () => {
    // THE DEFECT, EXACTLY. A turn produced by a different provider is kept in
    // the list by the host (`forAdapter` strips only `replayState`), so this
    // adapter sees it — and must not claim it.
    const foreign = assistant('deepseek', HOST_FOREIGN_API)
    const input = contextOf([foreign])
    const [message] = aligned(alignAssistantIdentities(input))
    expect(message?.['provider']).toBe('deepseek')
    expect(message?.['api']).toBe(HOST_FOREIGN_API)
    // Not merely equal — the same object, proving it was not rewritten.
    expect(message).toBe(foreign)
  })

  it('does not rewrite a foreign turn\'s api even when the provider looks close', () => {
    // A provider id that merely CONTAINS this plugin's name is still foreign.
    const foreign = assistant('workbuddy-mirror', HOST_FOREIGN_API)
    const [message] = aligned(alignAssistantIdentities(contextOf([foreign])))
    expect(message?.['provider']).toBe('workbuddy-mirror')
    expect(message?.['api']).toBe(HOST_FOREIGN_API)
  })

  it('leaves a message with no provider at all untouched', () => {
    // Defensive: the field is not guaranteed on every shape that can reach
    // here, and guessing "it must be ours" is how the old bug happened.
    const odd = { role: 'assistant', api: HOST_FOREIGN_API, content: [], model: 'x' }
    const [message] = aligned(alignAssistantIdentities(contextOf([odd])))
    expect(message?.['provider']).toBeUndefined()
    expect(message?.['api']).toBe(HOST_FOREIGN_API)
  })

  it('handles a mixed transcript, aligning only the turns it owns', () => {
    // The realistic shape after a provider switch: our turns AND a foreign
    // one in the same context.
    const ours = assistant(WORKBUDDY_GLOBAL_PROVIDER)
    const theirs = assistant('deepseek', HOST_FOREIGN_API)
    const [first, second] = aligned(alignAssistantIdentities(contextOf([theirs, ours])))
    expect(first?.['provider']).toBe('deepseek')
    expect(first).toBe(theirs)
    expect(second?.['provider']).toBe(WORKBUDDY_MODEL_IDENTITY)
    expect(second?.['api']).toBe('openai-completions')
  })

  it('never touches a non-assistant message', () => {
    const user = { role: 'user', content: 'hi' }
    const tool = { role: 'tool', toolCallId: 'c1', content: [] }
    const [u, t] = aligned(alignAssistantIdentities(contextOf([user, tool])))
    expect(u).toBe(user)
    expect(t).toBe(tool)
  })
})

describe('the owned route set is explicit, not implicit', () => {
  it('accepts an override, so a test or a future bundle can scope it', () => {
    // Pinned because the set is what makes the fix safe: widening it silently
    // would bring the #111 defect back.
    const input = contextOf([assistant('deepseek', HOST_FOREIGN_API)])
    const [message] = aligned(alignAssistantIdentities(input, WORKBUDDY_MODEL_IDENTITY, ['deepseek']))
    // Now `deepseek` IS owned, so it is aligned — the escape hatch works.
    expect(message?.['provider']).toBe(WORKBUDDY_MODEL_IDENTITY)
  })
})
