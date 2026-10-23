/**
 * Verified writes of the per-region account slot.
 *
 * 参考：DSH 自带插件卡片（`@deepseek-ai/dsh-client-ui-settings-plugins`
 *   的 `CardForm.store()`）— 「写入后回读用户层并与写入值比对」这一校验形态，
 *   是本模块 `writeAccountSlot()` 的出发点。
 * 改动：针对账号槽位重写而非照搬 —— 回读的是**解析后的 section**而非 user 层
 *   （Host 的 legacy 归属也读它，两者必须同源），并用精确比较区分 `''`（哨兵清除）
 *   与 `undefined`（键缺失），因为后者会让区域重新回退到旧版 `accountId`。
 *
 * Kept out of `WorkBuddyCard.tsx` — and free of any browser-only import — so
 * the write contract can be unit-tested directly. The card is a `.tsx`
 * component whose module graph pulls DSH's browser packages, which cannot load
 * in the Node test environment; the check below is exactly the part that must
 * not go untested.
 *
 * @module dsh-connect-workbuddy/client/account-selection
 */

import { nextRegionModels, nextRegionPool, regionsMapOf, unwrapVolatileDeep } from '../status-paths.ts'
import type { WorkBuddyWebRegion, WorkBuddyCreditPosition } from '../status-paths.ts'

/**
 * The slice of the bound settings scope this module writes through.
 *
 * `value` is the RESOLVED section (schema defaults + composition base + user
 * layer), which is what both the card and this check must read: the card
 * derives the other region's preserved slot from it, so verification has to
 * look at the same source or the two can disagree.
 */
export interface WorkBuddyAccountScope {
  getSnapshot(): { value?: unknown }
  /**
   * Whether the Host accepted the write. On DSH 0.1.7 the scope resolves
   * `false` — it does NOT reject — when the Host refuses the mutation (stale
   * revision conflict, volatile-path validation, unwritable profile); the
   * scope then reloads Host state on its own. `undefined`/`void` (the 0.1.5
   * scope) counts as accepted: that line has no refusal channel.
   */
  set(field: string, value: unknown): Promise<boolean | void>
}

/**
 * A settings write that did not take effect.
 *
 * Distinct from a rejected `set()`: this is thrown when the write reported
 * success and the value is nonetheless absent from the document.
 */
export class WorkBuddySettingsWriteError extends Error {
  /** The settings field that did not land. */
  readonly field: string

  constructor(field: string, reason?: string) {
    super(`workbuddy: settings field "${field}" was not persisted by the settings write${reason === undefined ? '' : `: ${reason}`}`)
    this.name = 'WorkBuddySettingsWriteError'
    this.field = field
  }
}

/**
 * Whether a save failure is a FILE-CONTENTION refusal.
 *
 * On Windows, replacing a file that another process holds open fails with
 * `EPERM` / `EBUSY` / `EACCES` — an antivirus scanner, a sync client (OneDrive),
 * or an editor with the profile's patch file open. POSIX `rename` replaces
 * outright regardless of open handles, so this branch effectively never fires
 * on macOS/Linux: the diagnosis is Windows-shaped because the failure is.
 *
 * It exists so a save failure can say WHAT TO DO. Without it the card pasted the
 * raw error at the user — `EPERM: operation not permitted, rename
 * 'C:\…\cordis.patch.yml.79498ff8fb27.tmp' -> '…\cordis.patch.yml'` — which
 * names a temp path and no remedy. Measured live against the 3.0.0 host with the
 * file held open: both the `regions` and `accounts` writes came back HTTP 500
 * with exactly that text.
 *
 * Deliberately matched on the message rather than on `WorkBuddySettingsWriteError`
 * alone: a validation refusal is also that class but has nothing to do with file
 * contention, and telling such a user to close their editor would send them
 * chasing a cause that is not there.
 */
export function isFileContentionWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:EPERM|EBUSY|EACCES)\b/u.test(message)
}

