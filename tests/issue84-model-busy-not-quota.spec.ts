/**
 * Regression suite for issue #84 — 「国际版用deepseek模型会提示额度不足，step模型可以正常
 * 调用」, which the second reporter on that thread narrowed to the actual defect:
 *
 *   模型繁忙 (14003) 在聊天窗口显示为「当前请求的额度已用尽」,
 *   并请求「对于这种模型繁忙，是否可以进行适当次数的重试」.
 *
 * The chain that produced it, and which this file pins end to end:
 *
 * 1. src/shim.ts wrote `code: 'quota_exceeded'` for `model_busy` (issues #56/#63
 *    chose that spelling to keep a 429 out of the host's in-place retry set).
 * 2. The host classifies a failure by regexing the ENGLISH TEXT of the error —
 *    `classifyPiAiError(message)` in `@deepseek-ai/dsh-llm-pi-ai` — and
 *    `isQuotaExceededError` matches `(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|…)`
 *    against `type + " " + code + " " + message`. `quota_exceeded` matches.
 * 3. That yields host code `QUOTA`, and `@deepseek-ai/dsh-client-ui-chat`'s
 *    `failureMessage()` hard-codes its copy for `QUOTA`/`ACCOUNT_QUOTA` —
 *    「当前请求的额度已用尽」 — DISCARDING the plugin's message.
 *
 * So a loaded model was rendered as an exhausted balance. The fix is one map
 * entry: `model_busy` is no longer translated. Untranslated the same wire body
 * classifies as `RATE_LIMIT`, which is (a) outside the substitution list, so the
 * plugin's honest sentence reaches the user, and (b) inside the host's default
 * retry set, so `dsh-llm-retry` retries a transient 14003 with bounded backoff —
 * the retry the reporter asked for.
 *
 * WHY THIS TEST IS SHAPED THIS WAY: the decisive assertion is not "the map has no
 * model_busy key" (that is an implementation detail) but "what the HOST actually
 * sees". So it drives the REAL pi-ai client — the same `stream()` the host uses —
 * against the REAL shim over a real socket, and runs the REAL host predicate
 * (`isQuotaExceededError`, imported from `@deepseek-ai/dsh-llm`) over the exact
 * text pi-ai produces. Reimplementing the classifier would only prove that two
 * copies of a regex agree today; the quota predicate is the one that decides the
 * wording, and it is the host's own.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { isQuotaExceededError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
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
  domain: 'www.codebuddy.ai',
  uid: 'uid',
  source: 'desktop',
  filePath: '/tmp/auth-global.info',
}

const store = { resolve: async () => CREDENTIAL } as unknown as import('../src/auth.ts').WorkBuddyCredentialStore

/** The upstream's real 14003 body, copied from a live response. */
const MODEL_BUSY_BODY = JSON.stringify({
  code: 14003,
  msg: 'too many requests',
  requestId: '00dc90c7-f7b6-40ad-8960-a00c2d92b567',
  retry_policy: { retry: true },
  displayMsg: {
    en: 'Too many requests. Please retry later.',
    zh: '请求过于频繁，请稍后重试。',
    zh_hant: '請求過於頻繁，請稍後重試。',
  },
  displayTips: {
    en: 'Wait about a minute before retrying, or switch to a less busy model.',
    zh: '建议等待约 1 分钟后重试，或切换到负载较低的模型。',
    zh_hant: '建議等待約 1 分鐘後重試，或切換至負載較低的模型。',
  },
})

/** The upstream's real 6004 body: an ACCOUNT volume limit whose reset is hours away. */
const SOFT_RATE_BODY = JSON.stringify({
  code: 6004,
  msg: '您的使用量已超出频率限制，将在 2026-10-02 05:23:27 UTC+8 重置，您也可以切换其他模型继续使用。',
})

function mount(result: WorkBuddyChatResult): WorkBuddyShim {
  return createWorkBuddyShim({
    store,
    client: { chatStream: async () => result } as unknown as import('../src/upstream.ts').WorkBuddyUpstreamClient,
    catalog: new WorkBuddyCatalog('global'),
  })
}

/**
 * Send one chat turn through the REAL pi-ai client, exactly as the host does,
 * and return the text the host's classifier will read.
 *
 * `maxRetries: 0` disables the SDK's own hidden retries (the host sets the same,
 * then composes `dsh-llm-retry` on top), so one call here means one wire attempt.
 */
async function errorTextFromHostClient(shim: WorkBuddyShim): Promise<string> {
  const model = {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash · x0.00',
    api: 'openai-completions' as const,
    provider: 'workbuddy-global',
    baseUrl: `${shim.baseUrl()}/v1`,
    input: ['text' as const],
    cost: { input: 0, output: 0 },
    contextWindow: 300_000,
    maxTokens: 8_000,
    reasoning: true,
    compat: {},
  }
  // The context is cast for the same reason the model is: this file runs against
  // BOTH pi-ai generations (0.85 in this checkout, 1.x in CI), and their
  // context types disagree about the message shape while both accept this one
  // at run time. Asserting through one generation's type would silently stop
  // covering the other — and the wire body this test is about is identical.
  const context = {
    messages: [{
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hi' }],
      timestamp: Date.now(),
    }],
  }
  const events = stream(
    model as unknown as Parameters<typeof stream>[0],
    context as unknown as Parameters<typeof stream>[1],
    { apiKey: shim.token(), maxRetries: 0 },
  )
  for await (const event of events) void event
  const message = await events.result()
  expect(message.stopReason).toBe('error')
  return message.errorMessage ?? ''
}

