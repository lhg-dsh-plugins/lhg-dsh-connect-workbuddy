/**
 * Writing the model's saved directory back to the Host's settings document.
 *
 * THE HOST-SIDE HALF OF ISSUES #114/#115. The card's own save path lives in the
 * browser half (`src/client/`), but the repair that heals a STALE saved
 * directory has to happen where the LIVE roster lands — inside the Host
 * process, right after the upstream answered. So this module writes through
 * the Host's own settings service, using the same merge discipline the
 * browser half uses (see `src/web-status.ts`).
 *
 * WHY NOT JUST WRITE THE WHOLE `regions` FIELD. Because the field holds
 * BOTH regions plus each region's account-pool preferences, and a blind write
 * would drop whatever the user changed in the other region (issue #32's
 * lesson, in a new place). So the write is a MERGE: the region's slot is
 * replaced, every other key of the slot is preserved, and the sibling region
 * is untouched.
 *
 * THE VALUE THIS MODULE WRITES IS THE `regions` FIELD, NOT THE SETTINGS
 * SECTION. That distinction is the whole of this bug — reported as
 * "账号池状态重启就失效". `describe()` hands back the resolved SECTION
 * (`{authFile, accounts, regions, cliBridge, …}`), and
 * `mutate(ns, [{ op: 'set', path: ['regions'], … }])` stores whatever it is
 * given AT that path. Handing it the section therefore wrote the section INTO
 * the field: the real region map was pushed down under a nested `regions` key,
 * its own siblings (`accounts`, `cliBridge`) became fake region slots, and the
 * Host's `regionStateOf(config, 'cn')` — which reads exactly one level — then
 * answered "no slot". Every account-pool preference, model selection and
 * directory looked unsaved after the next restart, and each startup added
 * another level (measured on a live profile: five levels, 258 KB).
 *
 * WHY THE HOST SERVICE RATHER THAN THE SCOPE. The plugin's browser half
 * writes through the Host's settings endpoint because the browser-side
 * `scope.set()` replaces the whole field with the browser's own (possibly
 * stale) mirror — that is documented at `src/client/account-selection.ts`.
 * The same reasoning applies here: there is no browser mirror in the Host
 * process, so the Host's own merge is the only safe writer.
 *
 * @module dsh-connect-workbuddy/catalog-write
 */

import { regionsFieldIsCorrupt, regionsMapOf, unwrapVolatileDeep } from './status-paths.ts'
import type { WorkBuddyModelInfo } from './catalog.ts'
import type { WorkBuddyRegion } from './upstream.ts'

/**
 * The shape this module needs from the Host's settings service.
 *
 * Narrow on purpose: `describe()` returns the resolved config per namespace
 * (with volatile fields as live references), and `mutate()` applies one
 * operation to a field path. Both are the same calls `src/web-status.ts`
 * makes for the card's save.
 */
export interface HostSettingsService {
  describe(): readonly { ns: string; value?: unknown }[]
  mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], expectedRevision?: number): Promise<void>
}

/**
 * Merge one region's repaired directory into the `regions` FIELD.
 *
 * `current` may be EITHER the resolved settings section (what `describe()`
 * answers, and what {@link writeRegionCatalog} passes) OR the bare `regions`
 * field; `regionsMapOf` narrows both and heals a document the bug above already
 * corrupted. The RETURN value is always the field itself — the exact shape
 * `path: ['regions']` expects — never the section around it.
 *
 * The merge is done on the AUTHORITATIVE value the settings service holds —
 * not on a snapshot the caller brought — because a snapshot can be stale and
 * a stale merge is how the other region disappears.
 */
export function mergeRegionCatalog(
  current: unknown,
  region: WorkBuddyRegion,
  catalog: readonly WorkBuddyModelInfo[],
): Record<string, unknown> {
  const regions = regionsMapOf(current)
  const stored = regions[region]
  const slot = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : {}
  return {
    ...regions,
    [region]: { ...slot, lastCatalog: catalog },
  }
}

/**
 * Write one region's repaired directory.
 *
 * @param service The Host's settings service.
 * @param ns The namespace the Host serves this plugin under.
 * @param region The region whose slot is repaired.
 * @param catalog The repaired directory.
 * @returns whether the write happened.
 */
export async function writeRegionCatalog(
  service: HostSettingsService | undefined,
  ns: string,
  region: WorkBuddyRegion,
  catalog: readonly WorkBuddyModelInfo[],
): Promise<boolean> {
  if (service === undefined) return false
  const row = service.describe().find(entry => entry.ns === ns)
  if (row === undefined) return false
  const current = unwrapVolatileDeep(row.value ?? {}) as Record<string, unknown>
  const next = mergeRegionCatalog(current, region, catalog)
  await service.mutate(ns, [{ op: 'set', path: ['regions'], value: next }], undefined)
  return true
}

/**
 * Clean a `regions` field an older build corrupted, WITHOUT touching any
 * region's content.
 *
 * WHY THIS IS SEPARATE FROM {@link writeRegionCatalog}. The catalog repair is
 * the writer that produced the wreckage, so it is also a natural place to clean
 * it — but it only runs when the live roster arrived (an enabled region, a
 * reachable upstream, a non-empty answer). A profile would therefore stay dirty
 * for as long as the network is down, and a region the user has switched OFF
 * would never be cleaned at all. This write needs neither: it is one settings
 * round-trip at boot, and it is a no-op for every healthy profile (a single key
 * scan, no mutation).
 *
 * It is a pure shape fix, not a merge: `regionsMapOf` already answers the
 * healed map, and the field is replaced with exactly that. Reads are correct
 * without this write (they narrow through the same helper), so failing to write
 * costs tidiness only — the caller logs and carries on.
 *
 * @returns whether the write happened.
 */
export async function healRegionsField(
  service: HostSettingsService | undefined,
  ns: string,
): Promise<boolean> {
  if (service === undefined) return false
  const row = service.describe().find(entry => entry.ns === ns)
  if (row === undefined) return false
  const section = row.value ?? {}
  // Ask the FIELD, not the section: the section legitimately carries `accounts`
  // and `cliBridge` beside `regions`, so the question would always be "dirty".
  if (!regionsFieldIsCorrupt((section as Record<string, unknown>)['regions'])) return false
  await service.mutate(ns, [{ op: 'set', path: ['regions'], value: regionsMapOf(section) }], undefined)
  return true
}