/**
 * Read one settings field's current object value from the scope snapshot.
 *
 * The snapshot holds the RESOLVED section, where a volatile field
 * (`regions` / `accounts`) is a `{get(): T}` LIVE reference rather than the
 * plain object it resembles. Unwrapping first is not cosmetic: a live reference
 * is still `typeof === 'object'`, so without this the caller spreads it into
 * `{ get: <function> }` — which DROPS every sibling key (the other region) and
 * leaks a reference function into the document.
 *
 * That was the "saving the international region loses the domestic one" report:
 * every write here preserves the region it is not touching by spreading this
 * value, so reading it wrong silently deleted the untouched region.
 */
function fieldSnapshotOf(
  scope: WorkBuddyAccountScope,
  field: 'accounts' | 'regions',
): Record<string, unknown> {
  const stored = (scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field]
  // `regions` is narrowed (and healed) by the shared helper rather than unwrapped
  // here: a field written by an older build carries sibling-field copies and the
  // real region map one level down, and spreading THAT as a write base would
  // carry the wreckage into every save forever (the "restart reset" report).
  // `accounts` is a flat id map with no such history, so it only needs the
  // unwrap.
  if (field === 'regions') return regionsMapOf(stored)
  const value = unwrapVolatileDeep(stored)
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Fallback write: POST the field to the plugin's own Host endpoint.
 *
 * The endpoint handler runs the settings mutate inside the Host process and
 * reports the raw refusal exception, so a failure here names its cause instead
 * of arriving as a swallowed `ok:false`. It merges the posted region key into
 * the field's live value, preserving the other region.
 */
async function saveViaHostEndpoint(
  field: 'accounts' | 'regions' | 'cliBridge',
  region: WorkBuddyWebRegion | undefined,
  value: unknown,
): Promise<Record<string, unknown> | undefined> {
  let response: Response
  try {
    response = await fetch('/plugins/dsh-connect-workbuddy/__save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A region field posts `{ <region>: value }`; the global `cliBridge` block
      // posts itself, because it has no sibling regions to preserve.
      body: JSON.stringify({ field, value: region === undefined ? value : { [region]: value } }),
    })
  } catch (error) {
    throw new WorkBuddySettingsWriteError(field, `Host save endpoint unreachable: ${String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` })) as { errorName?: string, error?: string }
    const reason = `${String(detail.errorName ?? '')} ${String(detail.error ?? '')}`.trim()
    throw new WorkBuddySettingsWriteError(field, `Host save refused: ${reason === '' ? String(detail.error) : reason}`)
  }
  // The endpoint answers with the field it actually stored (it merged the
  // posted region into the authoritative value). Returned so the caller can
  // mirror THAT rather than re-deriving the field from its own stale mirror.
  // Older hosts answer `{ok:true}` alone, hence `undefined`.
  const answer = await response.json().catch(() => undefined) as { value?: Record<string, unknown> } | undefined
  return answer?.value
}

/**
 * Read the committed CodeBuddy-CLI switch out of a settings snapshot.
 *
 * Only an explicit `true` is ON, matching the schema's `default(false)`: this
 * switch authorizes a child process that edits files and spends CodeBuddy
 * quota, so an absent value must never read as consent.
 */
export function cliBridgeEnabledOf(configured: unknown): boolean {
  const bridge = (configured as { cliBridge?: unknown } | undefined)?.cliBridge
  return typeof bridge === 'object' && bridge !== null
    && (bridge as { enabled?: unknown }).enabled === true
}

/**
 * Write the GLOBAL CodeBuddy-CLI switch, verifying it landed.
 *
 * Deliberately NOT a region field: one route, one budget, one switch. The two
 * writers are the same as everywhere else — the plugin's Host endpoint first
 * (authoritative merge, so the tuned caps beside `enabled` survive), the
 * settings scope second — because this namespace's browser mirror is documented
 * as stale on the affected 0.1.7 deployments, and a switch that merely *looks*
 * flipped is exactly the "关闭不了" class of report.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param enabled - the desired state.
 * @throws {WorkBuddySettingsWriteError} when neither writer persists the value.
 */
