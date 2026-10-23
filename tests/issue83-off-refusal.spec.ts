/**
 * Issue #83: `off` could be switched on for a model that ALWAYS rejects it, and
 * the level then became the implicit default for every request that named no
 * reasoning tier — which is exactly what a compaction summary is.
 *
 * The reporter's path was:
 *   1. tick 「可关闭思考」 on a row for `deepseek-v4.1-flash` (which answers
 *      HTTP 400 / code 11133 to `reasoning_effort: "off"` on BOTH gateways);
 *   2. `withEffectiveOff()` stamped `canDisableThinking: true` from the saved
 *      selection, overriding the reviewed refusal table;
 *   3. `workBuddyThinkingLevelMap()` then mapped `off → "off"`;
 *   4. pi-ai's `openai-completions` reads `model.thinkingLevelMap?.off` whenever
 *      the caller passes NO `reasoningEffort`, and compaction never does;
 *   5. every `/compact` for that model failed, with the surface showing only
 *      "Compaction could not produce a useful summary".
 *
 * These tests pin the REQUEST, because that is where the failure happened: a
 * stamped level alone proves nothing if it still reaches the wire. The body is
 * built by the REAL pi-ai api through the REAL adapter, with the fetch injected,
 * so the assertions read the JSON the upstream would have counted.
 *
 * Both barriers are covered separately because they fail independently:
 *   - the stamping wall  → no `off` is ever OFFERED for a tabled id;
 *   - the request guard  → no `off` ever REACHES the wire, even if something
 *     upstream of the shim still set it.
 */

import { describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { withEffectiveOff } from '../src/off-thinking.ts'
import { prepareChatBody } from '../src/upstream.ts'
import { piAiRuntimeInfo } from '../src/pi-ai-runtime.ts'

/** A tabled id: measured to refuse `off` on both gateways (issue #34). */
const REFUSING = 'deepseek-v4.1-flash'
/** An id the table has not learned about; the user's answer must still win. */
const ACCEPTING = 'glm-5.3'

const MODEL = {
  id: 'hy3',
  name: 'hy3',
  api: 'openai-completions',
  provider: WORKBUDDY_PROVIDER,
  baseUrl: 'http://127.0.0.1:9/v1',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1000,
  compat: {},
} as never

/**
 * A compaction-shaped context: one system message and a transcript, and — the
 * point of the test — NO reasoning effort, which is what `summarizeWithLlm`
 * sends.
 */
function compactionContext(): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: 'Summarize the conversation.', timestamp: 0 },
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    ],
  }
}

interface Captured {
  body: Record<string, unknown> | undefined
  errors: string[]
}

/**
 * Drive the REAL pi-ai api through the REAL adapter for one catalog model and
 * capture the body it would send.
 *
 * The model comes from the ADAPTER, not from a hand-written literal: the level
 * map, `compat` and `reasoning` flag the api branches on are all derived there,
 * so a profile-level fix (the default tier) is invisible to any test that
 * supplies its own descriptor.
 */
async function captureBody(modelId: string): Promise<Captured> {
  const catalog = new WorkBuddyCatalog()
  catalog.set(CATALOG)
  const { adapter } = createWorkBuddyAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
    store: {} as never,
    catalog,
    piAiGeneration: piAiRuntimeInfo().generation,
  })
  const profile = (adapter as unknown as {
    config: { profiles: () => ReadonlyMap<string, { piProvider: { getModels: () => unknown[], streamSimple: (m: unknown, c: unknown, o: unknown) => unknown } }> }
  }).config.profiles().get(WORKBUDDY_PROVIDER)
  expect(profile).toBeDefined()
  const descriptor = profile?.piProvider.getModels()
    .find(model => (model as { id?: string }).id === modelId)
  expect(descriptor, `no descriptor for ${modelId}`).toBeDefined()

  let body: Record<string, unknown> | undefined
  const errors: string[] = []
  // No `reasoningEffort` on purpose: this is what a compaction summary sends,
  // and the absence is the whole trigger for issue #83.
  const stream = profile?.piProvider.streamSimple(descriptor, compactionContext(), {
    apiKey: 'k',
    maxTokens: 10,
    fetch: async (_url: unknown, init: { body?: unknown }) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      throw new Error('captured before any network')
    },
  }) as AsyncIterable<{ type?: string, error?: { errorMessage?: string } }>
  for await (const event of stream) {
    if (event?.type === 'error') errors.push(String(event.error?.errorMessage ?? 'unknown stream error'))
  }
  return { body, errors }
}

