/**
 * The HOST's model picker label: the catalog name, the upstream's promotion
 * badge, and the load-level icon.
 *
 * WHY A SLOT. The host renders the model name as a plain string, so the only
 * thing a provider can put there is a character — and a character's colour is
 * the emoji font's business, not ours. The host therefore offers exactly one
 * seam for this: the `conversation.input.model.label` slot, whose contract is
 * "render non-interactive inline content such as a coloured name or badge"
 * while the picker keeps owning clicks, focus, check marks and the accessibility
 * text. The shipped example is the official DeepSeek "1017" release badge — a
 * coloured marker next to a model name — which is the same job.
 *
 * WHY THE BADGE BELONGS HERE AT ALL. The picker is where the choice is made,
 * and a time-boxed promotion is a choice criterion: "free until the 25th" and
 * "half price at night" both change which row you click. The card already drew
 * these badges, but the card is the settings surface — by the time you read
 * them there you have already picked. The badge is not decoration added here;
 * it is the same upstream fact, moved to the place where it can still change a
 * decision.
 *
 * WHY A SEPARATE FETCH. The slot is rendered by the host, outside the plugin's
 * card, so it cannot read the card's React state. It therefore asks the Host
 * for the snapshot itself — and asks for the SAME route the card polls
 * (`WORKBUDDY_USAGE_PATH`), which carries both the load levels and each model's
 * unresolved promotions. One request, both facts. The answer is cached briefly:
 * a picker that re-fetched on every re-render would be wasteful, and a level
 * that is a few seconds old is still true.
 *
 * WHY THE CLOCK IS RE-READ ON EVERY RENDER. A promotion's badge is a function
 * of the clock (a night window opens and closes; a campaign expires). Resolving
 * it once at fetch time and holding it would leave "夜间折扣" on the composer
 * button the next morning — the exact overstatement `src/promo.ts` refuses to
 * make. The snapshot is therefore fetched once and the BADGE is resolved at
 * render time; a shared one-minute ticker re-renders the mounted labels so a
 * window edge is picked up without one timer per model row.
 *
 * WHY THE HOST STILL OWNS THE NAME. The contract says to keep `model.name` as
 * the text and render the addition beside it, so this component returns the
 * name first — it never replaces it, and it renders nothing at all for a
 * provider that is not ours.
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { busyIcon } from './busy-icon.tsx'
import type { WorkBuddyBusyLevel } from '../busy.ts'
import type { WorkBuddyPromo } from '../promo.ts'
import { selectPromoBadge, selectPromoMultiplier } from '../promo.ts'
import { promoBadgeColor, promoBadgeLabel, promoBadgeShortLabel, promoBadgeTooltip, uiLanguage } from './promo-badge.ts'
import { withWorkBuddyRegion, WORKBUDDY_USAGE_PATH } from '../status-paths.ts'
import type { WorkBuddyWebModel, WorkBuddyWebRegion } from '../status-paths.ts'

/** The provider ids this plugin registers, and the region each one serves. */
const PROVIDER_REGIONS: ReadonlyMap<string, WorkBuddyWebRegion> = new Map([
  ['workbuddy', 'cn'],
  ['workbuddy-global', 'global'],
])

/**
 * The region a provider id serves, or `undefined` for a provider that is not
 * this plugin's.
 *
 * Exported because the mapping is the part that can be silently wrong: asking
 * the Host without the region answers for the DEFAULT region, which would put
 * one gateway's load on the other gateway's models.
 */
export function regionOfProvider(providerId: string): WorkBuddyWebRegion | undefined {
  return PROVIDER_REGIONS.get(providerId)
}

/** How long a fetched snapshot is trusted, in milliseconds. */
const CACHE_MS = 60_000

/** How often a mounted label re-reads the clock, in milliseconds. */
const TICK_MS = 60_000

/**
 * The two facts one label needs, as read from the Host.
 *
 * Both ride on the SAME usage response: `busyLevels` is per region, and each
 * model carries its own `promos` UNRESOLVED — the badge is resolved against the
 * clock by the renderer, not by the Host.
 */
interface StatusSnapshot {
  levels: Readonly<Record<string, WorkBuddyBusyLevel>>
  promos: Readonly<Record<string, readonly WorkBuddyPromo[]>>
  /** Each model's catalog multiplier, so the label can show the discounted
   *  price while a discount runs (issue #120). */
  rates: Readonly<Record<string, number>>
}

/** The snapshot per region, plus when it was read. */
const caches = new Map<WorkBuddyWebRegion, { snapshot: StatusSnapshot, at: number }>()