export async function writeCliBridgeEnabled(
  scope: WorkBuddyAccountScope,
  enabled: boolean,
): Promise<void> {
  let hostError: unknown
  try {
    const authoritative = await saveViaHostEndpoint('cliBridge', undefined, { enabled })
    if (authoritative !== undefined) {
      // Mirror what the Host stored, never a client-side re-merge.
      try { await scope.set('cliBridge', authoritative) } catch { /* optional */ }
    }
    return
  } catch (error) {
    hostError = error
  }
  const stored = unwrapVolatileDeep(
    (scope.getSnapshot().value as Record<string, unknown> | undefined)?.cliBridge,
  )
  const next = {
    ...typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {},
    enabled,
  }
  let delivered = false
  try {
    delivered = (await scope.set('cliBridge', next)) !== false
  } catch {
    delivered = false
  }
  if (delivered && cliBridgeEnabledOf(scope.getSnapshot().value)) return
  throw hostError instanceof Error
    ? hostError
    : new WorkBuddySettingsWriteError('cliBridge', 'neither the Host save endpoint nor the settings scope persisted the value')
}

/**
 * Write one volatile field, then confirm the value actually landed.
 *
 * ORDER MATTERS, and getting it wrong DELETES DATA. The two writers do not have
 * the same semantics:
 *
 * - The Host save endpoint merges the posted region into the field's
 *   AUTHORITATIVE value inside the Host process, preserving every other region.
 * - `scope.set(field, next)` hands the settings service the WHOLE field, merged
 *   on the CLIENT out of the browser mirror. The Host performs no server-side
 *   merge on this path, so whatever the client built REPLACES the field.
 *
 * The mirror is not a reliable merge base: a write made through the Host
 * endpoint does not update it (that lag is documented on `contextBudgets`
 * below), and on the affected 0.1.7 deployment the mirror for this namespace
 * stays stale outright. Building the merge from it therefore produced
 * `{ [region]: slot }` with every SIBLING region missing — and `scope.set`
 * stores that verbatim, deleting them. That was the report "I saved the
 * domestic region and the international one was gone": `accounts` survived
 * (written while the mirror happened to be fresh) while `regions` lost a slot.
 *
 * So the Host endpoint goes FIRST — it is the only writer that cannot delete a
 * sibling. `scope.set` is then attempted purely as a mirror refresh, and only
 * when it delivers is the write considered done without the endpoint.
 *
 * `landed` decides whether a value read back from the scope is the value that
 * was written; it is per-field because `''` (a cleared account slot) and an
 * absent key are different states, and a truncated model catalog must not pass
 * a shallow "is anything there?" check.
 *
 * @throws {WorkBuddySettingsWriteError} when neither path persists the value.
 */
async function writeField(
  scope: WorkBuddyAccountScope,
  field: 'accounts' | 'regions',
  region: WorkBuddyWebRegion,
  value: unknown,
  landed: (readBack: unknown) => boolean,
): Promise<void> {
  // 1. Authoritative, server-side merge: cannot drop the sibling region.
  let hostError: unknown
  try {
    const authoritative = await saveViaHostEndpoint(field, region, value)
    // 2. Refresh the browser mirror with the value the HOST actually stored,
    //    never with a re-merge of the client's own (possibly stale) mirror —
    //    on a scope that stores whatever it is handed, writing the stale merge
    //    back would undo the sibling-preserving merge made above. Best-effort
    //    only: the Host is already the authority, so a refused refresh is fine.
    if (authoritative !== undefined) {
      try { await scope.set(field, authoritative) } catch { /* optional */ }
    }
    return
  } catch (error) {
    hostError = error
  }

  // 2. Endpoint unavailable (older Host, or route not mounted): fall back to
  //    the scope, and verify the value really landed.
  let scopeDelivered = false
  try {
    scopeDelivered = (await scope.set(field, { ...fieldSnapshotOf(scope, field), [region]: value })) !== false
  } catch {
    scopeDelivered = false
  }
  if (scopeDelivered && landed(fieldSnapshotOf(scope, field)[region])) return
  throw hostError instanceof Error
    ? hostError
    : new WorkBuddySettingsWriteError(field, 'neither the Host save endpoint nor the settings scope persisted the value')
}

/** Read the per-region account selections out of the settings snapshot. */
export function configuredAccountsOf(configured: unknown): Record<string, string> {
  const accounts = (configured as { accounts?: unknown } | undefined)?.accounts
  return typeof accounts === 'object' && accounts !== null ? accounts as Record<string, string> : {}
}

