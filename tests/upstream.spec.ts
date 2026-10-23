import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import {
  WorkBuddyUpstreamClient,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
  classifyUpstreamError,
  declaredTools,
  parseCreditMultiplier,
  parseReasoning,
  parseUpstreamErrorDetail,
  parseUpstreamModel,
  prepareChatBody,
  regionOf,
  globalBase,
  selectCliModels,
} from '../src/upstream.ts'

const POLICY_REJECT_BODY = JSON.stringify({
  code: 11140,
  msg: 'request illegal',
  requestId: '3498bf50-98a9-4746-962e-c14016b8c578',
  displayMsg: {
    en: 'The content did not pass the safety review. Please adjust and retry.',
    zh: '内容未通过安全审核，请调整后重试。',
  },
  actions: ['SUBMIT_FEEDBACK', 'COPY_ERROR', 'EDIT_INPUT'],
})

describe('prepareChatBody', () => {
  it('forces streaming and flattens object tool_choice', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      model: 'glm-5.3',
      stream: false,
      tool_choice: { type: 'function', function: { name: 'read' } },
    }))) as Record<string, unknown>
    expect(prepared['stream']).toBe(true)
    expect(prepared['tool_choice']).toBe('read')
  })

  it('normalizes DSH developer messages to WorkBuddy system messages', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'developer', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ],
    }))) as { messages: { role: string; content: string }[] }
    expect(prepared.messages.map(message => message.role)).toEqual(['system', 'user'])
  })

  it('drops tools when tool_choice is none', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'read' } }],
    }))) as Record<string, unknown>
    expect(prepared['tool_choice']).toBeUndefined()
    expect(prepared['tools']).toBeUndefined()
  })

  it('prepends the fallback system message when the body opens with a user turn', () => {
    // The international gateway refuses a user-first body with business code
    // 11128, which it surfaces as "blocked by security policy"; the domestic one
    // tolerates it. A system message can vanish before this module ever sees the
    // body (pi-ai emits a prompt only `if (context.systemPrompt)`, and demotes a
    // `system` entry left in `messages` to `user`), so the head is checked here.
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'still here' },
      ],
    }))) as { messages: { role: string; content: unknown }[] }
    expect(prepared.messages.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(prepared.messages[0]?.content).toBe(WORKBUDDY_FALLBACK_SYSTEM_PROMPT)
    expect(prepared.messages[1]?.content).toBe('hello')
  })

  it('leaves an already system-first body alone', () => {
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'the real prompt' },
        { role: 'user', content: 'hello' },
      ],
    }))) as { messages: { role: string; content: unknown }[] }
    expect(prepared.messages).toHaveLength(2)
    expect(prepared.messages[0]?.content).toBe('the real prompt')
  })

  it('adds no system message when the body carries no history', () => {
    // Nothing to repair, and inventing a turn for a body with no conversation
    // would change requests this rule is not about.
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({ messages: [] }))) as { messages: unknown[] }
    expect(prepared.messages).toEqual([])
    const noMessages = JSON.parse(prepareChatBody(JSON.stringify({ model: 'glm-5.3' }))) as Record<string, unknown>
    expect(noMessages['messages']).toBeUndefined()
  })

  it('passes non-JSON bodies through untouched', () => {
    expect(prepareChatBody('not json')).toBe('not json')
  })

  it('neutralizes a system prompt that opens with a fingerprinted agent head', () => {
    // Measured on the real gateways (2026-10-21): a `system` message beginning
    // with "You are an AI agent powered by DeepSeek Harness" is refused by the
    // domestic gateway with business code 11128 ("unapproved channel"), and the
    // byte-identical body with one neutral line prepended returns 200. Every CN
    // step of a DSH session failed at step 1 until this prepend existed.
    const prompt = 'You are an AI agent powered by DeepSeek Harness.\n\nSecond line.'
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'hello' },
      ],
    }))) as { messages: { role: string; content: unknown }[] }
    expect(prepared.messages).toHaveLength(2)
    expect(prepared.messages[0]?.content).toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${prompt}`)
    expect(prepared.messages[1]?.content).toBe('hello')
  })

  it('matches the fingerprint case-insensitively and after leading whitespace', () => {
    // The gate compares case-insensitively today, and a leading space happens to
    // defeat it; both spellings of the same head must be treated alike so a
    // gateway-side trim or case fold does not silently reopen the failure.
    const prompt = '  you are an AI agent powered by deepseek harness'
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: prompt }],
    }))) as { messages: { content: string }[] }
    expect(prepared.messages[0]?.content).toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\n${prompt}`)
  })

  it('leaves the fingerprint alone when it is not at the start of the prompt', () => {
    // The gate reads the opening only: the same sentence inside the prompt body
    // passes upstream, so a prompt that merely mentions a third-party agent must
    // stay byte-for-byte intact.
    const prompt = 'Rules: be nice.\n\nYou are an AI agent powered by DeepSeek Harness.'
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [{ role: 'system', content: prompt }],
    }))) as { messages: { content: string }[] }
    expect(prepared.messages[0]?.content).toBe(prompt)
  })

  it('neutralizes every system message, not just the head', () => {
    // DSH can send a second system message (a tool-catalog update arrives as
    // `developer` and is rewritten above), and the gate scans each message: a
    // fingerprint below the head fails the request even when the head is benign.
    const prepared = JSON.parse(prepareChatBody(JSON.stringify({
      messages: [
        { role: 'system', content: 'the real prompt' },
        { role: 'developer', content: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
    }))) as { messages: { content: string }[] }
    expect(prepared.messages[0]?.content).toBe('the real prompt')
    expect(prepared.messages[1]?.content)
      .toBe(`${WORKBUDDY_FALLBACK_SYSTEM_PROMPT}\n\nYou are Claude Code, Anthropic's official CLI for Claude.`)
  })
})

