/**
 * How a credit balance is written on screen.
 *
 * `4.4.5` made the balance exact: it now comes from the upstream's `*Precise`
 * family, so the number carries a fraction (`2,196.61`) where it used to be a
 * whole integer. The card does not show that fraction — a narrow row reads
 * better, and the product's own breakdown (套餐基础 / 平台奖励 / 购买) is the
 * place to look for detail.
 *
 * Taking the FLOOR rather than rounding is the one decision here, and it is not
 * cosmetic:
 *
 * - a balance is a quantity you either have or do not. `0.61` rounded UP prints
 *   `1`, which tells the reader they can spend a credit they do not have;
 * - the official client shows `2,196.61`, so its integer part is `2,196` — the
 *   floor. Rounding would print `2,197` and make a card that had JUST been
 *   reconciled against the client look one credit off, which is the exact
 *   complaint (issue #58) this display rule is downstream of.
 *
 * Grouping is kept because a four-figure balance is otherwise hard to read at a
 * glance, and it is the only reason this is not `Math.floor(value).toString()`.
 *
 * @module dsh-connect-workbuddy/client/credit-format
 */

/**
 * Format a credit balance for display: whole credits, grouped, floored.
 *
 * `Math.floor` before `toLocaleString` (rather than a `maximumFractionDigits`
 * option) is deliberate: the option ROUNDS, so it would print `2,197` for
 * `2,196.61`.
 */
export function formatCredits(value: number): string {
  return Math.floor(value).toLocaleString('en-US')
}
