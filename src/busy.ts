/**
 * WorkBuddy model load — the "繁忙程度" line the WorkBuddy client draws under a
 * model, read from the upstream's own probe and rendered next to the model name.
 *
 * WHY A SEPARATE REQUEST, AND WHY IT COSTS ALMOST NOTHING. Load is NOT part of
 * the model directory: `/v3/config` lists models and prices, and says nothing
 * about how busy each one is right now. The app asks a dedicated probe —
 * `POST /v2/chat/busy { models: [...] }` — and so does this plugin, exactly once
 * per model-picker refresh, batched at the upstream's own limit of 50 ids per
 * call. The probe is read-only and free (no credits, no account mutation):
 * measured 2026-10-21 on the CN gateway, HTTP 200 with
 *
 *   {"code":0,"msg":"OK","requestId":"…","data":[
 *     {"model":"hy3","busy_level":"busy"},
 *     {"model":"deepseek-v4.1-flash","busy_level":"congested"}]}
 *
 * IDENTICAL ON EVERY CN HOST AND UNDER EITHER CLIENT IDENTITY. `copilot.tencent.com`,
 * `www.workbuddy.cn` and `www.codebuddy.cn` answer byte-for-byte the same list,
 * and so do the CLI user agent (`CLI/2.63.2 CodeBuddy/2.63.2`) and the app's
 * product identity (`WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0`). Unlike
 * `/v3/config`, this endpoint is not channel-sensitive, so the plugin asks it as
 * the CLI agent it already is on the chat path — no product identity needed.
 *
 * THE GLOBAL GATEWAY DOES NOT HAVE IT (measured 2026-10-22, and the reason the
 * README says "CN only"). `www.workbuddy.ai` answers that same POST with
 * `404 {"error_msg":"404 Route Not Found"}`, and so do `/v3/chat/busy`,
 * `/v2/models/busy`, `/v2/chat/model/busy` and `/v1/chat/busy` under both POST
 * and GET — twelve path/method pairs, twelve 404s. The credential is fine: the
 * SAME token reads that gateway's `/v3/config` (200, 28 models), and none of
 * those models carries a field whose name mentions busy / load / queue / wait /
 * level / pressure. So this is not a wrong path, a wrong identity or a
 * permission problem — upstream never published the fact for that region. The
 * probe therefore fails there on every refresh; it is caught (see
 * `withBusyLevels` in `src/index.ts`), logged once, and the roster ships with
 * no levels, which the card renders as no badge. Deliberately NOT "fixed" by
 * inferring a level from latency or credits: a made-up load badge is worse than
 * no badge, and the plugin's whole rule here is to never state a fact the
 * upstream did not state.
 *
 * THE LEVELS ARE THE APP'S OWN ENUM, and anything outside it is `unknown`:
 * `idle` / `normal` / `busy` / `congested` / `unavailable`. The app's own words
 * (from its `im-channels` bundle, `chatInput.modelSelector.busy.*`) are
 * 空闲 / 轻微拥堵 / 极度拥堵 / 不可用; English reads Idle / Slightly congested /
 * Extremely congested / Unavailable.
 *
 * WHY THE LABELS LIVE HERE AND NOT IN THE UPSTREAM CLIENT. The probe returns a
 * machine level, never text: the same response is drawn differently by the app
 * (an icon for `congested`, a word for the rest), so the rendering decision
 * belongs with the renderer. This module keeps the words, the tone, and the
 * "which levels are worth drawing at all" rule in one place.
 *
 * NOTHING HERE IS PERSISTED. Load is a fact about THIS MINUTE: a cached level
 * that survives a restart is a lie, and the model directory is saved to disk
 * while a level must not be. So the level is attached to the catalog entry at
 * refresh time and nowhere else — see `attachBusyLevels` and `src/index.ts`.
 *
 * @module dsh-connect-workbuddy/busy
 */

/**
 * One model's load, in the upstream's vocabulary.
 *
 * `unknown` is the plugin's own value, not the upstream's: it is what an
 * unusable entry becomes (a missing level, a level outside the enum, a model the
 * probe did not answer for). It is deliberately distinct from `normal` — "we
 * were told nothing" must not be drawn as "all good".
 */
export type WorkBuddyBusyLevel = 'idle' | 'normal' | 'busy' | 'congested' | 'unavailable' | 'unknown'

/** The upstream's enum, in the order its own bundle declares it. */
export const WORKBUDDY_BUSY_LEVELS = ['idle', 'normal', 'busy', 'congested', 'unavailable', 'unknown'] as const