describe('classifyUpstreamError', () => {
  it('maps credit exhaustion from Chinese markers', () => {
    expect(classifyUpstreamError(400, '积分不足')).toBe('hard_credit')
  })

  it('maps dead sessions ahead of generic client errors', () => {
    expect(classifyUpstreamError(400, 'Offline user session not found')).toBe('session_dead')
  })

  it('maps rate limits and server faults', () => {
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(503, '')).toBe('server')
    expect(classifyUpstreamError(404, '')).toBe('not_found')
  })

  it('maps the 11140 policy rejection ahead of generic client errors', () => {
    expect(classifyUpstreamError(403, POLICY_REJECT_BODY)).toBe('policy_reject')
    expect(classifyUpstreamError(403, '{"code":11140,"msg":"request illegal"}')).toBe('policy_reject')
  })

  it('keeps a benign 403 a generic client error', () => {
    expect(classifyUpstreamError(403, 'forbidden')).toBe('client')
  })
})

describe('parseUpstreamErrorDetail', () => {
  it('lifts code, requestId, and the Chinese display message out of a 11140 body', () => {
    const detail = parseUpstreamErrorDetail(POLICY_REJECT_BODY)
    expect(detail?.upstreamCode).toBe(11140)
    expect(detail?.requestId).toBe('3498bf50-98a9-4746-962e-c14016b8c578')
    expect(detail?.displayMsg).toBe('内容未通过安全审核，请调整后重试。')
  })

  it('falls back to msg when the body carries no display message', () => {
    const detail = parseUpstreamErrorDetail('{"code":11140,"msg":"request illegal"}')
    expect(detail?.displayMsg).toBe('request illegal')
    expect(detail?.requestId).toBeUndefined()
  })

  it('returns undefined rather than guessing on a non-JSON body', () => {
    expect(parseUpstreamErrorDetail('<html>403</html>')).toBeUndefined()
  })
})

describe('regionOf', () => {
  it('routes workbuddy.ai to global and everything else to cn', () => {
    expect(regionOf('www.workbuddy.ai')).toBe('global')
    expect(regionOf('app.workbuddy.ai')).toBe('global')
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('www.workbuddy.cn')).toBe('cn')
    expect(regionOf('')).toBe('cn')
  })

  it('classifies the codebuddy.ai brand domain as global', () => {
    // The CodeBuddy CLI signs the international account in at codebuddy.ai,
    // a second brand domain for the same product (issue #4). Classifying it as
    // cn sent its token to the CN gateway, which answered an openresty HTML 401.
    expect(regionOf('www.codebuddy.ai')).toBe('global')
    expect(regionOf('codebuddy.ai')).toBe('global')
    expect(regionOf('app.codebuddy.ai')).toBe('global')
    // Case and surrounding whitespace are normalized the same way.
    expect(regionOf('  WWW.CodeBuddy.AI  ')).toBe('global')
    // The CN brand domain must NOT be promoted by a loose suffix match.
    expect(regionOf('www.codebuddy.cn')).toBe('cn')
    expect(regionOf('notcodebuddy.ai')).toBe('cn')
  })
})

describe('globalBase', () => {
  it('follows the credential OWN brand domain', () => {
    // A token issued at codebuddy.ai is rejected by the workbuddy.ai gateway,
    // so the base has to track the credential rather than a fixed host.
    expect(globalBase('www.codebuddy.ai')).toBe('https://www.codebuddy.ai')
    expect(globalBase('codebuddy.ai')).toBe('https://www.codebuddy.ai')
    expect(globalBase('www.workbuddy.ai')).toBe('https://www.workbuddy.ai')
    // Unknown global spellings fall back to the desktop app's gateway.
    expect(globalBase('')).toBe('https://www.workbuddy.ai')
    expect(globalBase('some.other.ai')).toBe('https://www.workbuddy.ai')
  })
})

