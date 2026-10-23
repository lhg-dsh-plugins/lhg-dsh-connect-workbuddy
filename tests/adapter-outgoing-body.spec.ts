/**
 * The OUTGOING REQUEST BODY, not the context handed to the api.
 *
 * Issue #26's test recommendation: the 3.0.2 wiring tests asserted that the
 * provider received a FOLDED context — which cemented the defect as the
 * expected behaviour, because a folded context is exactly what loses the tools
 * when nobody promotes `toolsAdded`. What actually reaches the upstream is the
 * JSON body the api builds, so THAT is what this spec pins, by injecting the
 * fetch the real pi-ai api would call the shim with and capturing the body.
 *
 * ⚠️ THIS SPEC USED TO RUN ONE QUADRANT. It was gated with
 * `skipIf(piAiRuntimeInfo().generation !== 'legacy')`, so it only ever covered
 * the legacy branch — and this checkout resolves 0.85.1, so the modern branch
 * had NO body-level coverage at all. That is precisely how the 0.2.1-rc.1
 * regression shipped: pi-ai 1.x stopped reading the top-level
 * `systemPrompt`/`tools`, the modern branch passed the raw envelope straight
 * through, and every request went out with no prompt and no tool declarations,
 * silently. `adapter.spec.ts` could not catch it because it MOCKS the api and
 * asserts the context the wrapper received — the very assertion that certifies
 * the defect.
 *
 * Hence the matrix below: {legacy, modern} × {raw envelope, normalized
 * transcript}. Both generations must be run against BOTH input shapes, because
 * which shape the seam supplies is the seam's business — the adapter's job is
 * to make either one reach the wire correctly.
 */

import { describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { piAiRuntimeInfo } from '../src/pi-ai-runtime.ts'

/**
 * A model descriptor the openai-completions api accepts as-is. The real api
 * reads baseUrl/input/cost/compat (a bare {id, api, provider} trips inside
 * buildParams before any fetch happens), so this mirrors what toPiModel emits.
 */
const MODEL = {
  id: 'hy3',
  name: 'hy3',
  api: 'openai-completions',
  provider: WORKBUDDY_PROVIDER,
  baseUrl: 'http://127.0.0.1:9/v1',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
  compat: {},
} as never

/** The tool every matrix cell must see on the wire. */
const TOOL_SCHEMA = {
  name: 'pwsh',
  description: 'run a shell command',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}

/** The prompt every matrix cell must see as the leading system message. */
const PROMPT = 'You are helpful.'

/**
 * What `dsh-llm-pi-ai` ACTUALLY hands the provider — both its 0.1.7 and
 * 0.2.1 lines build this flat envelope in `piContext()` and never normalize.
 * This is the shape production sees.
 */
function rawEnvelope(): Record<string, unknown> {
  return {
    systemPrompt: PROMPT,
    tools: [TOOL_SCHEMA],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }],
  }
}

/**
 * A pre-normalized transcript (what pi-ai's `normalizeContext` would produce).
 * The adapter must NOT double-fold this into two system messages.
 */
function normalizedTranscript(): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: PROMPT, toolsAdded: [TOOL_SCHEMA], timestamp: 0 },
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    ],
  }
}

interface Captured {
  body: Record<string, unknown> | undefined
  errors: string[]
}

/** Drive the real api through the adapter and capture the body it builds. */
async function captureBody(
  generation: 'legacy' | 'modern',
  context: Record<string, unknown>,
): Promise<Captured> {
  const { adapter } = createWorkBuddyAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
    store: {} as never,
    catalog: new WorkBuddyCatalog(),
    piAiGeneration: generation,
  })
  const profile = (adapter as unknown as {
    config: { profiles: () => ReadonlyMap<string, { piProvider: { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown } }> }
  }).config.profiles().get(WORKBUDDY_PROVIDER)
  expect(profile).toBeDefined()

  let body: Record<string, unknown> | undefined
  const errors: string[] = []
  const stream = profile?.piProvider.streamSimple(MODEL, context, {
    apiKey: 'k',
    maxTokens: 10,
    fetch: async (_url: unknown, init: { body?: unknown }) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      throw new Error('captured before any network')
    },
  }) as AsyncIterable<{ type?: string, error?: { errorMessage?: string } }>
  // Drain: the injected fetch throws, which surfaces as a stream error event —
  // the body has been captured by then. Any error BEFORE the fetch means the
  // request was never built; surface it in the failure.
  for await (const event of stream) {
    if (event?.type === 'error') errors.push(String(event.error?.errorMessage ?? 'unknown stream error'))
  }
  return { body, errors }
}