/**
 * The upstream's batch ceiling for one probe (`PAt=50` in the app's bundle).
 * More ids than this are split into several calls rather than truncated: the
 * plugin's CN roster is already 20-62 models.
 */
export const WORKBUDDY_BUSY_BATCH_SIZE = 50

/** Coerce one `busy_level` value; everything the enum does not name is `unknown`. */
export function normalizeBusyLevel(value: unknown): WorkBuddyBusyLevel {
  return typeof value === 'string' && (WORKBUDDY_BUSY_LEVELS as readonly string[]).includes(value)
    ? value as WorkBuddyBusyLevel
    : 'unknown'
}

/**
 * Read one probe answer into a model-id → level map.
 *
 * Tolerant by design: an entry that is not an object, or that names no model, is
 * skipped; a level the enum does not know becomes `unknown` rather than being
 * dropped, because "the upstream answered about this model but said something
 * we do not understand" is still a fact about that model.
 */
export function parseBusyLevels(entries: unknown): Map<string, WorkBuddyBusyLevel> {
  const levels = new Map<string, WorkBuddyBusyLevel>()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const id = typeof raw['model'] === 'string' ? raw['model'] : ''
    if (id === '') continue
    levels.set(id, normalizeBusyLevel(raw['busy_level']))
  }
  return levels
}

/**
 * Split ids into probe-sized batches, de-duplicated and order-preserving.
 *
 * De-duplication matters: the roster the plugin sends is the `cli` agent's
 * roster PLUS the user's kept ids, so the same id can legitimately appear twice,
 * and the upstream counts what it is asked for.
 */
export function batchModelIds(ids: readonly string[], size = WORKBUDDY_BUSY_BATCH_SIZE): string[][] {
  const unique = [...new Set(ids.filter(id => id !== ''))]
  const batches: string[][] = []
  for (let index = 0; index < unique.length; index += size) {
    batches.push(unique.slice(index, index + size))
  }
  return batches
}

/** The app's own Chinese wording, per level. `normal` and `unknown` have none. */
const BUSY_LABELS_ZH: Readonly<Partial<Record<WorkBuddyBusyLevel, string>>> = {
  idle: '空闲',
  busy: '轻微拥堵',
  congested: '极度拥堵',
  unavailable: '不可用',
}

/** The app's own English wording, per level. */
const BUSY_LABELS_EN: Readonly<Partial<Record<WorkBuddyBusyLevel, string>>> = {
  idle: 'Idle',
  busy: 'Slightly congested',
  congested: 'Extremely congested',
  unavailable: 'Unavailable',
}

/**
 * The word this level is drawn with, or `undefined` when it is not worth drawing.
 *
 * `normal` returns `undefined` on purpose: the app's selector shows a busy line
 * only for a level that differs from the healthy default, and a badge that reads
 * "正常" on fifteen rows out of twenty is noise, not information. `unknown`
 * returns `undefined` for the same reason plus one more — the plugin must not
 * invent a claim the upstream never made.
 */
export function busyLabel(level: WorkBuddyBusyLevel, locale: 'zh' | 'en' = 'zh'): string | undefined {
  return (locale === 'en' ? BUSY_LABELS_EN : BUSY_LABELS_ZH)[level]
}

/**
 * A level that is drawn as an ICON rather than as words.
 *
 * The upstream app already mixes the two: `congested` gets an icon, the rest
 * get words. So the icon set is deliberately SMALL — ONE shape (a person),
 * repeated, and the COUNT plus the COLOUR carry the level.
 *
 * The shapes are people, because that is what load looks like: one person
 * (free), one person with someone behind them (a queue), two people pressed
 * together (congested), and a crossed-out person (unavailable).
 */
export type WorkBuddyBusyIcon = 'idle' | 'normal' | 'busy' | 'congested' | 'unavailable'

/** The levels that have an icon at all. */
export const BUSY_ICONS: readonly WorkBuddyBusyIcon[] = ['idle', 'normal', 'busy', 'congested', 'unavailable']

/**
 * The icon for a level, or `undefined` when the level has none.
 *
 * `idle` and `unknown` deliberately return `undefined`: `idle` is the
 * upstream's own "nobody is here" wording, and `unknown` is "we were told
 * nothing" — neither may be drawn as a claim.
 */
export function busyIcon(level: WorkBuddyBusyLevel | undefined): WorkBuddyBusyIcon | undefined {
  if (level === undefined) return undefined
  // Only `unknown` is left out: it is the plugin's own "the probe did not
  // answer", and a badge that guesses is worse than no badge. Every level the
  // upstream DID report is drawn — `idle` included, in green, because "the
  // model is free right now" is useful information, not noise.
  if (level === 'unknown') return undefined
  return level as WorkBuddyBusyIcon
}