describe('WorkBuddyUpstreamClient.fetchModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function credential(domain: string): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain,
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  /** Run fetchModels against a stubbed upstream; return the URL it called. */
  async function fetchModelsUrl(domain: string): Promise<string> {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 200_000, maxOutputTokens: 48_000 }],
            agents: [{ name: 'cli', models: ['glm-5.3'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential(domain))
    expect(models.map(model => model.id)).toEqual(['glm-5.3'])
    expect(urls).toHaveLength(1)
    const url = urls[0]
    if (url === undefined) throw new Error('fetchModels performed no upstream request')
    return url
  }

  it('auto-routes CN and global accounts by credential domain', async () => {
    // BOTH regions read /v3/config, the document the WorkBuddy app itself
    // consumes, so the card's roster and prices agree with the app's. Both read
    // it as the APP's product identity (its personal-models path returns HTTP
    // 500 on the global gateway, and /v3 under the CLI identity omits
    // chat-usable models there). The user agent is therefore part of the
    // contract, not an incidental header — see the UA assertions below.
    expect(await fetchModelsUrl('www.codebuddy.cn'))
      .toBe('https://copilot.tencent.com/v3/config')
    expect(await fetchModelsUrl('www.workbuddy.cn'))
      .toBe('https://copilot.tencent.com/v3/config')
    expect(await fetchModelsUrl('www.workbuddy.ai'))
      .toBe('https://www.workbuddy.ai/v3/config')
  })

  it('routes a codebuddy.ai credential to its own gateway, not the CN one', async () => {
    // Regression for issue #4: www.codebuddy.ai was classified as cn, so the
    // request went to copilot.tencent.com and came back an openresty HTML 401.
    expect(await fetchModelsUrl('www.codebuddy.ai'))
      .toBe('https://www.codebuddy.ai/v3/config')
    expect(await fetchModelsUrl('codebuddy.ai'))
      .toBe('https://www.codebuddy.ai/v3/config')
  })

  it('sends the app product identity on the global config request', async () => {
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, credits: 'x0.00' }],
            agents: [{ name: 'cli', models: ['deepseek-v4.1-flash'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential('www.workbuddy.ai'))
    // The CLI user agent returns a 35-model roster without this model; only the
    // app channel's document carries the account's real chat list.
    expect(seen['User-Agent']).toBe('WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0')
    expect(seen['X-Product']).toBe('SaaS')
    expect(models.map(model => model.id)).toEqual(['deepseek-v4.1-flash'])
    expect(models[0]?.creditMultiplier).toBe(0)
  })

  it('sends the app product identity on the CN config request', async () => {
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 48_000 }],
            agents: [{ name: 'cli', models: ['glm-5.3'] }],
          },
        }),
      } as unknown as Response
    })
    await new WorkBuddyUpstreamClient().fetchModels(credential('www.codebuddy.cn'))
    // `/v3/config` answers a DIFFERENT product configuration per client
    // channel, and the CLI channel's answer publishes neither
    // `modelPromotions` nor `modelTiers` — which is why the CN card used to
    // show no promotion badge at all while the WorkBuddy app showed one on the
    // same account. The product configuration must therefore be read as the
    // APP does (`WorkBuddy/<app> WorkBuddy/<app> CLI/<cli>`), while CHAT keeps
    // speaking as the CLI agent.
    expect(seen['User-Agent']).toBe('WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0')
  })

  it('attaches the CN promotion feed to the models it names', async () => {
    // The real CN entry, copied from the app channel's `/v3/config` on
    // 2026-10-21: a night discount with a wall-clock window that crosses
    // midnight, in the upstream's own Chinese wording.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [{ id: 'glm-5.2', name: 'GLM-5.2', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, credits: 'x0.79' }],
          agents: [{ name: 'cli', models: ['glm-5.2'] }],
          modelPromotions: [{
            id: 'glm-52-night-discount-202607',
            kind: 'discount',
            enabled: true,
            priority: 100,
            modelIds: ['glm-5.2'],
            badge: { label: '夜间折扣', color: '#009273' },
            discount: { discountedCredits: '0.50x', displayMode: 'strikethrough', factor: 0.5 },
            hover: { textZh: '每晚 23:00—次日 8:00 积分限时立减，错峰用更省' },
            schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '7:50' }] },
          }],
          modelTiers: [{
            id: 'tier-standard-2026q3',
            badge: { label: '订阅优先', color: '#009273' },
            modelIds: ['glm-5.2'],
            priority: 20,
            tier: 'standard',
          }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential('www.codebuddy.cn'))
    // The badge travels with the model, so the card can draw it without a
    // second upstream request.
    expect(models[0]?.promos?.map(promo => promo.id)).toEqual([
      'glm-52-night-discount-202607',
      'tier-standard-2026q3',
    ])
    expect(models[0]?.promos?.[0]?.badge.label).toBe('夜间折扣')
  })

  it('keeps a model the user runs that the upstream roster dropped', async () => {
    // The app channel's `cli` roster dropped `minimax-m2.7` on 2026-10-21 while
    // the SAME document still publishes it at `x0.26` and the chat endpoint
    // still answers for it (measured HTTP 200). The runtime catalog filters the
    // roster by the user's selection, so a refresh that simply followed the
    // upstream roster would silently withdraw a model the user is running —
    // issue #32's failure mode. The user's selection therefore rides along with
    // the roster read.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [
            { id: 'hy3', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000, credits: 'x0.00' },
            { id: 'minimax-m2.7', name: 'MiniMax-M2.7', maxInputTokens: 200_000, maxOutputTokens: 48_000, credits: 'x0.26' },
          ],
          agents: [{ name: 'cli', models: ['hy3'] }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'), undefined, ['minimax-m2.7'])
    expect(models.map(model => model.id)).toEqual(['hy3', 'minimax-m2.7'])
    expect(models[1]?.creditMultiplier).toBe(0.26)
  })

  it('keeps the running model even when the roster now lists only a router', async () => {
    // The roster can shrink to just `auto`. Dropping the router must not empty
    // the catalog out from under a user who is running a real model, so the
    // kept id is what the region is left with.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [
            { id: 'auto', name: 'Auto', maxInputTokens: 256_000, maxOutputTokens: 32_000 },
            { id: 'minimax-m2.7', name: 'MiniMax-M2.7', maxInputTokens: 200_000, maxOutputTokens: 48_000, credits: 'x0.26' },
          ],
          agents: [{ name: 'cli', models: ['auto'] }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'), undefined, ['minimax-m2.7'])
    expect(models.map(model => model.id)).toEqual(['minimax-m2.7'])
  })

  it('does not resurrect a kept model the document no longer publishes', async () => {
    // The keep rule is bounded by the document: an id the upstream dropped
    // entirely is not re-added from thin air.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [{ id: 'hy3', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000 }],
          agents: [{ name: 'cli', models: ['hy3'] }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'), undefined, ['minimax-m2.7'])
    expect(models.map(model => model.id)).toEqual(['hy3'])
  })

  it('never offers the upstream router as a model', async () => {
    // `auto` resolves to a different model per request, so a row for it would
    // advertise terms (price, window, behaviour) that the plugin cannot state —
    // and it duplicates a real row already in the same roster (CN `auto` →
    // `hy4-preview`). It is dropped where the roster is built, so the card, the
    // picker, the probe and the discovery route all agree.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        msg: 'OK',
        data: {
          models: [
            { id: 'auto', name: 'Auto', maxInputTokens: 256_000, maxOutputTokens: 32_000, isDefault: true },
            { id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 960_000, maxOutputTokens: 64_000, credits: 'x0.29' },
          ],
          agents: [{ name: 'cli', models: ['auto', 'hy4-preview'] }],
        },
      }),
    }) as unknown as Response)
    const models = await new WorkBuddyUpstreamClient().fetchModels(credential('www.codebuddy.cn'))
    expect(models.map(model => model.id)).toEqual(['hy4-preview'])
    expect(models.some(model => model.id === 'auto')).toBe(false)
  })

  it('falls back to the legacy CN catalog when the app config fails', async () => {
    // The CN branch prefers /v3/config so the card matches the app's roster and
    // prices. A gateway that cannot serve it must degrade to the previous
    // document rather than leaving the region with no models.
    const urls: string[] = []
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      if (url.endsWith('/v3/config')) throw new Error('socket hang up')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000 }],
            agents: [{ name: 'cli', models: ['hy4-preview'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchModels(credential('www.codebuddy.cn'))
    expect(urls).toEqual([
      'https://copilot.tencent.com/v3/config',
      'https://copilot.tencent.com/v2/enterprises/personal/models',
    ])
    expect(models.map(model => model.id)).toEqual(['hy4-preview'])
    // Silently serving a different roster than the app is the bug being fixed,
    // so the degradation has to be reportable.
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain('/v3/config')
    expect(fallbacks[0]).toContain('socket hang up')
  })

  it('degrades the MEDIA catalog the same way, instead of failing the tool', async () => {
    // `fetchMediaModels` reads the same `/v3/config` document for its
    // `text-to-image` tags. Chat already degrades to the legacy `/v2` document
    // when `/v3` stops answering; the image tool must do the same, or a /v3
    // outage turns into "生图工具坏了" while chat keeps working.
    const urls: string[] = []
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      if (url.endsWith('/v3/config')) throw new Error('socket hang up')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 1_000_000, maxOutputTokens: 64_000 }],
            agents: [{ name: 'cli', models: ['hy4-preview'] }],
          },
        }),
      } as unknown as Response
    })
    const media = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchMediaModels(credential('www.codebuddy.cn'))
    expect(urls).toEqual([
      'https://copilot.tencent.com/v3/config',
      'https://copilot.tencent.com/v2/enterprises/personal/models',
    ])
    // The legacy document carries no media tags in practice: the honest answer
    // is "no image model here", not an exception.
    expect(media).toEqual([])
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain('/v3/config')
  })

  it('does not degrade the media catalog on the international region', async () => {
    // The global branch has no legacy fallback at all — it must not be handed a
    // CN-shaped document.
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up')
    })
    await expect(new WorkBuddyUpstreamClient().fetchMediaModels(credential('www.workbuddy.ai')))
      .rejects.toThrow(/socket hang up/)
  })

  it('does not touch the legacy CN catalog when the app config answers', async () => {
    const urls: string[] = []
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: {
            models: [{ id: 'hy4-preview', name: 'Hy4 preview', maxInputTokens: 960_000, maxOutputTokens: 64_000, credits: 'x0.29' }],
            agents: [{ name: 'cli', models: ['hy4-preview'] }],
          },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchModels(credential('www.codebuddy.cn'))
    expect(urls).toEqual(['https://copilot.tencent.com/v3/config'])
    // The app's own record: the paid `hy4-preview` at x0.29 (the free Hy4 tier
    // is no longer a separate record — it is the 夜间免费 promotion badge).
    expect(models.map(model => [model.id, model.creditMultiplier])).toEqual([['hy4-preview', 0.29]])
    expect(fallbacks).toEqual([])
  })

  it('falls back when the app config resolves to an empty roster', async () => {
    // `selectCliModels` throws on an empty roster, so a `/v3` that answers 200
    // with no models must degrade to the legacy document rather than leaving
    // the region with nothing to show.
    const urls: string[] = []
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      const empty = url.endsWith('/v3/config')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'OK',
          data: empty
            ? { models: [], agents: [{ name: 'cli', models: ['glm-5.3'] }] }
            : {
                models: [{ id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, maxOutputTokens: 48_000 }],
                agents: [{ name: 'cli', models: ['glm-5.3'] }],
              },
        }),
      } as unknown as Response
    })
    const models = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchModels(credential('www.codebuddy.cn'))
    expect(urls).toEqual([
      'https://copilot.tencent.com/v3/config',
      'https://copilot.tencent.com/v2/enterprises/personal/models',
    ])
    expect(models.map(model => model.id)).toEqual(['glm-5.3'])
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toContain('empty list')
  })

  it('reports the fallback error even when the legacy catalog also fails', async () => {
    // Both documents are down: the surfaced error must be the legacy one (the
    // request that finally decided the outcome), and the fallback must still be
    // reported so the log shows the two-step attempt.
    const fallbacks: string[] = []
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      text: async () => '<html><body>Bad Gateway</body></html>',
    }) as unknown as Response)
    const error = await new WorkBuddyUpstreamClient(message => fallbacks.push(message))
      .fetchModels(credential('www.codebuddy.cn'))
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('non-JSON')
    expect(fallbacks).toHaveLength(1)
  })

  it('explains a gateway HTML 401 instead of echoing the raw page', async () => {
    // The upstream edge (openresty/APISIX) answers an HTML page when it refuses
    // a revoked token. The user needs to know to re-sign in, not to read markup.
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      text: async () => '<html><head><title>401 Authorization Required</title></head>'
        + '<body><center><h1>401 Authorization Required</h1></center>'
        + '<hr><center>openresty</center></body></html>',
    }) as unknown as Response)
    const error = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'))
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('rejected by the upstream gateway')
    expect(error?.message).toContain('Re-sign in')
    expect(error?.message).not.toContain('<html>')
  })

  it('keeps the generic message for a non-auth non-JSON failure', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 502,
      text: async () => '<html><body>Bad Gateway</body></html>',
    }) as unknown as Response)
    const error = await new WorkBuddyUpstreamClient()
      .fetchModels(credential('www.codebuddy.cn'))
      .then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toContain('non-JSON')
  })
})

