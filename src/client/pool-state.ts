/**
 * Pure decision helpers for the account pool's card section.
 *
 * 参考：`src/account-pool.ts` 的做法——把「判定规则」从组件里抽出来，让规则本身
 *   可被单测直接钉住，而不是只能通过渲染整棵组件树间接观察。
 * 改动：新增本模块，收纳三组此前内联在 `AccountPool.tsx` 里的判定。抽出它们的
 *   直接原因是**独立验证发现 H-1/H-2 两个最高危修复没有任何自动化回归测试**：
 *   内联在组件里就只能靠真实渲染验证，而渲染测试既慢又容易被隔离问题骗过。
 *
 * 本模块不 import React、不碰网络，纯函数、全函数。
 *
 * @module dsh-connect-workbuddy/client/pool-state
 */

import { effectiveMembersOf } from '../account-pool.ts'
import type { Translate } from './searched-paths.ts'

/** The preference fields the pool section edits. */
export interface PoolPreferencesLike {
  enabled: boolean
  targetModelId: string
  /**
   * Per-account test model, keyed by account id (issue #61).
   *
   * Optional so an older host payload still satisfies this type; an absent map
   * means every account uses `targetModelId`, exactly as before.
   */
  /**
   * Tokens each test probe sends, or `undefined`/`0` for the host's default.
   *
   * Optional so the type does not force every host payload and test fixture to
   * carry it: an absent field must behave exactly like "use the default", which
   * is what the host does with an older profile.
   */
  probeInputTokens?: number
  memberAccountIds: readonly string[]
  /**
   * Manual priority order for member accounts — the order the pool spends
   * them in. Unlike `memberAccountIds`, ordering is ORDER-SENSITIVE: swapping
   * two positions is a meaningful change, so the round-trip verification and
   * dirty detection must compare positionally, never as a set.
   */
  orderAccountIds: readonly string[]
}

/**
 * The base a draft edit starts from.
 *
 * Resolved at EDIT time rather than captured when the callback was built. The
 * defect this fixes: the callback's dependency list named individual scalar
 * fields, so a field added later (`memberAccountIds`) was missing from it and
 * the callback kept a STALE base — checking one account then silently dropped
 * another that had been saved in between.
 *
 * `previous` is the draft already in state; it only applies to the region it
 * was made on, because the two pools are independent and one region's unsaved
 * edits must never seed the other's.
 */
export function draftBaseFor<T extends PoolPreferencesLike>(
  previous: T | null,
  previousRegion: string | undefined,
  region: string,
  saved: T,
): T {
  return previous !== null && previousRegion === region ? previous : saved
}

/**
 * Membership that resolves to a real local sign-in — what a batch runs on.
 *
 * The HOST computes this and sends it; this helper only chooses which answer to
 * trust. Counting the raw saved list is what let the UI claim "已选 1 / 共 1"
 * and enable both buttons while the batch ran on ZERO accounts and reported
 * success, so:
 *
 *   - while the draft is CLEAN, the Host's answer is authoritative (it reflects
 *     what would actually run, including sign-ins that have since disappeared);
 *   - while the draft is DIRTY, it must be derived from the edited list, since
 *     the Host's answer describes the SAVED state and would ignore the edit the
 *     user is looking at.
 */
export function effectiveMemberIds(input: {
  savedEffective: readonly string[]
  draftMembers: readonly string[]
  listedIds: ReadonlySet<string>
  dirty: boolean
}): string[] {
  if (!input.dirty) return [...input.savedEffective]
  // The dirty branch is the shared rule, not a fourth copy of it.
  return effectiveMembersOf(input.draftMembers, input.listedIds)
}

/**
 * Saved member ids with no matching sign-in.
 *
 * Surfaced rather than silently ignored: the ids remain in the user's saved
 * list (a login can come back), so the card has to explain why the pool behaves
 * as though they were absent.
 */
export function ghostMemberIds(
  draftMembers: readonly string[],
  listedIds: ReadonlySet<string>,
): string[] {
  return draftMembers.filter(id => !listedIds.has(id))
}

/** One saved-but-unsigned member, labelled as well as this machine can. */
export interface GhostMember {
  id: string
  /**
   * What to call it on screen.
   *
   * A measured name when one exists (see `WorkBuddyPoolProbe.accountName`),
   * otherwise a short id prefix — never a blank. The prefix is a poor label but
   * an honest one, and it is still enough to tell two ghosts apart; inventing
   * something friendlier (a position, an index) would point the user at the
   * wrong account.
   */
  label: string
  /** True when {@link label} is a name rather than an id prefix. */
  named: boolean
}

/** How many characters of an id are shown when no name was ever measured. */
const GHOST_ID_PREFIX = 8