/**
 * Write one region's account slot, then confirm the value actually landed.
 *
 * `settingsScope.set()` resolving is NOT proof that anything was stored. The
 * Host's document is the active profile's patch file (`cordis.patch.yml`, the
 * `config-editor`'s `documentPath`; volatile fields land there too, through
 * the same `edit()`. `settings.yaml` is NOT it on the 0.1.7 line — that file
 * is imported once from earlier releases and renamed to
 * `settings.yaml.imported`), replaced by writing a temp file and
 * renaming it over the target; on Windows an antivirus scanner, a sync client
 * (OneDrive, Dropbox), or an open editor can hold the file briefly.
 * `@deepseek-ai/dsh-atomic-write` retries `EPERM` / `EBUSY` / `EACCES` a
 * bounded number of times and those retries exist only for `win32` — and once
 * they are exhausted the failure reaches the client as an unsuccessful
 * response, which the settings scope handles by reloading Host state and
 * merely RETURNING. The caller's `await` therefore succeeds while the document
 * is unchanged.
 *
 * Reading the field back is the only reliable check, and it is what the
 * official plugin cards do (`CardForm.store()` compares the user layer against
 * the value it wrote). Failing loudly matters most on Clear: a false success
 * would flip the card to "following the app's sign-in" while the old selection
 * keeps running — the exact confusion that state line exists to remove.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param region - the region whose slot is written; the other is preserved.
 * @param value - the account id to save, or `''` to clear the region.
 * @throws {WorkBuddySettingsWriteError} when the value is readable back as
 *   something else — i.e. the write silently did not persist.
 */
export async function writeAccountSlot(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  value: string,
): Promise<void> {
  // Deliberately exact: `undefined` (slot absent) and `''` (slot cleared) are
  // different states with different meanings, and only the second one is a
  // successful clear. Treating them as equivalent would report success for a
  // write that removed the key and silently restored the legacy fallback.
  await writeField(scope, 'accounts', region, value, readBack => readBack === value)
}

/**
 * Write one region's saved model state, then confirm it actually landed.
 *
 * The same silent-failure mode as {@link writeAccountSlot} applies to EVERY
 * settings write, not just the account slot. It matters here for a different
 * reason: a successful save discards the user's draft, so a write that did not
 * persist makes the card throw away unsaved edits while claiming they were
 * saved — unrecoverable, since the drafts are the only copy.
 *
 * Verification compares the round-tripped `lastCatalog` ids, which is the part
 * of the payload that is both user-visible and cheap to compare; the selection
 * fields ride along in the same object and cannot land separately.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param region - the region whose model slot is written.
 * @param payload - the complete next state for that region's slot.
 * @throws {WorkBuddySettingsWriteError} when the catalog does not read back.
 */
export async function writeRegionModels(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  payload: { lastCatalog: readonly { id: string }[] } & Record<string, unknown>,
): Promise<void> {
  // Merge onto the EXISTING slot instead of replacing it. The slot also holds
  // the pool's preferences, so a replace would delete them: saving the model
  // list would silently wipe a pool configuration the user had just made. The
  // snapshot is read here rather than taken from the caller so no caller can
  // get this wrong.
  const merged = nextRegionModels(scope.getSnapshot().value, region, payload)
  const next = merged[region] as Record<string, unknown>
  // Compare the round-tripped catalog ids: they are user-visible and cheap to
  // compare, and the selection fields ride in the same object so they cannot
  // land separately. A present-but-truncated slot must not pass this check.
  const written = payload.lastCatalog.map(model => model.id)
  await writeField(scope, 'regions', region, next, readBack => {
    const stored = (readBack as { lastCatalog?: { id?: string }[] } | undefined)?.lastCatalog?.map(model => model.id)
    return stored !== undefined
      && stored.length === written.length
      && stored.every((id, index) => id === written[index])
  })
}