describe('parseCreditMultiplier', () => {
  it('parses the observed upstream spellings', () => {
    expect(parseCreditMultiplier('x0.79 credits')).toBe(0.79)
    expect(parseCreditMultiplier('x0.05')).toBe(0.05)
    expect(parseCreditMultiplier('x0.00 credits')).toBe(0)
  })

  it('returns undefined rather than guessing', () => {
    expect(parseCreditMultiplier(undefined)).toBeUndefined()
    expect(parseCreditMultiplier('free')).toBeUndefined()
    expect(parseCreditMultiplier(0.5)).toBeUndefined()
  })
})

describe('parseReasoning', () => {
  it('keeps declared effort levels', () => {
    expect(parseReasoning({ supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' })).toEqual({
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
    })
  })

  it('drops an empty reasoning object instead of reporting a capability', () => {
    expect(parseReasoning({})).toBeUndefined()
    expect(parseReasoning({ unsupported: 1 })).toBeUndefined()
  })

  // The singular `effort` spelling (issue #7): `deepseek-v4.1-flash`,
  // `kimi-k3` and friends declare only a default level. Both gateways accept
  // the whole ladder on these models and think off when no reasoning_effort
  // is sent, so the fold widens supportedEfforts and keeps off available.
  it('folds the singular effort form into the full ladder', () => {
    expect(parseReasoning({ effort: 'high', summary: 'auto' })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(parseReasoning({ effort: 'medium', summary: 'auto' })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      canDisableThinking: true,
    })
  })

  it('passes an unrecognized singular effort through as the lone level', () => {
    expect(parseReasoning({ effort: 'turbo', summary: 'auto' })).toEqual({
      supportedEfforts: ['turbo'],
      defaultEffort: 'turbo',
      canDisableThinking: true,
    })
  })

  it('lets the plural form win when both spellings appear', () => {
    expect(parseReasoning({ effort: 'high', supportedEfforts: ['low', 'high'] })).toEqual({
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
    })
    expect(parseReasoning({ effort: 'high', canDisableThinking: false })).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: false,
    })
  })
})