/**
 * Label saved member ids that resolve to no local sign-in (issue #60).
 *
 * The old warning was a bare count, which named no account and had no
 * corresponding row — the user could neither identify the member nor act on it,
 * even though the collected name was in hand at write time. This turns the same
 * set into something renderable and specific.
 *
 * `names` is the Host's last-measured map; a missing entry means no measurement
 * ever recorded a name, not that the account has none. Ids keep the order the
 * saved list has, so the rendered list does not reshuffle between polls.
 */
export function ghostMembers(
  draftMembers: readonly string[],
  listedIds: ReadonlySet<string>,
  names: Readonly<Record<string, string | undefined>> = {},
): GhostMember[] {
  return ghostMemberIds(draftMembers, listedIds).map((id) => {
    const measured = names[id]
    const named = typeof measured === 'string' && measured !== ''
    return {
      id,
      label: named ? measured : `${id.slice(0, GHOST_ID_PREFIX)}…`,
      named,
    }
  })
}

/**
 * The names to show in one sentence, capped so the warning stays readable.
 *
 * Beyond three the sentence would wrap into a paragraph, so it ends with an
 * ellipsis — the removable list rendered underneath carries the full set, which
 * is why truncating here cannot hide a member.
 */
export function ghostNameList(ghosts: readonly GhostMember[], limit = 3): string {
  const shown = ghosts.slice(0, limit).map(ghost => ghost.label).join('、')
  return ghosts.length <= limit ? shown : `${shown}…`
}

/**
 * How many accounts a batch will really touch, as the log announces it.
 *
 * Mirrors the HOST's own resolution exactly — `effective ?? saved` in the pool
 * route — because the number in the activity log must describe what the Host
 * runs, not what the card happens to display. Two wrong answers are possible and
 * both were live at different times:
 *
 *   - counting the raw SAVED list overstates it, so a ghost-only pool logged
 *     "checking in 1 account(s)" and was then refused with 409 having touched
 *     nothing;
 *   - counting the DRAFT-derived set announces unsaved edits the Host will not
 *     run (it reads the committed config).
 *
 * `savedEffective` is `undefined` only for a Host too old to send it, where the
 * saved list is the best available answer — the same fallback the route uses.
 */
export function announcedBatchCount(input: {
  savedEffective: readonly string[] | undefined
  savedMembers: readonly string[]
}): number {
  return (input.savedEffective ?? input.savedMembers).length
}

/**
 * Localize a pool route failure from its structured cause.
 *
 * Lives here, not in `AccountPool.tsx`, because the card's module graph pulls
 * DSH's browser packages and there is no jsdom in this project — a rule left
 * inside the component cannot be tested at all. That is not hypothetical: the
 * independent verification deleted this function's `no-live-members` branch AND
 * both locale copies of its copy, and the whole 618-test suite still passed.
 * Extracting it is what lets `tests/pool-state.spec.ts` pin every branch.
 *
 * Returns undefined for an unknown cause so the caller can fall back to the
 * Host's own words — a new cause added upstream must still be visible rather
 * than swallowed into a generic message.
 *
 * `detail` is the Host's raw `error` text, used only where the sentence has a
 * slot for it (`pool-failed`). It is NOT the primary path: echoing English
 * developer prose into a Chinese UI was the defect this function exists to
 * prevent, and only the cases with no structured cause fall back to it.
 */
export function poolErrorText(
  t: Translate,
  reason: string | undefined,
  detail?: string,
): string | undefined {
  switch (reason) {
    case 'no-members': return t('row.poolErrNoMembers')
    case 'no-live-members': return t('row.poolErrNoLiveMembers')
    case 'no-free-model': return t('row.poolErrNoFreeModel')
    case 'target-model-stale': return t('row.poolErrStaleModel')
    case 'checkin-unsupported': return t('row.poolErrNoCheckin')
    case 'pool-unavailable': return t('row.poolErrUnavailable')
    case 'pool-failed': return t('row.poolErrFailed', { message: detail ?? '' })
    default: return undefined
  }
}

/**
 * The message to show for a failed pool request, from every signal available.
 *
 * The three-tier rule, in order, and why each tier exists:
 *
 *  1. the STRUCTURED cause, localized — the Host's `error` is an English
 *     developer sentence, and echoing it put untranslated prose in a Chinese UI;
 *  2. the Host's raw text, for a cause this build does not know — still more
 *     informative than a generic message, and it keeps a new upstream cause
 *     visible rather than swallowed;
 *  3. a message keyed on the STATUS — every pool exit that carries no reason
 *     (405/403/400 and the generic 500) otherwise reached the user as bare
 *     English like `HTTP 405`.
 *
 * Tier 3 splits once more when the response body was not JSON at all: see
 * {@link PoolFailureInput.bodyUnreadable}. A 405 with an empty body is not the
 * plugin refusing the method — it is the Host's HTTP layer answering for a route
 * that was never registered, i.e. a Host process still running older code.
 *
 * Extracted from the card for the same reason as {@link poolErrorText}: a rule
 * inside the browser-only `.tsx` cannot be tested, and the status tier in
 * particular had no guard at all — reverting it to `` `HTTP ${status}` `` left
 * the entire suite green.
 */
