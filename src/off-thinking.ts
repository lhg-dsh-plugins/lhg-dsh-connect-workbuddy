/**
 * Which models can actually turn thinking OFF.
 *
 * The upstream catalog declares `reasoning.canDisableThinking`, and for ten
 * models that declaration is WRONG: they answer HTTP 400 to
 * `reasoning_effort: "off"` (issue #34). The refusal does not name the
 * parameter (`extError.param` is empty), and because the level is part of the
 * saved per-model selection, the failure repeats on EVERY later request until
 * the user picks another level — so it reads as "this model is broken" rather
 * than "this one setting is invalid".
 *
 * Measured on 3.4.4 across both gateways (`workbuddy.ai` and `codebuddy.cn`):
 * 18 accept `off` and 10 refuse it (9 unique ids, listed in
 * {@link REFUSES_OFF_MODEL_IDS}), and every OTHER effort value
 * (`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) plus omitting the field
 * entirely returns HTTP 200 on all of them. `off` is the only level that fails.
 *
 * This is the same shape of defect, and the same remedy, as
 * `src/native-modality.ts`: a reviewed table keyed by EXACT model id, because
 * no declared field separates the two groups. On the accepting side sit
 * GLM/Kimi/MiniMax plus `fast-model`/`balanced-model`/`auto`/`hy3`; on the
 * refusing side sit the DeepSeek-v4/GPT/Gemini frontier models plus
 * `primary-model`; and both sides declare identical capabilities.
 *
 * @module dsh-connect-workbuddy/off-thinking
 */

import type { WorkBuddyReasoning } from './upstream.ts'

/**
 * Ids observed to REFUSE `reasoning_effort: "off"` with HTTP 400 despite
 * declaring `canDisableThinking: true` (issue #34).
 *
 * Keyed by exact model id and deliberately NOT by region: `deepseek-v4.1-flash`
 * refuses on BOTH gateways, and the split tracks the model family rather than
 * the gateway. The cost is asymmetric — offering a level that always fails
 * costs the user every request for that model, while hiding one that would have
 * worked costs a single option — so the table errs towards hiding, and
 * {@link withEffectiveOff} enforces it as a HARD wall rather than a seed
 * (issue #83: a tick used to reopen the failing level, and with no
 * `reasoningEffort` passed the level became the default for compaction too).
 * See {@link offRefused} for why the checkbox must not win.
 *
 * `deepseek-v4-pro` was measured on the CN gateway only; it is listed because
 * its sibling does refuse on both, and the same asymmetry argues for hiding.
 */
export const REFUSES_OFF_MODEL_IDS: ReadonlySet<string> = new Set([
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'primary-model',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gemini-3.5-flash',
])

/** The two fields this rule needs; both are declared by the model itself. */
export interface WorkBuddyOffCapability {
  id: string
  reasoning?: WorkBuddyReasoning
}

/**
 * Whether `off` should be offered for a model when the user has expressed no
 * opinion: the upstream's declaration, minus the ids known to refuse it.
 *
 * Only an explicit `canDisableThinking: true` enables the level; absence is
 * "unknown" and stays unoffered, matching how the rest of the plugin treats an
 * undeclared capability.
 */
export function offDefaultFor(info: WorkBuddyOffCapability): boolean {
  return info.reasoning?.canDisableThinking === true && !REFUSES_OFF_MODEL_IDS.has(info.id)
}

/**
 * The model ids the `off` level should be offered for by default (issue #34).
 *
 * The user's checkbox is a plain set: ticked = offered, unticked = withdrawn.
 * This is the seed — what the set is filled with the first time it is read —
 * so a profile that has never saved shows the correct default immediately,
 * without requiring a save.
 *
 * Only an explicit `canDisableThinking: true` enables the level; absence is
 * "unknown" and stays unoffered, matching how the rest of the plugin treats an
 * undeclared capability.
 */
export function defaultOffModelIds(models: readonly WorkBuddyOffCapability[]): string[] {
  return models.filter(offDefaultFor).map(model => model.id)
}

/** One OBSERVED refusal of a reasoning tier, as the upstream reported it. */
export interface WorkBuddyRefusalReport {
  /** The rejected parameter (`extError.param`), e.g. `reasoning_effort`. */
  param: string
  /** The rejected value (`extError.value`), when the body carried one. */
  tier?: string
  /** Upstream business code, e.g. 11133. */
  code?: number
  /** Epoch milliseconds of the observation. */
  at: number
  /**
   * The model the refused REQUEST named — not the account's route alias.
   *
   * Taken from the body (`modelIdOfBody`), so it is the concrete id the card
   * lists; the badge would otherwise never attach, since failover re-points the
   * body at whatever the serving account routes.
   */
  modelId?: string
}