describe('parseUpstreamModel', () => {
  it('carries the fields the plugin card displays', () => {
    const model = parseUpstreamModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 48_000,
      credits: 'x0.79',
      supportsImages: true,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
      descriptionZh: '能力均衡',
    })
    expect(model).toMatchObject({
      id: 'glm-5.3',
      contextWindow: 1_000_000,
      maxTokens: 48_000,
      creditMultiplier: 0.79,
      descriptionZh: '能力均衡',
      supportsImages: true,
    })
    expect(model?.reasoning?.supportedEfforts).toEqual(['low', 'high'])
  })

  it('registers singular-effort models as reasoning-capable (issue #7)', () => {
    // Live /v3/config shape of `deepseek-v4.1-flash` on the global gateway:
    // only the singular `effort` default is declared, and without this fold
    // the whole reasoning object was dropped (thinking never enabled).
    const model = parseUpstreamModel({
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      reasoning: { effort: 'high', summary: 'auto' },
    })
    expect(model?.reasoning).toEqual({
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
  })

  it('never infers multimodal from the upstream image flags', () => {
    // `multimodal` is the RUNTIME capability, stamped from the saved
    // `imageModelIds`; the parser must never set it, or a stale upstream flag
    // would silently re-enable image input the user had switched off.
    expect(parseUpstreamModel({
      id: 'a',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: true,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'b',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: false,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'c',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      supportsImages: true,
      disabledMultimodal: true,
    })?.multimodal).toBeUndefined()
    expect(parseUpstreamModel({
      id: 'd',
      maxInputTokens: 1,
      maxOutputTokens: 1,
    })?.multimodal).toBeUndefined()
  })

  it('parses the upstream image default into supportsImages', () => {
    // The value only pre-fills the card's image checkboxes on refresh; the
    // effective capability still comes from the saved selection.
    const parsed = (extra: Record<string, unknown>): boolean | undefined => parseUpstreamModel({
      id: 'x',
      maxInputTokens: 1,
      maxOutputTokens: 1,
      ...extra,
    })?.supportsImages
    expect(parsed({ supportsImages: true })).toBe(true)
    expect(parsed({ supportsImages: false })).toBe(false)
    // `disabledMultimodal: true` is a hard veto even alongside
    // `supportsImages: true`. Live data has never shown that conflict (CN
    // 2026-09-29: 0 of 30 entries), so this is a defensive rule: when upstream
    // does contradict itself, err on the side of NOT sending images.
    expect(parsed({ supportsImages: true, disabledMultimodal: true })).toBe(false)
    expect(parsed({ disabledMultimodal: true })).toBe(false)
    // Absent flags stay unknown rather than becoming an implicit `false`.
    expect(parsed({})).toBeUndefined()
  })

  it('rejects disabled models and models without token limits', () => {
    expect(parseUpstreamModel({ id: 'a', disabled: true, maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ id: 'b', maxInputTokens: 0, maxOutputTokens: 1 })).toBeUndefined()
    expect(parseUpstreamModel({ id: '', maxInputTokens: 1, maxOutputTokens: 1 })).toBeUndefined()
  })
})