/**
 * A one-model catalog that DECLARES `off` usable and whose id is `id`.
 *
 * The declaration is the trap: the upstream reports `canDisableThinking: true`
 * for the refusing ids too, so a level map built from the declaration alone
 * offers `off` exactly where it always fails.
 */
const CATALOG = [
  { id: REFUSING, name: 'Deepseek-V4.1-Flash', contextWindow: 200_000, maxTokens: 32_000, reasoning: { supportedEfforts: ['low', 'medium', 'high'], canDisableThinking: true } },
]

/** Build a pi-ai-shaped model whose level map comes from the plugin adapter. */
function levelMapFor(modelId: string, ticked: boolean) {
  // The path production takes: the saved selection is stamped onto the catalog
  // descriptor FIRST, and the adapter derives the level map from that.
  const [stamped] = withEffectiveOff(
    [{ id: modelId, reasoning: { supportedEfforts: ['low', 'medium', 'high'], canDisableThinking: true } }],
    new Set(ticked ? [modelId] : []),
  )
  return stamped
}

describe('issue #83: the adapter does not offer off at all for a tabled id', () => {
  it('maps off to null even though the user ticked it', async () => {
    const { workBuddyThinkingLevelMap } = await import('../src/adapter.ts')
    const model = levelMapFor(REFUSING, true)
    expect(model?.reasoning?.canDisableThinking).toBe(false)
    const map = workBuddyThinkingLevelMap(model as never)
    expect(map?.off).toBeNull()
  })

  it('still maps off through for a model the table does not list', async () => {
    const { workBuddyThinkingLevelMap } = await import('../src/adapter.ts')
    const model = levelMapFor(ACCEPTING, true)
    expect(workBuddyThinkingLevelMap(model as never)?.off).toBe('off')
  })
})

describe('issue #83: a compaction request carries no "off"', () => {
  it('sends no reasoning_effort at all for a model that declares off but refuses it', async () => {
    // THE REPORTED FAILURE at the wire. The catalog declares
    // `canDisableThinking: true` (the upstream does this for the refusing nine),
    // so without the wall the level map carries `off → "off"` and pi-ai fills it
    // in for this request, which names no tier. The upstream answers 400 / 11133
    // and `/compact` fails on every attempt.
    const captured = await captureBody(REFUSING)
    expect(captured.body, `no request was built; stream errors: ${captured.errors.join(' | ')}`).toBeDefined()
    expect(captured.body?.['reasoning_effort']).toBeUndefined()
  })

  it('never sends a thinking-disable marker either', async () => {
    // `reasoning_effort` is not the only shape this setting takes: pi-ai's other
    // thinking formats send a nested object or a budget. Whichever shape the api
    // picked, a compaction request must not carry "thinking disabled".
    const captured = await captureBody(REFUSING)
    expect(captured.body?.['thinking']).not.toMatchObject({ type: 'disabled' })
    expect(String(captured.body?.['reasoning_effort'] ?? '')).not.toBe('off')
  })
})

describe('issue #83: prepareChatBody strips a refused tier the catalog could not know about', () => {
  it('drops reasoning_effort "off" for a tabled model', () => {
    // The escape route the request guard closes: failover re-points the body at
    // another account's model, and `primary-model` is an alias the gateway
    // resolves — so a bare "off" can arrive after the catalog was built.
    const body = prepareChatBody(JSON.stringify({
      model: REFUSING,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    }))
    expect(JSON.parse(body)).not.toHaveProperty('reasoning_effort')
    expect(JSON.parse(body)).toMatchObject({ model: REFUSING })
  })

  it('leaves "off" alone for a model that accepts it', () => {
    const body = prepareChatBody(JSON.stringify({
      model: ACCEPTING,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'off',
    }))
    expect(JSON.parse(body)).toMatchObject({ reasoning_effort: 'off' })
  })

  it('never touches any other effort value', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const body = prepareChatBody(JSON.stringify({
        model: REFUSING,
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: effort,
      }))
      expect(JSON.parse(body), effort).toMatchObject({ reasoning_effort: effort })
    }
  })

  it('does not invent an effort on a body that named none', () => {
    // Stripping is not a rewrite: a request with no tier must come out with no
    // tier, or the plugin would be choosing how the model thinks.
    const body = prepareChatBody(JSON.stringify({ model: REFUSING, messages: [] }))
    expect(JSON.parse(body)).not.toHaveProperty('reasoning_effort')
  })
})