/** How many observations are kept, newest first. Bounded so a refusal storm cannot grow memory. */
const REFUSAL_RING = 20

/**
 * The refusals this process has observed, newest first.
 *
 * Process-scoped rather than persisted: it is EVIDENCE ("what did the upstream
 * actually say"), and a stale record from another install would promote a model
 * into the refusal table on the strength of a request the current build never
 * sent. The card reads it; nothing sends from it.
 */
const observedRefusals: WorkBuddyRefusalReport[] = []

/** Record one refusal, keeping the newest {@link REFUSAL_RING}. */
export function recordRefusal(report: WorkBuddyRefusalReport): void {
  observedRefusals.unshift(report)
  if (observedRefusals.length > REFUSAL_RING) observedRefusals.length = REFUSAL_RING
}

/** The refusals observed so far, newest first. Copied: callers cannot mutate the ring. */
export function recentRefusals(): readonly WorkBuddyRefusalReport[] {
  return [...observedRefusals]
}

/** The most recent refusal naming `modelId`, or `undefined` when none did. */
export function lastRefusalFor(modelId: string): WorkBuddyRefusalReport | undefined {
  return observedRefusals.find(report => report.modelId === modelId)
}

/** Clear the ring. Test-only ordering aid: production never calls it. */
export function forgetRefusals(): void {
  observedRefusals.length = 0
}

/**
 * Whether a model may offer `off` AT ALL, no matter what the user asked for.
 *
 * This is the hard wall in front of {@link REFUSES_OFF_MODEL_IDS} (issue #83).
 * The table above used to be a seed only: the checkbox wrote the selection
 * straight into `canDisableThinking`, so ticking a model known to refuse `off`
 * reopened exactly the failure the table exists to prevent — and not once per
 * "off" turn either. pi-ai's `openai-completions` reads
 * `model.thinkingLevelMap?.off` whenever the caller passes NO
 * `reasoningEffort` at all, and a compaction summary is such a caller: it never
 * carries an effort. So one tick made every `/compact` for that model answer
 * HTTP 400 / code 11133, with the surface showing only "could not produce a
 * useful summary".
 *
 * The asymmetry that writes the table also writes this test: a level that
 * always fails costs the user EVERY request for that model, while a level that
 * was hidden needlessly costs one option. So the refusal list wins over the
 * checkbox, not the other way round.
 *
 * The table is keyed by EXACT id, so anything that pins a different id at
 * request time (aliases such as `primary-model`) is out of its reach; those are
 * covered where the request is actually built — see
 * {@link normalizePreparedReasoning}.
 */
export function offRefused(modelId: string): boolean {
  return REFUSES_OFF_MODEL_IDS.has(modelId)
}

/**
 * Stamp the user's saved `off` selection onto a model list, for the RUNTIME
 * catalog.
 *
 * The runtime model descriptor is built by `workBuddyThinkingLevelMap`, which
 * reads only the model's own declaration — so the corrected answer has to be
 * written onto the model before it reaches the adapter. Doing it here keeps the
 * adapter a pure "declared capability in, level map out" function and keeps the
 * table next to the rule it feeds.
 *
 * This OVERWRITES the declared field rather than adding a sibling, which is
 * safe because the declared value has exactly one consumer (that same level
 * map) and is never persisted where the card can see it: `toWebModel` drops
 * `canDisableThinking`, and the card's `lastCatalog` is written from the raw
 * upstream discovery, never from this stamped list. A model that declares no
 * reasoning is returned untouched — there is no level to correct.
 *
 * A refusal-table id is stamped `false` REGARDLESS of the selection
 * ({@link offRefused}): the tick stays in the saved set — the card shows it and
 * the hint explains it — but it can no longer be turned into a request that
 * fails.
 */
export function withEffectiveOff<T extends WorkBuddyOffCapability>(
  models: readonly T[],
  selection: ReadonlySet<string>,
): T[] {
  return models.map(model => model.reasoning === undefined
    ? model
    : {
        ...model,
        reasoning: {
          ...model.reasoning,
          canDisableThinking: selection.has(model.id) && !offRefused(model.id),
        },
      } as T)
}
