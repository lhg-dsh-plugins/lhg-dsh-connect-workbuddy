import { describe, expect, it } from 'vitest'
import { mergePoolProbe } from '../src/account-pool-store.ts'
import { probeUpdatesOf, testAllAccounts } from '../src/account-pool-run.ts'
import { resolveTargetModel } from '../src/account-pool.ts'
import type { WorkBuddyPoolTarget } from '../src/account-pool-run.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'

/**
 * Issue #61: the pool's test button probes ONE model — the region's
 * `targetModelId` — and the row it produces reads as account-level
 * availability. But `6004` is an ACCOUNT × MODEL condition: the reporter
 * measured two accounts where `hy4-preview-f` answered while `step-5-preview`
 * returned `429 / 6004` in the same second, with the panel showing both as
 * 可用. "The panel says available, then the chat hits a wall."
 *
 * WHAT REMAINS after the maintainer removed the per-account half in 4.5.3:
 *   1. a probe record carries the MODEL it measured, so every verdict states its
 *      own scope. This needed no new setting, and it is what makes the old false
 *      positive explicable on sight rather than by re-running experiments;
 *   2. ONE model per batch, resolved from the region's own `targetModelId`
 *      through `resolveTargetModel`, so a stale target is REPORTED and never
 *      silently swapped for one the user did not choose;
 *   3. the measurement is written by the probe that produced it and is never
 *      inherited by a later write that does not know it.
 *
 * WHAT WAS REMOVED, and this file keeps the reason next to the assertion: a
 * per-account test model (`targetModelIdByAccount`) was adopted from the
 * reporter's proposal in 4.4.6 and removed by the maintainer's decision. The
 * region ALREADY had one test-model setting, and pointing it at the model you
 * actually chat with is the whole of the report's ask. Letting each row test a
 * DIFFERENT model makes a green batch UNCOMPARABLE — one account's `ok` on model
 * X and another's on model Y — which is the very reading ("all green") the
 * report warned against. Hence "one model for the batch" is asserted below, not
 * merely assumed.
 */

const CATALOG = [
  // `creditMultiplier: 0` is what makes a model the FREE fallback; without it the
  // region resolves to `none` and the assertions below would be about that
  // instead of about the preference path.
  { id: 'hy4-preview-f', name: 'hy4', contextWindow: 1_000_000, maxTokens: 8_192, creditMultiplier: 0 },
  { id: 'step-5-preview', name: 'step5', contextWindow: 1_000_000, maxTokens: 8_192, creditMultiplier: 1 },
] as unknown as readonly WorkBuddyModelInfo[]

/** A runner whose probe RECORDS the model it was handed. */
function runner(probed: string[]) {
  return {
    credentialFor: async (accountId: string) => ({ accountId }) as never,
    fetchCheckinStatus: async () => ({}) as never,
    claimDailyCheckin: async () => ({ credit: 0, streakDays: 0 }),
    probe: async (_credential: unknown, modelId: string) => {
      probed.push(modelId)
      return { modelId, outcome: 'ok' as const }
    },
    wait: async () => {},
  }
}

const targets: WorkBuddyPoolTarget[] = [
  { accountId: 'a', accountName: 'Alpha' },
  { accountId: 'b', accountName: 'Beta' },
]

describe('the region target model resolves through one gate', () => {
  it('uses the saved target when the catalog still offers it', () => {
    const target = resolveTargetModel(CATALOG, 'step-5-preview')
    expect(target.modelId).toBe('step-5-preview')
    expect(target.source).toBe('preferred')
  })

  it('REPORTS a stale target instead of substituting another model', () => {
    // The refusal that matters: a saved target pointing at a model this region
    // no longer offers must NOT become "test some other model instead" — that
    // spends credits on a model nobody chose and files it as this account's
    // verdict.
    const target = resolveTargetModel(CATALOG, 'ghost-model')
    expect(target.staleModelId).toBe('ghost-model')
    expect(target.source).toBe('stale')
    expect(target.modelId).toBeUndefined()
  })

  it('falls back to a free model only when nothing was chosen', () => {
    // 'free' rather than 'none' — and the distinction is load-bearing: 'none'
    // means "this region offers no zero-multiplier model", which the card shows
    // as a different instruction than "you have not chosen one yet".
    const target = resolveTargetModel(CATALOG, undefined)
    expect(target.source).toBe('free')
    expect(target.modelId).toBeDefined()
  })

  it('says NONE when the region has no free model and nothing was chosen', () => {
    const paid = [{ id: 'paid-only', name: 'p', contextWindow: 1, maxTokens: 1, creditMultiplier: 1 }] as unknown as readonly WorkBuddyModelInfo[]
    expect(resolveTargetModel(paid, undefined)).toEqual({ source: 'none' })
  })
})

describe('the batch measures every member on ONE model', () => {
  it('probes every account on the SAME model, whatever it is', async () => {
    // The property that keeps a green batch comparable. If this ever becomes
    // per-account again, the pool table stops being invertible: "all green"
    // would no longer mean "every account serves the model you are about to
    // use", which is the only thing the user reads it as.
    const probed: string[] = []
    const rows = await testAllAccounts(targets, 'step-5-preview', runner(probed) as never)
    expect(probed).toEqual(['step-5-preview', 'step-5-preview'])
    expect(rows.map(row => row.result.modelId)).toEqual(['step-5-preview', 'step-5-preview'])
  })

  it('takes ONE model for the whole batch — the shape every route passes', async () => {
    const rows = await testAllAccounts(targets, 'hy4-preview-f', runner([]) as never)
    expect(rows.map(row => row.result.modelId)).toEqual(['hy4-preview-f', 'hy4-preview-f'])
    expect(rows.map(row => row.accountId)).toEqual(['a', 'b'])
  })
})

describe('the record says WHICH model it measured', () => {
  it('is written by the batch from the probe that produced it', () => {
    const updates = probeUpdatesOf([{
      accountId: 'a',
      accountName: 'Alpha',
      result: { modelId: 'step-5-preview', outcome: 'rate-limited' },
    }])
    expect(updates['a']?.modelId).toBe('step-5-preview')
  })

  it('is NOT inherited when a later write does not know it', () => {
    // The deliberate contrast with `accountName`/`retryAtMs`. Those describe the
    // ACCOUNT — a name a later writer could not see is still true, and a future
    // refresh time is still future — while the model describes THIS
    // measurement. Carrying an older id forward would relabel a fresh
    // measurement with a model it was not taken on, which is the exact
    // confusion the field exists to end.
    const merged = mergePoolProbe(
      { outcome: 'ok', atMs: 1_000, modelId: 'hy4-preview-f', accountName: 'Alpha' },
      { outcome: 'rate-limited', atMs: 2_000, message: 'quota' },
    )
    expect(merged.modelId).toBeUndefined()
    // The neighbouring inherits still work, so this is not "merge stopped
    // merging".
    expect(merged.accountName).toBe('Alpha')
  })

  it('is overwritten by a newer measurement on a different model', () => {
    const merged = mergePoolProbe(
      { outcome: 'ok', atMs: 1_000, modelId: 'hy4-preview-f' },
      { outcome: 'rate-limited', atMs: 2_000, modelId: 'step-5-preview' },
    )
    expect(merged.modelId).toBe('step-5-preview')
  })
})
