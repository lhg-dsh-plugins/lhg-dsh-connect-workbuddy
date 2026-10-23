/**
 * Issue #90, second half: a model the catalog describes WITHOUT reasoning
 * metadata must still be dispatchable.
 *
 * THE REPORT. A user whose domestic route was refused by the gateway's channel
 * fingerprint (issue #87/#88/#89, fixed in 4.13.0) tried to work around it by
 * switching to the international route — and hit a purely LOCAL failure before
 * a single byte left the machine:
 *
 *     pi-ai provider "workbuddy-global" model "default-model" does not support
 *     reasoning effort "high"                       [UNSUPPORTED_REASONING_EFFORT]
 *
 * WHY. `profileFor` pins one default tier per ROUTE (`reasoning:
 * WORKBUDDY_DEFAULT_EFFORT`, issue #83), and `dsh-llm-pi-ai` resolves every
 * request as `options.reasoningEffort ?? profile.reasoning`. A model with no
 * `reasoning` block in the catalog has no tier at all — pi-ai's
 * `getSupportedThinkingLevels` answers `['off']` for it — so the inherited
 * `high` is one it cannot take, and `resolveReasoningLevel` throws while the
 * request is still being assembled. The live CN catalog has six such models
 * (`default`, `glm-5.0`, `glm-4.7`, `glm-4.6`, `hunyuan-chat`,
 * `hunyuan-image-alpha`), the live global one two (`default-model`,
 * `deep-model`), and EVERY entry of both static fallback lists — so before the
 * first refresh lands, every model in a region is affected. Introduced by
 * v4.11.0; before it the route default was absent and pi-ai clamped.
 *
 * TWO GATES HAD TO OPEN. The host refuses ANY explicitly requested tier on a
 * model whose metadata has no `reasoning` at all — including `off` — before the
 * adapter is even consulted; then the adapter refuses the route default it
 * inherited. The fix therefore does both: advertise the single tier pi-ai will
 * accept for such a model (`off`, which the host translates into "send no
 * reasoning field"), and normalize the dispatch to it.
 *
 * WHAT MUST NOT CHANGE. A tier explicitly asked for on a model that cannot do
 * it is still refused, with an accurate message — that is the host's contract
 * and pre-dates v4.11.0. And a model that DOES carry metadata keeps its route
 * default on the wire, which is the whole of issue #83.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as WorkBuddy from '../src/index.ts'

/** A model the upstream describes without any reasoning block. */
const PLAIN = 'glm-5.0'
/** A model that does declare tiers — the issue #83 control. */
const REASONING = 'deepseek-v4.1-flash'

const CATALOG = [
  { id: PLAIN, name: 'GLM-5.0', contextWindow: 200_000, maxTokens: 32_000 },
  {
    id: REASONING,
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 200_000,
    maxTokens: 32_000,
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
  const root = await mkdtemp(join(tmpdir(), 'wb-effort-'))
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
 * bodies that reach the wire. The shim is real (so the adapter really points at
 * a loopback port); only the gateway call is replaced.
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
    try { await ctx.llm.resolveModelInfo('workbuddy', PLAIN); return true } catch { return false }
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

describe('issue #90: a model with no reasoning metadata still dispatches', () => {
  it('sends a request that names no tier instead of failing locally', async () => {
    const ctx = await mount()
    // The regression: this ended in UNSUPPORTED_REASONING_EFFORT before the
    // request was built, so nothing was ever sent.
    expect(await send(ctx, PLAIN)).toEqual({ ok: true })
    expect(bodies.length, 'no request reached the wire').toBe(1)
    // `off` means "no reasoning field" to the host, and pi-ai never emits one
    // for a descriptor whose `reasoning` flag is false — so the body is exactly
    // what it was before v4.11.0.
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    expect(bodies[0]?.model).toBe(PLAIN)
  })

  it('accepts an explicit off, which the host used to refuse outright', async () => {
    const ctx = await mount()
    // Before the fix the model's metadata carried no `reasoning` at all, and the
    // host rejects every explicit tier on such a model — `off` included.
    expect(await send(ctx, PLAIN, 'off')).toEqual({ ok: true })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('still refuses a tier the model cannot do, with an accurate message', async () => {
    const ctx = await mount()
    // Not the bug: an explicit choice the model cannot honour is the host's
    // contract, and silently ignoring it would hide a real misconfiguration.
    const outcome = await send(ctx, PLAIN, 'high')
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('UNSUPPORTED_REASONING_EFFORT')
    expect(outcome.message).toContain('does not support reasoning effort "high"')
    expect(bodies.length, 'a refused request must not reach the wire').toBe(0)
  })

  it('keeps the route default on the wire for a model that does declare tiers', async () => {
    const ctx = await mount()
    // Issue #83: a compaction-style request names no tier, and the route default
    // is what must land — never pi-ai's `off` substitution.
    expect(await send(ctx, REASONING)).toEqual({ ok: true })
    expect(bodies[0]?.reasoning_effort, 'the reasoning model lost its tier').toBe('high')
  })

  it('advertises exactly the tier such a model can dispatch at', async () => {
    const ctx = await mount()
    const info = await ctx.llm.resolveModelInfo('workbuddy', PLAIN)
    // No `defaultEffort` on purpose: the host materializes one into every
    // request that names no tier, which would then be compared against the
    // caller's own config and fail the prepared-call check.
    expect(info.reasoning).toEqual({ efforts: [{ id: 'off', name: 'Off' }] })
    const capable = await ctx.llm.resolveModelInfo('workbuddy', REASONING)
    expect(capable.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'high', 'max'])
    expect(capable.reasoning?.defaultEffort).toBe('high')
  })

  it('stops normalizing as soon as the catalog supplies metadata', async () => {
    const ctx = await mount()
    expect(await send(ctx, PLAIN)).toEqual({ ok: true })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')

    // A refresh that teaches the gateway's answer about this model must take
    // effect without an adapter rebuild: the capability check reads the live
    // catalog on every request.
    const regions = liveConfig.regions as { cn: { lastCatalog: unknown[] } }
    regions.cn.lastCatalog = [{
      id: PLAIN, name: 'GLM-5.0', contextWindow: 200_000, maxTokens: 32_000,
      reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: true },
    }]
    ;(context as unknown as { emit(name: string): void })?.emit('loader/volatile-update')
    await expect.poll(async () => {
      try {
        const info = await ctx.llm.resolveModelInfo('workbuddy', PLAIN)
        return info.reasoning?.efforts.some(effort => effort.id === 'high') === true
      } catch { return false }
    }).toBe(true)

    expect(await send(ctx, PLAIN)).toEqual({ ok: true })
    expect(bodies[1]?.reasoning_effort, 'metadata arrived but the tier did not').toBe('high')
  })
})