/**
 * Switch one region's provider off or on, with the same landed-check as every
 * other settings write.
 *
 * This exists because the toggle was the ONE write that still called
 * `scope.set()` directly. On the affected 0.1.7 deployments that scope settles
 * without storing anything, so flipping a provider off appeared to work and
 * then silently reverted — the exact silent-failure mode
 * {@link writeAccountSlot} and {@link writeRegionModels} were written to
 * prevent for their own fields. Routing it through {@link writeField} gives it
 * the same scope-first-then-Host-endpoint path, so the switch either lands or
 * reports why it did not.
 *
 * The write carries the region's whole slot through untouched — only `enabled`
 * changes — so the user's directory, model picks, image opt-ins and budgets
 * survive the round trip. The Host withdraws or restores the provider route on
 * the next `onChange`, which is what actually removes it from DSH's model
 * picker.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param region - the region being switched.
 * @param enabled - the desired state.
 * @param slot - the region's COMPLETE next slot (the caller owns the snapshot
 *   read and the whole-slot merge, so this stays a pure write).
 * @throws {WorkBuddySettingsWriteError} when neither writer persists the value.
 */
export async function writeRegionEnabled(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  enabled: boolean,
  slot: Record<string, unknown>,
): Promise<void> {
  await writeField(scope, 'regions', region, slot, readBack => {
    const stored = readBack as Record<string, unknown> | null | undefined
    return stored !== null && stored !== undefined && stored['enabled'] === enabled
  })
}

/**
 * Show or hide one region's sidebar credit line, with the same landed-check as
 * every other settings write.
 *
 * Routed through {@link writeField} for exactly the reason
 * {@link writeRegionEnabled} is: on the affected 0.1.7 deployments a direct
 * `scope.set()` settles without storing anything, so the switch would appear to
 * work and then silently revert — which for this control means the line
 * reappears on the next render with no explanation.
 *
 * The caller passes the region's COMPLETE next slot (the same whole-slot merge
 * rule as the other region writes), so hiding a line cannot drop the model
 * directory, selection, image opt-ins, budgets or pool preferences that live
 * alongside this flag in the same slot.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param region - the region whose line is being shown or hidden.
 * @param shown - the desired state.
 * @param slot - the region's COMPLETE next slot (caller owns the merge).
 * @throws {WorkBuddySettingsWriteError} when neither writer persists the value.
 */
export async function writeRegionImageToolEnabled(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  enabled: boolean,
  slot: Record<string, unknown>,
): Promise<void> {
  await writeField(scope, 'regions', region, slot, readBack => {
    const stored = readBack as Record<string, unknown> | null | undefined
    return stored !== null && stored !== undefined && stored['imageToolEnabled'] === enabled
  })
}

export async function writeRegionCreditsShown(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  shown: boolean,
  slot: Record<string, unknown>,
): Promise<void> {
  await writeField(scope, 'regions', region, slot, readBack => {
    const stored = readBack as Record<string, unknown> | null | undefined
    return stored !== null && stored !== undefined && stored['showCreditsInMainUi'] === shown
  })
}

/**
 * Write one region's credit SEAT (issue #62), verifying it landed.
 *
 * Sibling of {@link writeRegionCreditsShown}: same whole-slot merge, same
 * landed check, same reason for both. The seat decides only WHERE the readout
 * renders, so a lost write would leave the user looking at the old position
 * while the control claimed the new one.
 */
export async function writeRegionCreditPosition(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  position: WorkBuddyCreditPosition,
  slot: Record<string, unknown>,
): Promise<void> {
  await writeField(scope, 'regions', region, slot, readBack => {
    const stored = readBack as Record<string, unknown> | null | undefined
    return stored !== null && stored !== undefined && stored['creditPosition'] === position
  })
}

/**
 * Write one region's account-pool PREFERENCES, verifying they landed.
 *
 * Routed through {@link writeField} like every other settings write, so it gets
 * the same Host-endpoint-first path and the same landed check. The card treats
 * a resolved write as "the draft is now safe to discard", so a write that
 * silently did nothing would throw away the user's edits while reporting
 * success — unrecoverable, since the draft is the only copy.
 *
 * The COMPLETE region slot is passed in by the caller for the same reason
 * {@link writeRegionEnabled} does it: the pool lives INSIDE the region slot
 * alongside `lastCatalog`/`enabledModelIds`, so writing only the pool field
 * would drop the model list.
 *
 * Deliberately does NOT carry the pool's measured facts. Those are written by
 * the Host to its own file; keeping them out of settings is what stops a save
 * from rolling back a test result the timer had just recorded.
 *
 * @param scope - the bound settings scope for this plugin's namespace.
 * @param region - the region whose pool preferences are written.
 * @param preferences - the preference fields, as the user set them.
 * @param slot - the region's COMPLETE next slot (caller owns the merge).
 * @throws {WorkBuddySettingsWriteError} when neither writer persists the value.
 */