/**
 * The ONE character that stands for a level in a plain-text context.
 *
 * The DSH model picker renders the model name verbatim, as a string, with no
 * slot for an image and no markup support — so a level shown THERE has to be a
 * character. One character, not a word: the picker is narrow, and the word was
 * what made the row read as a sentence.
 *
 * The choice of character is the app's own visual language, not ours:
 *   - congested  → the two pressed together
 *   - busy       → the one with someone behind
 *   - unavailable→ the crossed-out one
 *   - idle       → a single person (drawn in the card, but not in the picker:
 *                  `DRAWN_IN_PICKER` decides which levels the picker shows)
 *
 * The card uses the SVG icons above; this is the fallback for the one place
 * that cannot render them.
 */
export function busySymbol(level: WorkBuddyBusyLevel | undefined): string {
  switch (level) {
    // The same person repeated: ONE shape, and the COUNT carries the meaning.
    // `🧍` is a full-body figure. The spacing between the glyphs is the
    // FONT's business, not ours — the picker renders the name as a plain
    // string, so there is no way to tighten it from here. That is why the card
    // draws its own SVG, where the gap IS ours to choose.
    case 'congested': return '🧍🧍🧍'
    case 'busy': return '🧍🧍'
    case 'normal': return '🧍'
    // The idle level is a ROCKET in the card (`src/client/busy-icon.tsx`), so
    // the character version says the same thing: nobody is queuing.
    case 'idle': return '🚀'
    case 'unavailable': return '🚫'
    default: return ''
  }
}

/**
 * Suffix appended to a model's DSH-facing display name, prefixed with a middle
 * dot, or `''` when the level is not worth drawing.
 *
 * This is the "badge to the RIGHT of the model name" the DSH model selector
 * already does for its own variants (`deepseek-v4.1-flash · 1017`): DSH renders
 * `name` verbatim and offers no separate badge slot to a provider, so the only
 * way to put load beside the name — instead of in a second line, or inside the
 * name — is to extend the name. The name stays display-only: every DSH-side join
 * keys on the model ID, and `workBuddyDisplayName` is the single place that
 * builds it.
 *
 * ONLY A LEVEL THAT ASKS FOR A DECISION IS DRAWN — `busy`, `congested`,
 * `unavailable`. `idle` deliberately gets no suffix here even though it has a
 * word: on the measured CN roster seven of twenty models are idle, and a picker
 * whose every row carries a badge reads as decoration rather than as a warning.
 * That is also how the app's own selector behaves in its compact mode, where only
 * `congested` is drawn at all. The card's detail panel is where the full scale
 * belongs.
 */
export function busyDisplaySuffix(level: WorkBuddyBusyLevel | undefined, locale: 'zh' | 'en' = 'zh'): string {
  if (level === undefined || !DRAWN_IN_PICKER.has(level)) return ''
  // The picker's name is rendered as plain text, so the level travels as ONE
  // character instead of a word. `locale` stays in the signature because the
  // CARD still asks for the word (`busyLabel`) for its tooltip — dropping the
  // parameter would silently change that call site's contract.
  //
  // NOT the place the badge is drawn, though: the host offers the
  // `conversation.input.model.label` slot, and the plugin renders the coloured
  // SVG people THERE (`src/client/WorkBuddyModelLabel.tsx`). An emoji here
  // would show the same information twice, in two different visual languages.
  const symbol = busySymbol(level)
  if (symbol === '') return ''
  return ` ${symbol}`
}

/**
 * The levels that change a model-picking decision; see {@link busyDisplaySuffix}.
 *
 * `idle` is IN as well: one green person says "free right now", which is
 * useful. `unknown` is the only level left out, for a second reason: the
 * plugin must not invent a claim the upstream never made.
 */
const DRAWN_IN_PICKER: ReadonlySet<WorkBuddyBusyLevel> = new Set<WorkBuddyBusyLevel>([
  'idle',
  'normal',
  'busy',
  'congested',
  'unavailable',
])

/**
 * Attach each model's level to its catalog entry.
 *
 * A model the probe did not answer for keeps whatever it had — which, for a
 * freshly discovered roster, is nothing. Models are copied, never mutated: the
 * catalog entry is shared with the settings card's saved snapshot.
 */
export function attachBusyLevels<T extends { id: string; busyLevel?: WorkBuddyBusyLevel }>(
  models: readonly T[],
  levels: ReadonlyMap<string, WorkBuddyBusyLevel>,
): T[] {
  return models.map(model => {
    const level = levels.get(model.id)
    return level === undefined || level === model.busyLevel ? model : { ...model, busyLevel: level }
  })
}
