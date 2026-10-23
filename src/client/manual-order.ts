/**
 * Manual priority order, shared by every surface that lists member accounts.
 *
 * The defect this exists to prevent: the pool card sorts its rows by
 * `orderAccountIds` while the composer credits panel listed the same accounts
 * in whatever order the Host returned. Two views of one pool, disagreeing — the
 * user sorts the pool, opens the credit panel, and sees a different order, so
 * neither list looks authoritative. A user cannot tell which one is "the" order,
 * and the manual sorting feature looks broken even though it saved correctly.
 *
 * So the order lives here, once, and both lists call it. The alternative —
 * each component sorting however it likes — is exactly what drifted.
 */

import { regionsMapOf } from '../status-paths.ts'

/**
 * The saved manual order out of a settings snapshot, or an empty array.
 *
 * Reads defensively: the snapshot is Host-supplied JSON, so `regions` may be
 * absent (a profile that never used this feature), `pool` may be absent, and
 * `orderAccountIds` may be anything at all. Every shape that is not a list of
 * strings means "no manual order", which is also an older profile's spelling —
 * never a crash.
 *
 * The map comes from `regionsMapOf` rather than a bare `value.regions` lookup:
 * it accepts the section OR the field and heals a field an older build
 * corrupted (the "restart reset" report). That is not cosmetic here — on the
 * measured profile the INTERNATIONAL slot survived only one level down, so a
 * direct lookup reported "no manual order" for the region whose order the user
 * had actually saved, and the credit panel listed those accounts in the Host's
 * order instead.
 */
export function readOrderAccountIds(
  value: unknown,
  region: string | undefined,
): readonly string[] {
  if (region === undefined) return []
  const regions = regionsMapOf(value)
  const slot = regions[region]
  if (typeof slot !== 'object' || slot === null) return []
  const order = (slot as { pool?: unknown }).pool
  if (typeof order !== 'object' || order === null) return []
  const ids = (order as { orderAccountIds?: unknown }).orderAccountIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

/**
 * Reorder `accounts` to follow `orderIds`, leaving unordered accounts in place
 * AFTER the ordered ones, and preserving their original relative order.
 *
 * Returns a new array; never mutates the input, because the caller's array is
 * usually a state value that must not change identity behind React's back.
 *
 * Ids in `orderIds` that no longer name an account are simply ignored: the pool
 * can drop a member while an order still mentions it, and that must degrade to
 * "that position is empty" rather than hide a real account.
 */
export function applyManualOrder<T extends { readonly id: string }>(
  accounts: readonly T[],
  orderIds: readonly string[],
): T[] {
  if (orderIds.length === 0) return [...accounts]
  const rank = new Map<string, number>()
  orderIds.forEach((id, index) => {
    // First occurrence wins: a duplicated id (should not happen, but the value
    // comes from storage) must not shift everything after it.
    if (!rank.has(id)) rank.set(id, index)
  })
  const ordered: T[] = []
  const rest: T[] = []
  for (const account of accounts) {
    if (rank.has(account.id)) ordered.push(account)
    else rest.push(account)
  }
  // Sort only the ordered slice. The unordered slice keeps the caller's
  // original sequence, which is the best available signal for those rows —
  // inventing an order for them would be worse than showing them as they came.
  ordered.sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0))
  return [...ordered, ...rest]
}