/**
 * The input to DSML recovery: which tool names THIS request offered.
 *
 * Getting this wrong is the difference between a recovery that can never fire
 * (names unrecognised, so every block is refused) and one that fires on a name
 * the caller never authorised — the production accident the gates exist for.
 * The `tool_choice: "none"` case is the important one: `prepareChatBody` deletes
 * `tools` for it, so gate 3 comes out of the same prepared JSON rather than
 * from a second rule someone has to remember to keep in sync.
 */
describe('declaredTools', () => {
  it('reads names and required parameters from a prepared body', () => {
    const prepared = prepareChatBody(JSON.stringify({
      tools: [
        { type: 'function', function: { name: 'bash', parameters: { type: 'object', required: ['command'] } } },
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      ],
    }))
    const declared = declaredTools(prepared)
    expect(declared?.names).toEqual(new Set(['bash', 'read_file']))
    expect(declared?.requiredParameters.get('bash')).toEqual(['command'])
    // A tool with no `required` list contributes no entry rather than an empty
    // one: an empty list would read as "checked and nothing is required", which
    // is the same answer but hides the difference between the two.
    expect(declared?.requiredParameters.has('read_file')).toBe(false)
    expect(declared?.pinnedToolName).toBeUndefined()
  })

  it('reports nothing when the prepared body declares no tools (gate 3)', () => {
    expect(declaredTools(prepareChatBody(JSON.stringify({ messages: [] })))).toBeUndefined()
    expect(declaredTools(prepareChatBody(JSON.stringify({
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'bash' } }],
    })))).toBeUndefined()
    expect(declaredTools(prepareChatBody(JSON.stringify({ tools: [] })))).toBeUndefined()
  })

  it('reports a pinned tool_choice as a bare name', () => {
    const prepared = prepareChatBody(JSON.stringify({
      tools: [{ type: 'function', function: { name: 'read' } }],
      tool_choice: { type: 'function', function: { name: 'read' } },
    }))
    expect(declaredTools(prepared)?.pinnedToolName).toBe('read')
  })

  it('does not treat auto or required as a pin', () => {
    for (const choice of ['auto', 'required']) {
      const prepared = prepareChatBody(JSON.stringify({
        tools: [{ type: 'function', function: { name: 'read' } }],
        tool_choice: choice,
      }))
      expect(declaredTools(prepared)?.pinnedToolName).toBeUndefined()
    }
  })

  it('returns nothing for an unparsable or malformed body', () => {
    expect(declaredTools('not json')).toBeUndefined()
    expect(declaredTools('[]')).toBeUndefined()
    expect(declaredTools(JSON.stringify({ tools: [{ type: 'function' }, { function: { name: 7 } }, null] })))
      .toBeUndefined()
  })
})