/**
 * The snapshot, read from the Host once and reused briefly.
 *
 * `undefined` means "not known" — the caller renders nothing rather than
 * guessing, because a badge that claims a level or a promotion the upstream
 * never stated is worse than no badge.
 */
async function statusNow(region: WorkBuddyWebRegion): Promise<StatusSnapshot | undefined> {
  const cached = caches.get(region)
  if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.snapshot
  try {
    // The answer is per REGION: the two gateways are separate catalogs with
    // separate load and separate promotions, so asking without the region
    // would show one region's facts on the other's models.
    const response = await fetch(withWorkBuddyRegion(WORKBUDDY_USAGE_PATH, region), {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    const body = await response.json() as {
      busyLevels?: Record<string, WorkBuddyBusyLevel>
      models?: readonly WorkBuddyWebModel[]
    }
    // Missing levels are an empty set, not an error: the promotions often ride
    // along on a response whose probe has not run, and losing them because the
    // probe is cold would be a second, unrelated failure.
    const promos: Record<string, readonly WorkBuddyPromo[]> = {}
    const rates: Record<string, number> = {}
    for (const model of body.models ?? []) {
      if (model.creditMultiplier !== undefined) rates[model.id] = model.creditMultiplier
      if (model.promos !== undefined) promos[model.id] = model.promos
    }
    const snapshot: StatusSnapshot = { levels: body.busyLevels ?? {}, promos, rates }
    caches.set(region, { snapshot, at: Date.now() })
    return snapshot
  } catch {
    // The Host is unreachable or refused: no badge. Never a made-up one.
    return undefined
  }
}

/** Forget the cached snapshots; used by the tests. */
export function resetBusyLevelCache(): void {
  caches.clear()
}

/** One shared minute ticker, so N mounted labels cost one timer, not N. */
const minuteTicker: { timer: ReturnType<typeof setInterval> | undefined, listeners: Set<() => void> } = {
  timer: undefined,
  listeners: new Set(),
}

/**
 * Re-render the caller once a minute while it is mounted.
 *
 * @param listener - The callback to run at each tick.
 * @returns The unsubscribe function, which stops the shared timer when the last
 *          listener leaves.
 */
function subscribeMinute(listener: () => void): () => void {
  minuteTicker.listeners.add(listener)
  if (minuteTicker.timer === undefined) {
    minuteTicker.timer = setInterval(() => {
      for (const each of [...minuteTicker.listeners]) each()
    }, TICK_MS)
    // A pending interval keeps the Node event loop alive. This one exists for
    // the UI, so it must never be the reason a test run or a CLI command hangs.
    const handle = minuteTicker.timer as unknown as { unref?: () => void }
    handle.unref?.()
  }
  return () => {
    minuteTicker.listeners.delete(listener)
    if (minuteTicker.listeners.size === 0 && minuteTicker.timer !== undefined) {
      clearInterval(minuteTicker.timer)
      minuteTicker.timer = undefined
    }
  }
}

/**
 * The upstream's promotion badge, as the picker draws it.
 *
 * Reuses the card's chip class so the two surfaces cannot drift apart, and adds
 * one modifier for the two things a menu row changes: the chip must fit a row
 * that is one line wide (see `.dsm-workbuddy-model-label-promo` in the card's
 * stylesheet), and it is the only place the full tooltip is available.
 *
 * @param props - The resolved promotion, and whether space is tight.
 * @returns The chip.
 */
function PromoBadge(props: { promo: WorkBuddyPromo, compact: boolean }): ReactElement {
  const { promo, compact } = props
  const language = uiLanguage()
  const label = compact ? promoBadgeShortLabel(promo, language) : promoBadgeLabel(promo, language)
  const color = promoBadgeColor(promo)
  const tooltip = promoBadgeTooltip(promo, language)
  // A custom property cannot be written as an object literal in React's
  // `CSSProperties` type, so the style is built as a plain record first.
  const style: Record<string, string> | undefined = color === undefined
    ? undefined
    : { '--dsm-workbuddy-promo-color': color }
  return (
    <span
      className="dsm-workbuddy-model-promo dsm-workbuddy-model-label-promo"
      title={tooltip === '' ? undefined : tooltip}
      style={style}
    >
      <span className="dsm-workbuddy-model-label-promo-text">{label}</span>
    </span>
  )
}

/**
 * The label for one model row in the host's picker.
 *
 * @param props - The host's model identity and the placement of this label.
 * @returns The catalog name, the promotion chip when one holds, and the load
 *          badge when the probe reported one.
 */
export function WorkBuddyModelLabel(props: {
  provider: { id: string, name: string }
  model: { id: string, name: string }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
}): ReactElement {
  const { provider, model, placement } = props
  const region = regionOfProvider(provider.id)
  if (region === undefined) {
    // Another provider's model: the host renders the plain name.
    return <span>{model.name}</span>
  }
  return <WorkBuddyModelLabelInner
    modelId={model.id}
    name={model.name}
    region={region}
    compact={placement !== 'trigger'}
  />
}

/** The stateful half: fetches the snapshot, then renders what holds right now. */
function WorkBuddyModelLabelInner(props: {
  modelId: string
  name: string
  region: WorkBuddyWebRegion
  compact: boolean
}): ReactElement {
  const { modelId, name, region, compact } = props
  const [snapshot, setSnapshot] = useState<StatusSnapshot | undefined>(undefined)
  const [, setTick] = useState(0)

  useEffect(() => {
    let live = true
    void statusNow(region).then(next => {
      // Superseded while in flight: a newer answer must not be overwritten by
      // an older one.
      if (!live || next === undefined) return
      setSnapshot(next)
    })
    return () => { live = false }
  }, [modelId, region])

  // The clock is an input to the badge, so the component has to re-read it
  // while it is mounted. One shared timer for every label keeps an open menu
  // with twenty rows from starting twenty intervals.
  useEffect(() => subscribeMinute(() => setTick(count => count + 1)), [])

  const level = snapshot?.levels[modelId]
  // Resolved against NOW, not against the fetch: a night window that opened
  // after this snapshot was cached still shows, and one that closed stops.
  const promo = snapshot === undefined ? undefined : selectPromoBadge(snapshot.promos[modelId], Date.now())

  // Same clock as the badge: a standing "night discount" entry outside its
  // hours must not change the price (issue #120).
  const discounted = snapshot === undefined ? undefined : selectPromoMultiplier(snapshot.promos[modelId], Date.now())

  // The host's `model.name` ALREADY ends in the catalog multiplier
  // (`DeepSeek-V4.1-Flash · x0.11` — see `workBuddyDisplayName`), so appending
  // another rate would print the figure twice (observed in the picker). The
  // catalog figure is therefore STRIPPED from the name and drawn separately,
  // and the discounted one takes its place: always exactly one number, and it
  // is the one that holds right now.
  const { base, rate } = splitCatalogRate(name, snapshot?.rates[modelId], discounted)

  return (
    <span className="dsm-workbuddy-model-label">
      <span>{base}</span>
      {rate === undefined ? null : <span className="dsm-workbuddy-model-label-rate"> · x{rate.toFixed(2)}</span>}
      {promo === undefined ? null : <PromoBadge promo={promo} compact={compact} />}
      {level === undefined ? null : busyIcon(level, 'zh')}
    </span>
  )
}

/**
 * Split the host's display name into "name" and "the multiplier to show".
 *
 * `workBuddyDisplayName` builds `"<name> · x<multiplier>"` and the host renders
 * that string verbatim, so appending another rate next to it printed the figure
 * twice in the picker (`DeepSeek-V4.1-Flash · x0.11 · x0.11`). The suffix is
 * therefore pulled back OUT of the string and re-drawn in the span that can
 * carry the discounted value — exactly one number, and it is the one that holds
 * right now.
 *
 * The suffix is recognised by SHAPE, not by comparing against the snapshot's
 * `baseRate`: the two can disagree (a promotion can change the catalog figure
 * between the snapshot and this render), and leaving the suffix in place then
 * prints two numbers again — the very defect this function removes.
 *
 * @param name - The host's rendered name, possibly ending in ` · x<rate>`.
 * @param baseRate - The catalog multiplier, as the snapshot reports it.
 * @param discounted - The rate to show instead, when a discount is running.
 * @returns The name without its rate suffix, and the single rate to draw.
 *          `undefined` means "draw no number" (the name had none and no
 *          discount is running).
 */
export function splitCatalogRate(
  name: string,
  baseRate: number | undefined,
  discounted: number | undefined,
): { base: string, rate: number | undefined } {
  const match = / · x(\d+(?:\.\d+)?)$/.exec(name)
  const fromName = match === null ? undefined : Number(match[1])
  const base = match === null ? name : name.slice(0, match.index)
  // The discount wins; otherwise keep the number the name carried; otherwise
  // fall back to the snapshot (a name with no suffix still gets its rate).
  const rate = discounted ?? fromName ?? baseRate
  return { base, rate }
}