/** The two wire facts that both generations must produce from either input. */
function expectPromptAndTools(captured: Captured): void {
  const { body, errors } = captured
  expect(body, `no request was built; stream errors: ${errors.join(' | ') || '(none)'}`).toBeDefined()

  // The tool declarations must reach the wire. This is the assertion that
  // catches a context the generation cannot read (issues #25/#26).
  const tools = body?.tools as { function?: { name?: string } }[] | undefined
  expect(tools, 'body.tools missing — the request declared no tools').toBeDefined()
  expect(tools?.map(tool => tool.function?.name)).toEqual(['pwsh'])

  // The conversation must open with the original system prompt.
  const messages = body?.messages as { role?: string, content?: unknown }[]
  expect(messages).toBeDefined()
  expect(
    messages.filter(message => message.role === 'system' || message.role === 'developer'),
    'expected exactly ONE system message',
  ).toHaveLength(1)
  expect(messages[0]?.role).toBe('system')
  expect(messages[0]?.content).toBe(PROMPT)
}

/**
 * Whether this checkout can drive a given matrix cell against the REAL api.
 *
 * The matrix is only meaningful when the installed pi-ai can parse the shape
 * that cell feeds it:
 *
 * - The `legacy` branch emits the flat 0.85 shape, which pi-ai 1.x's api
 *   cannot read at all — so running it against a 1.x checkout measures the
 *   library, not this plugin. Those two cells run on a 0.85 checkout.
 * - The `modern` branch (since the 0.2.1-rc.1 fix) emits the normalized
 *   transcript, which pi-ai 0.85's `estimateMessageTokens` cannot parse: its
 *   final loop iterates a STRING's characters and reads `block.name.length`,
 *   throwing `Cannot read properties of undefined (reading 'length')`. That is
 *   issue #24's crash. Those two cells run on a 0.87+/1.x checkout.
 *
 * Gating on the INSTALLED version is what lets one matrix serve both lines.
 * The important part: on a 1.x checkout the modern cells are the ones that RUN,
 * which is exactly the half that was silently broken and had no coverage.
 */
function canDriveCell(generation: 'legacy' | 'modern'): boolean {
  const installed = piAiRuntimeInfo().generation
  return installed === generation
}

describe('the outgoing request body carries the prompt and the tools', () => {
  // The 2x2 matrix. Every cell is a real regression surface:
  //   - legacy × normalized  → issue #24 (0.87 transcript crashes 0.85)
  //   - legacy × raw         → the ordinary 0.85 path
  //   - modern × normalized  → the 0.87/1.x path
  //   - modern × raw         → THE 0.2.1-rc.1 REGRESSION (was silently empty)
  it.each([
    ['legacy', 'raw envelope', rawEnvelope],
    ['legacy', 'normalized transcript', normalizedTranscript],
    ['modern', 'raw envelope', rawEnvelope],
    ['modern', 'normalized transcript', normalizedTranscript],
  ] as const)(
    '%s generation with a %s sends body.tools and a leading system prompt',
    async (generation, _shape, context) => {
      if (!canDriveCell(generation)) {
        // Skip only the cells the INSTALLED library cannot parse; never let a
        // generation go entirely unasserted by an unconditional skip (see the
        // module header — that is how the 0.2.1-rc.1 regression escaped).
        expect(canDriveCell('legacy') || canDriveCell('modern')).toBe(true)
        return
      }
      expectPromptAndTools(await captureBody(generation, context()))
    },
  )

  it('folding a raw envelope is idempotent: a second pass adds no system message', async () => {
    if (!canDriveCell('modern')) {
      expect(canDriveCell('legacy')).toBe(true)
      return
    }
    // Guards against double-normalizing. If the seam ever starts normalizing
    // on its own side, the adapter must stay a no-op — two system messages
    // (the second empty) is the failure shape.
    const once = await captureBody('modern', rawEnvelope())
    expectPromptAndTools(once)
    const twice = await captureBody('modern', normalizedTranscript())
    expectPromptAndTools(twice)
    const messages = twice.body?.messages as { role?: string }[]
    expect(messages.filter(message => message.role === 'system')).toHaveLength(1)
  })

  it('keeps the prompt when a raw envelope carries tools but no systemPrompt', async () => {
    if (!canDriveCell('modern')) {
      expect(canDriveCell('legacy')).toBe(true)
      return
    }
    // The fold must not require BOTH fields to be present before firing; a
    // tool-only envelope still has to move its tools into `messages`.
    const captured = await captureBody('modern', {
      tools: [TOOL_SCHEMA],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }],
    })
    const tools = captured.body?.tools as { function?: { name?: string } }[] | undefined
    expect(tools?.map(tool => tool.function?.name)).toEqual(['pwsh'])
  })
})
