/**
 * "Is there anything left to claim on this account?" — answered from state the
 * gateway already published, never guessed.
 *
 * 参考：`src/upstream.ts` 的 `fetchBenefits`（两个 `/billing/meter/*-status`
 *   只读端点），以及 `src/index.ts` 的 `checkedInToday`（每账号一次只读、
 *   TTL 缓存、池关闭就不发请求的既有管线）。
 * 改动：把「显示什么」抽成一个纯函数 `benefitOf`，让卡片只负责画，不负责判断。
 *
 * 三条规则，全部由实测确定（见 `WorkBuddyBenefit` 的注释）：
 *
 *   1. **可领 = active 且未 claimed。** 缺一不可。已领取的账号 `active` 仍是
 *      `true`，所以只看 `active` 会把「已经领过」的账号一直标成待领取。
 *   2. **已领取不再显示。** 这是用户明确要求的：领过的就不出现，按钮自然消失。
 *      注意 `claimed` 在活动结束后**依然为真**，因此这条判定不依赖窗口。
 *   3. **活动结束自动消失。** 活动过期后 `active` 翻成 `false`，于是条件 1 不再
 *      成立，行自动消失 —— 不需要前端自己拿 `end_time` 去算时间。
 *
 * 本模块是纯的：不读时钟以外的任何外部状态，不发请求，不写盘。时钟可注入，
 * 因此「临期」「已过期」这类判断可被单测直接钉死。
 *
 * @module dsh-connect-workbuddy/benefits
 */

import type { WorkBuddyBenefit } from './upstream.ts'

/** What the account card shows for one campaign. */
export type WorkBuddyBenefitState =
  /** Offered, inside its window, not taken yet. The only state with a claim button. */
  | 'claimable'
  /** This account already took it. Rendered as nothing at all. */
  | 'claimed'
  /** The window is over and it was never taken — the offer is gone. */
  | 'expired'

/** One campaign, resolved for display. */
export interface WorkBuddyBenefitView {
  kind: WorkBuddyBenefit['kind']
  state: WorkBuddyBenefitState
  /** Credits on offer, as the gateway stated them. */
  creditNum: number
  /** Window end, epoch ms. */
  endsAtMs?: number
  /** Whole days until the window closes, floored at 0. Absent without `endsAtMs`. */
  daysLeft?: number
  /** True while the window closes within {@link URGENT_DAYS} days. */
  urgent: boolean
}

/** The 「3 天内到期」 highlight threshold, in days. */
export const URGENT_DAYS = 3

/** How the display copy names each campaign. */
export const WORKBUDDY_BENEFIT_TITLES: Record<WorkBuddyBenefit['kind'], string> = {
  compensation: '模型服务异常补偿',
  gift: '新人首月赠送',
}

/**
 * Resolve one campaign against the clock.
 *
 * `active` is the gateway's own window verdict and is trusted as-is; the clock is
 * consulted only for the countdown, never to override `active`. An account whose
 * clock is skewed therefore still renders the upstream's answer rather than a
 * locally-invented one.
 */
export function benefitOf(benefit: WorkBuddyBenefit, nowMs: number): WorkBuddyBenefitView {
  const daysLeft = benefit.endsAtMs === undefined
    ? undefined
    : Math.max(0, Math.ceil((benefit.endsAtMs - nowMs) / 86_400_000))
  const state: WorkBuddyBenefitState = benefit.claimed
    ? 'claimed'
    : benefit.active ? 'claimable' : 'expired'
  return {
    kind: benefit.kind,
    state,
    creditNum: benefit.creditNum,
    ...benefit.endsAtMs === undefined ? {} : { endsAtMs: benefit.endsAtMs },
    ...daysLeft === undefined ? {} : { daysLeft },
    urgent: state === 'claimable' && daysLeft !== undefined && daysLeft <= URGENT_DAYS,
  }
}

/**
 * The claimable campaigns of one account, urgent first.
 *
 * Ordered by `daysLeft` ascending so the soonest-expiring offer leads — the whole
 * point of surfacing this is that a 3-day window otherwise lapses unnoticed. A
 * campaign with no stated end sorts last, because "no deadline" is never more
 * urgent than a deadline.
 *
 * `claimed` and `expired` campaigns are dropped here, not in the renderer: the
 * user asked for them to be ABSENT, and encoding that in one tested place beats
 * asking every caller to remember to filter.
 */
export function claimableBenefits(
  benefits: readonly WorkBuddyBenefit[],
  nowMs: number,
): WorkBuddyBenefitView[] {
  return benefits
    .map(benefit => benefitOf(benefit, nowMs))
    .filter(view => view.state === 'claimable')
    .sort((left, right) => (left.daysLeft ?? 1_000_000) - (right.daysLeft ?? 1_000_000))
}

/**
 * How long a fetched set of benefits may be reused.
 *
 * Deliberately coarse. Claim state only changes when the USER acts elsewhere (the
 * web page or the desktop app), or when a campaign opens/closes — none of which
 * is worth a per-poll read of two endpoints per account. The card polls; this
 * keeps that from becoming 2 × N requests every minute.
 */
export const BENEFIT_CACHE_MS = 30 * 60 * 1000