describe('issue #84 — a busy model must not be reported as an exhausted balance', () => {
  it('produces host text that is NOT classified as quota, so the plugin wording survives', async () => {
    shim = mount({ ok: false, status: 429, kind: 'model_busy', message: MODEL_BUSY_BODY })
    await shim.ready

    const text = await errorTextFromHostClient(shim)

    // What pi-ai hands the host: "<status>: <body json>". The 429 is what makes
    // the host read RATE_LIMIT, but only if no earlier rule claims the text —
    // the quota predicate runs BEFORE the 429 rule, which is the whole bug.
    expect(text).toMatch(/\b429\b/)
    expect(text).toContain('model_busy')

    // The decisive claim, checked with the host's own predicate: a busy model is
    // NOT a quota failure, so `failureMessage()` will not substitute its fixed
    // 「当前请求的额度已用尽」 and the plugin's sentence is displayed as written.
    expect(isQuotaExceededError(text)).toBe(false)

    // And the plugin's sentence is in there to be displayed.
    expect(text).toContain('这不是账号被限流')
    expect(text).toContain('与积分、额度无关')
  })

  it('keeps RATE_LIMIT retryable on the policy this adapter actually publishes', async () => {
    // The host retries in place only failures whose code is in the provider's
    // retry policy — the one THIS plugin hands it, not some other default. So
    // read it from the adapter's own config (the same `profiles()` seam the
    // host reads through `providerRetryPolicy`) rather than from
    // `resolveRetryPolicy(undefined)`, which would pass even if the adapter
    // stopped publishing a policy at all.
    const { adapter } = createWorkBuddyAdapter({
      shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
      store: {} as never,
      catalog: new WorkBuddyCatalog('global'),
    })
    const profiles = (adapter as unknown as {
      config: { profiles: () => Map<string, { retryPolicy: ResolvedRetryPolicy }> }
    }).config.profiles()
    expect(profiles.size).toBeGreaterThan(0)

    for (const [key, profile] of profiles) {
      const policy = profile.retryPolicy
      // A bounded policy, never `always`: the reporter asked for 「适当次数」,
      // and an unbounded loop on a busy model would never return an answer.
      if (policy.mode !== 'normal') throw new Error(`${key}: unexpected retry mode ${policy.mode}`)
      // The decisive one: the class a busy model now falls into must be in the
      // set, otherwise the fix only improves the sentence and still fails the
      // turn on a single transient 14003.
      expect(policy.retryableCodes, key).toContain('RATE_LIMIT')
      expect(policy.maxRetries, key).toBeGreaterThan(0)
      expect(policy.maxRetries, key).toBeLessThanOrEqual(10)
      // And quota stays out of it: a spent balance must not be retried, which
      // is why `soft_rate` keeps its translation (see the test below).
      expect(policy.retryableCodes, key).not.toContain('QUOTA')
    }
    // The host's own default is what the adapter publishes today; assert the
    // equality rather than assuming it, so a future adapter that narrows the
    // set is caught here.
    expect(profiles.values().next().value!.retryPolicy).toEqual(
      resolveRetryPolicy(undefined, 'dsh-connect-workbuddy retryPolicy'),
    )
  })

  it('still reports a spent account quota as quota', async () => {
    // The contrast that keeps the fix from over-reaching: 14018 really is
    // "credits exhausted" (the upstream says so in those words), the host SHOULD
    // classify it as quota and SHOULD show its own terminal wording.
    shim = mount({
      ok: false,
      status: 429,
      kind: 'hard_credit',
      message: JSON.stringify({
        error: {
          data: {
            code: 14018,
            msg: 'Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage',
          },
        },
      }),
    })
    await shim.ready

    const text = await errorTextFromHostClient(shim)
    expect(isQuotaExceededError(text)).toBe(true)
  })

  it('keeps the account volume limit out of the retry set', async () => {
    // `soft_rate` keeps the `quota_exceeded` translation deliberately: its 6004
    // reset is hours away, so the retry budget cannot produce an answer and must
    // not be spent. This is the half of the old behaviour that was RIGHT, pinned
    // so a future cleanup cannot sweep both entries away together.
    shim = mount({ ok: false, status: 429, kind: 'soft_rate', message: SOFT_RATE_BODY })
    await shim.ready

    const text = await errorTextFromHostClient(shim)
    expect(isQuotaExceededError(text)).toBe(true)
    // The upstream's own words still reach the reader through the raw row.
    expect(text).toContain('超出频率限制')
  })
})