export async function writePoolPreferences(
  scope: WorkBuddyAccountScope,
  region: WorkBuddyWebRegion,
  preferences: {
    enabled: boolean
    targetModelId: string
    /**
     * Tokens each probe sends, or `undefined` to leave the host's default.
     *
     * Optional on purpose: a caller that never learnt about this setting must
     * not be forced to invent a number, and omitting it has to mean "default"
     * rather than "0 tokens".
     */
    probeInputTokens?: number
    memberAccountIds: readonly string[]
    /** Manual priority order for member accounts; always a real array. */
    orderAccountIds: readonly string[]
  },
): Promise<void> {
  // The merge starts from the EXISTING slot, read here rather than taken from
  // the caller: the pool is one field of a slot that also holds the model list,
  // so a caller that forgot to pass the rest would silently delete it. Reading
  // the snapshot here makes that impossible to get wrong.
  //
  // `probeInputTokens` is dropped when undefined rather than stored as such:
  // the slot is written to JSON, where a key present with `undefined` is not
  // representable, and `0` is already the host's "use the default" spelling.
  // Omitting the key therefore keeps the saved shape identical to a profile
  // written before the setting existed.
  const slot: Record<string, unknown> = {
    enabled: preferences.enabled,
    targetModelId: preferences.targetModelId,
    memberAccountIds: preferences.memberAccountIds,
    orderAccountIds: preferences.orderAccountIds,
  }
  if (preferences.probeInputTokens !== undefined) {
    slot['probeInputTokens'] = preferences.probeInputTokens
  }
  const merged = nextRegionPool(scope.getSnapshot().value, region, slot)
  const next = merged[region] as Record<string, unknown>
  await writeField(scope, 'regions', region, next, readBack => {
    const pool = (readBack as { pool?: Record<string, unknown> } | null | undefined)?.pool
    if (pool === undefined || pool === null) return false
    // Compare every field: the caller discards the draft on success, so a
    // partially-landed write must NOT read as success.
    if (pool['enabled'] !== preferences.enabled
      || pool['targetModelId'] !== preferences.targetModelId) {
      return false
    }
    // The host normalises an unset size to `0`, so an undefined request must be
    // verified against either spelling — requiring exactly `undefined` would
    // report a landed write as failed and leave the draft on screen.
    const wantedTokens = preferences.probeInputTokens ?? 0
    const storedTokens = pool['probeInputTokens'] ?? 0
    if (storedTokens !== wantedTokens) return false
    // Membership is compared as a SET: the stored order is not meaningful, and
    // an order-sensitive check would report a failed save for a write that
    // landed correctly — which, because success is what discards the draft,
    // would make the user's selection look like it never saved.
    const stored = pool['memberAccountIds']
    if (!Array.isArray(stored) || stored.length !== preferences.memberAccountIds.length) return false
    const wanted = new Set(preferences.memberAccountIds)
    if (!stored.every(id => typeof id === 'string' && wanted.has(id))) return false
    // Order is compared POSITIONALLY, unlike membership above. Ordering is
    // order-sensitive: a set comparison would call a partially-applied write a
    // success — and since success is what discards the draft, the user would
    // see "I sorted it but it didn't save".
    const storedOrder = pool['orderAccountIds']
    if (!Array.isArray(storedOrder) || storedOrder.length !== preferences.orderAccountIds.length) return false
    if (!storedOrder.every((id, index) => id === preferences.orderAccountIds[index])) return false
    // Everything compared above matched. Returning `undefined` here (which is
    // what a trailing `if` without a final `return` would do) reads as "did not
    // land" and would leave the draft on screen after a successful save.
    return true
  })
}
