/**
 * The supplement this plugin adds to a quota failure (issue #63).
 *
 * 参考：`dsh-connect-trae`（MIT）— 「以插件身份向宿主的通知链注册一个条目」的
 *   席位用法与自建 DOM（不依赖 ui-primitives）的渲染约定，见 docs/DESIGN.md §5.3。
 * 改动：本模块是原创实现，但其中两处决定**与本文件早期版本相反**，且都是被真机
 *   截图推翻的：(1) 曾认领 `shell.quota-notice` 链并在其中重绘宿主句子，后判定该
 *   链的语义是「接管整个界面」而非加装饰，遂改为**一律拒收**；(2) 曾是带按钮的
 *   卡片，后改为只读的行内括号。两处的原因各自写在下文对应位置，删改前请先读。
 *
 * WHY THIS EXISTS. When an upstream failure is classified `QUOTA`, the host
 * renders ONE fixed sentence — 「当前请求的额度已用尽」 — and (measured on the
 * shipped client) it DISCARDS the provider's own message to do so:
 *
 *   function failureMessage(message, code, t) {
 *     if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return t('message.failure.quota')
 *     return code === 'AUTH' ? t('message.failure.auth') : message
 *   }
 *
 * That sentence is right for a genuinely exhausted account (14018), and wrong
 * for `6004` — the upstream's own words are 「您的使用量已超出频率限制，将在
 * <时刻> 重置」, and the reporter's account still held 6,788 credits. The
 * plugin cannot fix that by re-classifying: measured against the shipped
 * classifier, every spelling that stops reading as `QUOTA` falls into
 * `RATE_LIMIT`, which IS in `DEFAULT_RETRYABLE_CODES` — so it would buy an
 * honest sentence with 5 in-place retries and ~15.5s of backoff on a limit that
 * resets hours later. Staying out of the retry set is the behaviour we keep
 * (the maintainer's call on issue #63); the sentence is what we supplement.
 *
 * HOW (SUPERSEDED — see the DECLINE note below). The host ships a CHAIN seat
 * for exactly this: `shell.quota-notice`, a frame-wide surface whose own
 * comment says "a `shell.quota-notice` entry may replace the generic Toast for
 * codes it claims". An earlier build of this plugin claimed `QUOTA` there and
 * re-rendered the sentence plus the supplement.
 *
 * THE DECLINE (the maintainer's call, on a screenshot). Claiming a chain entry
 * does not decorate the host's surface, it TAKES IT OVER: the host's generic
 * warning Toast is then not rendered at all, and what replaced it was an inline
 * `<span>` — no fixed positioning, no centring, no background, no fade-out. It
 * landed at the top-left of `shell.overlay` and stayed. That is the box the
 * maintainer reported as "not being there before", and it was correct: the
 * plugin had painted it. The registration now declines every owner, so the
 * host's own Toast is what shows — a surface whose look this plugin does not
 * get to decide — and the supplement lives in the conversation instead, beside
 * the host's failure row, which is where the user is actually looking when a
 * turn fails.
 *
 * WHY THE HOST'S SENTENCE IS LEFT ALONE: it is the string the shell shows
 * everywhere else for this code, and a plugin that reworded it would contradict
 * the shell's own vocabulary. The supplement is additive, and it is written to
 * be TRUE FOR BOTH CASES the code covers — a model's own daily quota (not
 * credits) and a genuinely empty balance — because the plugin cannot always
 * tell which one it is: the upstream states it in Chinese prose the plugin is
 * not allowed to parse for policy.
 *
 * Rendered as plain DOM with this plugin's own classes: the client half
 * deliberately does not depend on `@deepseek-ai/dsh-client-ui-primitives` (see
 * the note in `src/client/index.tsx` — a stale inject entry there once made the
 * whole card's arrival depend on the churn-heaviest host package), so the
 * notice is built from the same primitives every other component here uses.
 */
import { createElement as h } from 'react'
import type { Translate } from './searched-paths.ts'

/**
 * The host's owner object for a quota notice.
 *
 * Nothing here is read any more: the registration declines every owner, so this
 * component never receives one from the chain. The shape is kept because it
 * documents what the host HANDS a claiming entry — the fields a future surface
 * would get — and because the props type below still references it. `message`
 * is the host's own sentence; `dismiss`/`keepOpen` are its own affordances,
 * which this plugin deliberately never called (taking over the surface and then
 * also demanding a dismissal was the worse version of an already-wrong idea).
 */
export interface WorkBuddyQuotaNoticeMatched {
  code?: string
  /** The host's own sentence for this code. */
  message?: string
}

export interface WorkBuddyQuotaNoticeProps {
  /** The owner object the chain handed to the entry that claimed it. */
  matched: WorkBuddyQuotaNoticeMatched
  t: (key: Parameters<Translate>[0], params?: Record<string, unknown>) => string
}

/**
 * Which notice codes this plugin USED TO claim.
 *
 * `QUOTA` only — it is what the shipped classifier produces for BOTH failures
 * this plugin raises (`6004` account rate limit and `14018` exhausted credits).
 *
 * RETAINED AS HISTORY, NOT AS POLICY. The registration now declines every
 * owner (see `registerQuotaNotice` in `./index.tsx`), so nothing consults this
 * list at runtime. It stays because it records which codes the takeover
 * targeted — the set a future reader would otherwise have to re-derive before
 * they could safely re-claim, or safely confirm they must not. The spec keeps
 * asserting the shape of the set so the decline reads as deliberate.
 */
export const WORKBUDDY_QUOTA_NOTICE_CODES: readonly string[] = ['QUOTA']

/**
 * Whether this plugin used to take over the notice for one owner object.
 *
 * NOT consulted by the live registration any more; see
 * {@link WORKBUDDY_QUOTA_NOTICE_CODES}.
 */
export function claimsQuotaNotice(code: unknown): boolean {
  return typeof code === 'string' && WORKBUDDY_QUOTA_NOTICE_CODES.includes(code)
}

/**
 * The chain selector: which owner (if any) this plugin takes over.
 *
 * ALWAYS `null`, and that is the fix — see the DECLINE note in the file header.
 * Exported so the decline is unit-testable without a host: the spec asserts
 * this returns null for every owner, which is what keeps the host's own Toast
 * on screen. A function rather than an inline lambda in the registration so the
 * rule has one home and one test, instead of being restated at the call site.
 */
export function selectQuotaNoticeClaim(_owner: unknown): null {
  return null
}

/**
 * The supplement this plugin adds to a quota failure.
 *
 * It is what the `shell.quota-notice` chain WOULD render if the registration
 * claimed an owner — which it no longer does. Kept as the rendering seat for
 * the supplement so the copy, the locale keys and their guards survive the
 * decline: the next surface that wants this sentence (a failure row, a
 * transcript notice) mounts this component rather than re-inventing the markup.
 *
 * ONE line, no body, no button, no host sentence of its own — the takeover that
 * used to prepend the host's sentence is exactly what was removed.
 */
export function WorkBuddyQuotaNotice(props: WorkBuddyQuotaNoticeProps) {
  const { t } = props
  return h('span', { className: 'dsm-workbuddy-quota-notice', role: 'status' },
    h('span', { className: 'dsm-workbuddy-quota-notice-body' }, t('quotaNotice.supplement')),
  )
}