export interface PoolFailureInput {
  status: number
  reason?: string | undefined
  error?: string | undefined
  /**
   * The response carried no JSON document at all (the body would not parse).
   *
   * Every handler behind these routes answers in JSON, INCLUDING its own 405
   * (`{error:'method not allowed'}`). So a 405 whose body is empty or unparseable
   * did not come from the plugin: it is the Host's HTTP layer, which only answers
   * that way when the path was never registered. In practice that means the Host
   * process is still running a build from before this route existed, and the fix
   * is to restart DSH — NOT to check the plugin version, which is the misleading
   * advice this branch replaces (issue #86: a real 405 from exactly this cause
   * told the user "请确认插件是最新版本" while the plugin was already current).
   */
  bodyUnreadable?: boolean
}

export function poolFailureText(
  t: Translate,
  input: PoolFailureInput,
): string {
  return poolErrorText(t, input.reason, input.error)
    ?? input.error
    ?? (input.bodyUnreadable === true && input.status === 405
      ? t('row.poolErrRouteMissing')
      : t('row.poolErrHttp', { status: String(input.status) }))
}

/**
 * Pool MEMBERS that can serve right now.
 *
 * Judged over members only. Using the whole account table made the "no usable
 * account" warning unreachable: unchecked rows are listed for the user to opt
 * into and never carry `excludedBy`, so any unchecked sign-in kept the count
 * above zero — exactly when every member was limited and the explanation was
 * most needed.
 */
export function usableMemberIds<T extends { accountId: string, excludedBy?: string }>(
  accounts: readonly T[],
  effectiveMembers: readonly string[],
  draftMembers: readonly string[],
): string[] {
  const wanted = new Set([...effectiveMembers, ...draftMembers])
  return accounts
    .filter(account => wanted.has(account.accountId) && account.excludedBy === undefined)
    .map(account => account.accountId)
}
/**
 * Whether EVERY member is blocked by the same MODEL — issue #64's pool-level
 * verdict.
 *
 * The reporter's case: four members, all measured `model-busy`, and the card
 * only showed four rows each saying "模型繁忙". Summed up by the reader that
 * reads as "my pool is broken", and the natural next move — switch accounts —
 * is the one action that cannot help, because the limit follows the model. The
 * per-row labels are each true and the aggregate conclusion is false, which is
 * why this needs its own decision rather than another row label.
 *
 * The conditions, and where each is enforced — NOT just "some member is
 * model-busy":
 *
 *   - **at least one member.** Enforced by the length check: an empty pool has
 *     no model-wide story to tell, and the plain "no usable account" sentence is
 *     the honest one there (nothing is checked).
 *   - **no member usable, and every blocked member's reason IS `model-busy`.**
 *     Both fall out of the single `every` predicate, because a usable member has
 *     `excludedBy === undefined`. See the note at the return statement: they are
 *     genuinely one condition in code, and writing them as two produced an
 *     unreachable branch that no test could hold.
 *
 * A pool where one account is rate-limited and the rest are model-busy is NOT a
 * model verdict: the rate limit really is about that account, and saying "it is
 * the model, not your accounts" would be the same class of false comfort this
 * helper exists to remove.
 *
 * Returned as a boolean rather than a prebuilt sentence so the caller keeps
 * every user-visible string in the locale table.
 */
export function allMembersBlockedByModel<T extends { accountId: string, excludedBy?: string }>(
  accounts: readonly T[],
  effectiveMembers: readonly string[],
  draftMembers: readonly string[],
): boolean {
  const wanted = new Set([...effectiveMembers, ...draftMembers])
  const members = accounts.filter(account => wanted.has(account.accountId))
  if (members.length === 0) return false
  // ONE predicate covers both remaining conditions, and it is written as
  // `every` on purpose.
  //
  // A usable member has `excludedBy === undefined`, so `every(... === 'model-busy')`
  // is ALREADY false as soon as any member is usable. An explicit
  // "none usable" check would therefore never change the result — it is
  // unreachable as a decider, and a test written against it passes with the
  // check removed. Verified exhaustively over every combination of up to three
  // members: zero states where `every` holds while a usable member exists.
  //
  // So the requirement is stated once, where it is enforced. The two properties
  // a reader might expect to be separate ("not empty", "none usable") are noted
  // in the doc comment above instead of being spelled as code that cannot run.
  return members.every(member => member.excludedBy === 'model-busy')
}
