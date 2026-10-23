/**
 * A model that declares reasoning tiers WITHOUT the route default must still
 * be dispatchable by a request that names no tier.
 *
 * THE DEFECT. `profileFor` pins one default tier per ROUTE
 * (`reasoning: WORKBUDDY_DEFAULT_EFFORT` = 'high', issue #83), and
 * `dsh-llm-pi-ai` resolves every request as
 * `options.reasoningEffort ?? profile.reasoning`. The upstream is free to
 * declare any tier list it likes — `parseReasoning` passes
 * `supportedEfforts: ['low', 'max']` straight through — so such a model is
 * effort-capable, yet the inherited `high` is not a tier it has, and
 * `resolveReasoningLevel` throws UNSUPPORTED_REASONING_EFFORT before the
 * request is even built: no wire call, no upstream error, nothing to retry.
 * Issue #90 fixed the sibling case (a model with NO reasoning metadata at
 * all); its normalization deliberately left effort-capable models alone, so
 * this half stayed open.
 *
 * THE FIX. At the same dispatch seam, a tier-less request to such a model is
 * pinned to a tier the model does declare: its own `defaultEffort` when that
 * is among the declared tiers, otherwise the nearest declared tier to the
 * route default in pi-ai's clamp order (upward first, then down). The
 * fallback is read from the live catalog on every request, like issue #90's
 * capability check, so a refresh that teaches the model the route default
 * stops the pinning at once (that mid-session property is exercised by the
 * issue #90 suite against the same seam).
 *
 * WHAT MUST NOT CHANGE. A tier explicitly asked for is never rewritten for an
 * effort-capable model: a supported one reaches the wire untouched, and an
 * unsupported one is still refused by the host with an accurate message —
 * that refusal is the pre-v4.11.0 contract, not this bug. And a model whose
 * tiers DO include the route default keeps it on the wire (issue #83).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as WorkBuddy from '../src/index.ts'

/** Declares tiers, but not the route default; its own default is usable. */
const PARTIAL = 'partial-model'
/** Declares tiers without the route default AND without a usable own default. */
const CLAMP = 'clamp-model'
/** The issue #83 control: declares the route default itself. */
const FULL = 'full-model'

const CATALOG = [
  {
    id: PARTIAL, name: 'Partial', contextWindow: 200_000, maxTokens: 32_000,
    reasoning: { supportedEfforts: ['low', 'max'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: CLAMP, name: 'Clamp', contextWindow: 200_000, maxTokens: 32_000,
    reasoning: { supportedEfforts: ['medium', 'max'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: FULL, name: 'Full', contextWindow: 200_000, maxTokens: 32_000,
    reasoning: { supportedEfforts: ['low', 'high', 'max'], canDisableThinking: true },
  },
]

class MemorySettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure() { return () => {} }
  describe() {
    return [{ ns: WorkBuddy.WORKBUDDY_SETTINGS_NS, autoGenerate: true, revision: 0, applies: 'live', value: liveConfig }]
  }
  async update(_ns: string, patch: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) liveConfig[key] = structuredClone(value)
  }
}

let liveConfig: Record<string, unknown> = {}
let context: Context | undefined
let bodies: Record<string, unknown>[] = []
let realFetch: typeof globalThis.fetch

afterEach(async () => {
  globalThis.fetch = realFetch
  await context?.fiber.dispose()
  context = undefined
  liveConfig = {}
  bodies = []
})

async function cnAuthFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-partial-'))
  const dir = join(root, 'auth')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'workbuddy-desktop.info')
  await writeFile(file, JSON.stringify({
    account: { uid: 'uid-1', uin: '100000000001', nickname: 'Alpha', enterpriseId: '' },
    auth: {
      accessToken: 'token-alpha', refreshToken: 'refresh-alpha', tokenType: 'Bearer',
      domain: 'www.codebuddy.cn', expiresAt: Date.now() + 86_400_000,
      refreshExpiresAt: Date.now() + 7 * 86_400_000,
    },
  }), 'utf8')
  return file
}

/**
 * Mount the plugin with every upstream answer canned, and record the request
 * bodies that reach the wire. The shim is real (so the adapter really points
 * at a loopback port); only the gateway call is replaced.
 */
async function mount(): Promise<Context> {
  const authFile = await cnAuthFile()
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  liveConfig = { authFile, regions: { cn: { enabled: true, lastCatalog: CATALOG, enabledModelIds: [] } } }
  WorkBuddy.apply(ctx, liveConfig as WorkBuddy.Config)

  realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes('chat/completions')) {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return sseAnswer()
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
  }) as typeof fetch

  await expect.poll(async () => {
    try { await ctx.llm.resolveModelInfo('workbuddy', PARTIAL); return true } catch { return false }
  }).toBe(true)
  return ctx
}

function sseAnswer(): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: '' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.join('')))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

interface Outcome {
  ok: boolean
  code?: string | undefined
  message?: string | undefined
}

/** Drive one request through the host and report how it ended. */
async function send(ctx: Context, model: string, effort?: string): Promise<Outcome> {
  const stream = ctx.llm.stream({
    provider: 'workbuddy',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  } as never) as AsyncIterable<unknown>
  let last: { type?: string, reason?: { kind?: string, failure?: { code?: string, message?: string } } } | undefined
  for await (const chunk of stream) {
    last = chunk as typeof last
  }
  const failure = last?.reason?.kind === 'error' ? last.reason.failure : undefined
  return failure === undefined
    ? { ok: true }
    : { ok: false, code: failure?.code, message: failure?.message }
}

describe('a model whose declared tiers exclude the route default', () => {
  it('sends a request that names no tier instead of failing locally', async () => {
    const ctx = await mount()
    // The regression: this ended in UNSUPPORTED_REASONING_EFFORT for "high" —
    // a tier the caller never named — before the request was built.
    expect(await send(ctx, PARTIAL)).toEqual({ ok: true })
    expect(bodies.length, 'no request reached the wire').toBe(1)
    // The pinned tier is the model's own declared default, not a guess.
    expect(bodies[0]?.reasoning_effort).toBe('low')
    expect(bodies[0]?.model).toBe(PARTIAL)
  })

  it('clamps to the nearest declared tier when the model\'s own default is not declared either', async () => {
    const ctx = await mount()
    expect(await send(ctx, CLAMP)).toEqual({ ok: true })
    // pi-ai's clamp order around 'high': upward first — `max` is declared.
    expect(bodies[0]?.reasoning_effort).toBe('max')
  })

  it('passes an explicitly named supported tier through untouched', async () => {
    const ctx = await mount()
    expect(await send(ctx, PARTIAL, 'max')).toEqual({ ok: true })
    expect(bodies[0]?.reasoning_effort).toBe('max')
  })

  it('still refuses an explicitly named tier the model cannot do', async () => {
    const ctx = await mount()
    // Not the bug: the caller DID name this tier, so the host's accurate
    // refusal is the contract. Only the inherited default may be repaired.
    const outcome = await send(ctx, PARTIAL, 'high')
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('UNSUPPORTED_REASONING_EFFORT')
    expect(outcome.message).toContain('does not support reasoning effort "high"')
    expect(bodies.length, 'a refused request must not reach the wire').toBe(0)
  })

  it('keeps the route default on the wire for a model that does declare it', async () => {
    const ctx = await mount()
    // Issue #83: a compaction-style request names no tier, and the route
    // default is what must land for a model that can take it.
    expect(await send(ctx, FULL)).toEqual({ ok: true })
    expect(bodies[0]?.reasoning_effort).toBe('high')
  })
})