describe('WorkBuddyUpstreamClient.probeChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function credential(): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain: 'www.codebuddy.cn',
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  it('gives up on an endpoint that never answers, instead of hanging the batch', async () => {
    // The pool's batch is SERIAL, so one endpoint that accepts the connection and
    // never replies blocks every account behind it — that is the "dead button"
    // making the response streamed alone would NOT have fixed.
    //
    // Ten seconds: comfortably above a working gateway's first byte, far below a
    // user's patience.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new Error('no response within 10000ms'))
      })
    })))
    const answer = new WorkBuddyUpstreamClient().probeChat(credential(), '{}')
    await vi.advanceTimersByTimeAsync(9_999)
    await vi.advanceTimersByTimeAsync(1)
    // status 0 is the transport-failure convention the shim already maps to
    // `server`, so this reads as "the upstream is unreachable" — not as a
    // statement about the account.
    await expect(answer).resolves.toMatchObject({ ok: false, status: 0 })
  })

  it('stops counting time once a response arrives, so a slow body is not cut off', async () => {
    // The Discriminating Case: a naive `AbortSignal.timeout` keeps running while
    // the body drains, which would put a healthy but slow model on the same clock
    // as a dead endpoint. The ceiling answers "did the upstream answer AT ALL",
    // so it is cleared the moment headers land.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200 })))
    const client = new WorkBuddyUpstreamClient()
    const answer = await client.probeChat(credential(), '{}')
    expect(answer.ok).toBe(true)
    // Well past the ceiling — if the timer were still armed, this read would
    // throw and a working account would be reported unreachable.
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(answer.response?.text()).resolves.toContain('[DONE]')
  })
})

describe('the conversation-identity triple (issue #66)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function credential(domain = 'www.codebuddy.cn'): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain,
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  /** Capture the headers one chat request actually went out with. */
  async function headersOf(domain: string): Promise<Record<string, string>> {
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return new Response('data: [DONE]\n\n', { status: 200 })
    })
    await new WorkBuddyUpstreamClient().chatStream(credential(domain), '{}')
    return seen
  }

  const TRIPLE = ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID']

  it('sends all three on the international gateway, which refuses the request without them', async () => {
    // The reported defect: workbuddy-global answers EVERY step with 400 /
    // business code 11128 ("conversation id missing"), on every model. The
    // gateway's own display tips blame the client identity, which is why this
    // reads as something other than a missing header.
    const seen = await headersOf('www.workbuddy.ai')
    for (const name of TRIPLE) expect(seen[name]).toBeTruthy()
  })

  it('sends them on the CN gateway too, so only one side can never be the whole story', async () => {
    // The CN gateway tolerates their absence, so sending them there is harmless.
    // Deliberate: a header that is only ever sent on one side is how the 3.1.0
    // system-head rule became an international-only defect that no CN-side test
    // could see. This asserts the one-code-path decision, not a CN requirement.
    const seen = await headersOf('www.codebuddy.cn')
    for (const name of TRIPLE) expect(seen[name]).toBeTruthy()
  })

  it('gives the three headers three DIFFERENT values', async () => {
    // Bisecting the official bundle's header set showed X-Conversation-ID alone is
    // still refused: all three must be present. Three copies of one id would
    // satisfy a naive presence check while forging a conversation identity that
    // does not exist — one session announced three times under a single id.
    const seen = await headersOf('www.workbuddy.ai')
    expect(new Set(TRIPLE.map(name => seen[name])).size).toBe(3)
  })

  it('sends a well-formed UUID in each, because a malformed id is refused upstream', async () => {
    const seen = await headersOf('www.workbuddy.ai')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const name of TRIPLE) expect(seen[name]).toMatch(uuid)
  })

  it('generates fresh values per request rather than reusing one identity', async () => {
    // The official client calls randomUUID() per request. Reusing a value across
    // requests is what would make the upstream correlate two different steps as
    // one message — the assertion below fails if the triple is hoisted to a
    // module-level constant, which is the natural "optimisation" here.
    const first = await headersOf('www.workbuddy.ai')
    const second = await headersOf('www.workbuddy.ai')
    for (const name of TRIPLE) expect(second[name]).not.toBe(first[name])
  })

  it('carries them on the probe path, which shares the chat endpoint', async () => {
    // The probe is a real chat request, so the same gate applies — and it is how
    // the reporter's own account test surfaced 11128 (one account "ok", another
    // refused, in the same batch). A fix applied only to chatStream would leave
    // the pool testing accounts against an endpoint whose rules are not met.
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return new Response('data: [DONE]\n\n', { status: 200 })
    })
    await new WorkBuddyUpstreamClient().probeChat(credential('www.workbuddy.ai'), '{}')
    for (const name of TRIPLE) expect(seen[name]).toBeTruthy()
  })

  it('does not carry them on the billing endpoint, which is not chat', async () => {
    // The triple is a CHAT-endpoint requirement. The reporter's matrix was taken
    // on the chat endpoint only, so sending it on the billing calls the official
    // client also makes without it would be inventing protocol nobody tested.
    //
    // Asserted BEHAVIOURALLY: an earlier draft of this test grepped the source
    // text, and a mutation that added the triple to `billingHeaders` slipped past
    // it because the text slice it compared had simply failed to match. Driving
    // the real method is what makes the guard measure the request instead.
    const seen: Record<string, string> = {}
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      Object.assign(seen, init.headers)
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
    })
    await new WorkBuddyUpstreamClient().fetchCredits(credential('www.workbuddy.ai'))
    for (const name of TRIPLE) expect(seen[name]).toBeUndefined()
  })
})

describe('WorkBuddyUpstreamClient.chatStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function credential(): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain: 'www.codebuddy.cn',
      uid: 'u',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  it('does NOT impose a first-byte ceiling of its own', async () => {
    // The Discriminating Case, and it is a NEGATIVE assertion: a chat answer has
    // to prefill the whole prompt before its first byte, and that varies by an
    // order of magnitude with context size. A bound tight enough to matter would
    // eventually cut a real answer short — and cutting a real answer is worse than
    // waiting for a slow one.
    //
    // Liveness is the probe's job (see `PROBE_TIMEOUT_MS`), not the real request's.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      // Rejects only if a timer is armed; a bare caller signal still aborts.
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })))
    const answer = new WorkBuddyUpstreamClient().chatStream(credential(), '{}')
    // Far past any plausible ceiling — if this path grew one, this is where it
    // would fire and turn a slow-but-working request into "unreachable".
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(answer).toBeInstanceOf(Promise)
    // Still pending: nothing on this path is allowed to time out on its own.
    await expect(Promise.race([answer, Promise.resolve('pending')])).resolves.toBe('pending')
  })

  it('still honours the caller\'s cancellation', async () => {
    // What DOES bound a real request: the caller hanging up. The shim's controller
    // aborts on client disconnect, and that must win immediately — aborting is
    // what turns "the user closed the panel" into a stop rather than a completed
    // upstream call.
    vi.useFakeTimers()
    const caller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })))
    const answer = new WorkBuddyUpstreamClient().chatStream(credential(), '{}', caller.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    caller.abort()
    await expect(answer).resolves.toMatchObject({ ok: false, status: 0, kind: 'server' })
  })
})

describe('selectCliModels drops the regional routers, and keeps doing it', () => {
  /** A minimal entry `parseUpstreamModel` accepts (both token counts positive). */
  const entry = (id: string, name: string) => ({ id, name, maxInputTokens: 176_000, maxOutputTokens: 24_000 })

  it('drops CN `auto` from the roster', () => {
    const roster = selectCliModels(
      [entry('auto', 'Auto'), entry('hy3', 'Hy3')],
      [{ name: 'cli', models: ['auto', 'hy3'] }],
    )
    expect(roster.map(model => model.id)).toEqual(['hy3'])
  })

  it('drops the international `default-model`, the same router under another id', () => {
    const roster = selectCliModels(
      [entry('default-model', 'Auto'), entry('fast-model', 'Fast')],
      [{ name: 'cli', models: ['default-model', 'fast-model'] }],
    )
    expect(roster.map(model => model.id)).toEqual(['fast-model'])
  })

  it('does not resurrect a router the SAVED SELECTION still names', () => {
    // The case that made the `keepIds` filter necessary rather than decorative:
    // a profile saved before routers were dropped still carries `auto` in
    // `enabledModelIds`, and `keepIds` exists so a refresh never withdraws a
    // model the user is running. Without the filter, that stored id comes back
    // through the kept branch — and does so on EVERY refresh, so the row would
    // be impossible to get rid of by unchecking it.
    const roster = selectCliModels(
      [entry('auto', 'Auto'), entry('default-model', 'Auto'), entry('hy3', 'Hy3')],
      [{ name: 'cli', models: ['hy3'] }],
      ['auto', 'default-model'],
    )
    expect(roster.map(model => model.id)).toEqual(['hy3'])
  })

  it('still keeps a real model the upstream roster dropped', () => {
    // The other half of the same branch: filtering routers must not break the
    // issue #32 guarantee that a user's running model survives a refresh.
    const roster = selectCliModels(
      [entry('auto', 'Auto'), entry('hy3', 'Hy3'), entry('retired-model', 'Retired')],
      [{ name: 'cli', models: ['hy3'] }],
      ['retired-model'],
    )
    expect(roster.map(model => model.id)).toEqual(['hy3', 'retired-model'])
  })
})
