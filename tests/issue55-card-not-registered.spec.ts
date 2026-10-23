/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import { WORKBUDDY_CARD_KEYS, WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES } from '../src/status-paths.ts'

/**
 * Regression suite for issue #55 — "插件设置界面没有设置项" (4.3.1+, reported on
 * 4.3.4).
 *
 * The shipped defect is a KEY MISMATCH with no error path:
 *
 * 1. The card registered into `plugins.bundle.config` / `plugins.row.config`
 *    under exactly ONE key — the bare package name, or (on the reported
 *    deployment) the `include:`-prefixed id. Those slots are KEYED, and the
 *    Plugins page renders them with `renderSlot('plugins.bundle.config', …,
 *    { entryKey: pkg.name })`, where `pkg.name` comes from the plugin-manager
 *    inventory. The comparison is exact equality on the PACKAGE NAME.
 * 2. The page also gates the whole section on `ledger.bundles.has(pkg.name)` —
 *    a Set of the registered `key` values. So a mismatch renders NOTHING: no
 *    section, no placeholder, no message.
 * 3. Registration itself was conditional on `configForms.whileServed` firing
 *    its unserved→served EDGE. When the settings mirror never reports our
 *    namespace, that edge never fires and `registerAllSlots()` never runs —
 *    and because the whole `apply` body is wrapped in a try/catch that only
 *    logs, the result is a silently empty page.
 *
 * We cannot import the real client entry (it pulls browser-only DSH client
 * packages), so — like `client-fallback.spec.ts` and
 * `issue46-namespace-binding.spec.tsx` — the `apply()` below MIRRORS
 * `src/client/index.tsx`. DRIFT WARNING: it is NOT the product code.
 */

/** A keyed-slot stub that behaves like `SlotCore`: one entry per (key, priority). */
function keyedSlots(): {
  register: (options: any, component: unknown) => () => void
  /** Keys currently registered on one slot, in registration order. */
  keysOf: (name: string) => string[]
  /** How many registrations were refused as duplicates. */
  duplicates: number
} {
  const cells = new Map<string, Map<string, unknown>>()
  let duplicates = 0
  return {
    register(options: any) {
      const cell = cells.get(options.name) ?? new Map<string, unknown>()
      cells.set(options.name, cell)
      const cellKey = `${String(options.key ?? options.id ?? '')}@${String(options.priority ?? 0)}`
      if (cell.has(cellKey)) {
        duplicates += 1
        throw new Error(`keyed slot "${options.name}" already has an entry for key "${String(options.key)}"`)
      }
      cell.set(cellKey, options)
      return () => { cell.delete(cellKey) }
    },
    keysOf(name: string) {
      return [...(cells.get(name)?.values() ?? [])].map((options: any) => String(options.key))
    },
    get duplicates() { return duplicates },
  }
}

/**
 * Mirror of the registration half of `src/client/index.tsx apply()`.
 *
 * Returns what the page would observe, so a test can tell a wrong key from a
 * missing registration: `bundles`/`rows` are the key sets the page builds its
 * ledger from, exactly as `configLedgerSource` does.
 */
function applyRegistration(ctx: any): {
  bundles: string[]
  rows: string[]
  /** Every `register()` call, in order, as `slot:key`. */
  calls: string[]
  /** Refusals the slot stub raised for a duplicate key at the same priority. */
  duplicates: number
  /** Whether the card registered without the settings namespace arriving. */
  registeredWithoutNamespace: boolean
} {
  const calls: string[] = []
  const slots = keyedSlots()

  let settingsScope: unknown
  const forms = ctx.get('configForms')

  const registerCard = (slotName: string, key: string): (() => void) | undefined => {
    try {
      return ctx.slots.inject(slotName, () => {
        calls.push(`${slotName}:${key}`)
        return slots.register({ name: slotName, key, priority: 30 }, {})
      })
    } catch {
      return undefined
    }
  }

  const registerAllSlots = (): Array<() => void> => [
    ...WORKBUDDY_CARD_KEYS.map(key => registerCard('plugins.bundle.config', key)),
    ...WORKBUDDY_CARD_KEYS.map(key => registerCard('plugins.row.config', `${key}#${key}`)),
  ].filter((disposer): disposer is () => void => disposer !== undefined)

    let liveDisposers: Array<() => void> = []

    /** Replace, never append — the second half of the #55 fix. */
    const rebind = (): void => {
      // Dispose FIRST, then register: the keyed slot refuses a key that is
      // still live, and each registration's own try/catch would turn that
      // refusal into a silently missing card.
      for (const dispose of liveDisposers) dispose()
      liveDisposers = []
      liveDisposers = registerAllSlots()
    }

    if (forms !== undefined && typeof forms.whileServed === 'function') {
      ctx.effect(() => forms.whileServed(
        WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES,
        (served: ReadonlySet<string>) => {
          const ns = WORKBUDDY_SETTINGS_NAMESPACE_CANDIDATES.find(candidate => served.has(candidate))
            ?? [...served].find((entry: string) => /workbuddy/i.test(entry))
          settingsScope = ns === undefined ? undefined : forms.get(ns)
          rebind()
          return () => {
            for (const dispose of liveDisposers) dispose()
            liveDisposers = []
          }
        },
      ), 'dsh-connect-workbuddy: settings namespace binding')
      // Register ANYWAY — the fix. Without it, a mirror that never reports the
      // namespace leaves `liveDisposers` empty and the page blank (issue #55).
      const registeredBefore = calls.length
      rebind()
      return {
        bundles: slots.keysOf('plugins.bundle.config'),
        rows: slots.keysOf('plugins.row.config'),
        calls,
        duplicates: slots.duplicates,
        registeredWithoutNamespace: calls.length > registeredBefore,
      }
    }
    rebind()
    void settingsScope
    return {
      bundles: slots.keysOf('plugins.bundle.config'),
      rows: slots.keysOf('plugins.row.config'),
      calls,
      duplicates: slots.duplicates,
      registeredWithoutNamespace: true,
    }
}

/** Client context whose `configForms` mirror holds a fixed namespace list. */
function contextWithMirror(namespaces: string[], record: (slot: string, key: string) => void): any {
  const state = { namespaces }
  return {
    get: (name: string) => name !== 'configForms' ? undefined : {
      describe: () => ({ getSnapshot: () => ({ view: { namespaces: state.namespaces.map(ns => ({ ns })) } }) }),
      get: (ns: string) => ({ ns, getSnapshot: () => ({ status: 'ready', value: {} }) }),
      whileServed: (watched: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        let off: (() => void) | undefined
        const sync = () => {
          const served = new Set(state.namespaces)
          const hit = watched.some(ns => served.has(ns))
          if (hit && off === undefined) off = register(served)
          else if (!hit && off !== undefined) { off(); off = undefined }
        }
        sync()
        return () => { off?.(); off = undefined }
      },
    },
    effect: (run: () => () => void) => { run() },
    locale: { register: () => () => {}, bind: () => () => '' },
    slots: {
      // `run()`'s result IS the disposer — the real `slots.inject` returns it,
      // and a stub that swallowed it would make every registration look
      // un-disposable, hiding the double-registration this suite is about.
      inject: (_name: string, run: () => any) => run(),
      register: (options: any) => {
        record(String(options.name), String(options.key))
        return () => {}
      },
    },
  }
}

/** A context whose slot registrations are recorded, as the real ledger would. */
function contextRecording(namespaces: string[]): any {
  return contextWithMirror(namespaces, () => {})
}

describe('issue #55: the card is registered under the name the page looks up', () => {
  it('registers the card under EVERY package-name spelling', () => {
    // The whole defect in one assertion: a page whose inventory name is the
    // bare package name and one whose name is the `include:`-prefixed id must
    // BOTH find the card. Registering one key meant the other rendered nothing.
    expect(WORKBUDDY_CARD_KEYS).toContain('dsh-connect-workbuddy')
    expect(WORKBUDDY_CARD_KEYS).toContain('include:dsh-connect-workbuddy')
  })

  it('the page finds the card whether it looks it up bare or prefixed', () => {
    const ctx = contextRecording(['dsh-connect-workbuddy'])
    const seen = applyRegistration(ctx)
    // What `ledger.bundles.has(pkg.name)` evaluates for each possible inventory
    // name — both true is the fix, and either false is the shipped defect.
    expect(seen.bundles).toContain('dsh-connect-workbuddy')
    expect(seen.bundles).toContain('include:dsh-connect-workbuddy')
    expect(seen.rows).toContain('include:dsh-connect-workbuddy#include:dsh-connect-workbuddy')
  })

  it('registers even when the settings mirror NEVER reports our namespace', () => {
    // The reported deployment. `whileServed` opens its watch, sees nothing, and
    // never fires the edge — so registration that waited for the edge never
    // happened, and the page showed an empty configuration section with no
    // error anywhere (the whole `apply` body only logs).
    const ctx = contextRecording(['some-other-plugin'])
    const seen = applyRegistration(ctx)
    expect(seen.registeredWithoutNamespace).toBe(true)
    expect(seen.bundles.length).toBeGreaterThan(0)
  })

  it('does not double-register when the namespace WAS already served', () => {
    // `whileServed` calls `register` synchronously when the mirror already has
    // the namespace, so the unconditional pass that follows must REPLACE those
    // entries rather than add a second copy — the slot service refuses a
    // duplicate key at the same priority, and one refusal per key would silence
    // the card exactly as before.
    const seen = applyRegistration(contextRecording(['dsh-connect-workbuddy']))
    expect(seen.duplicates).toBe(0)
    // One entry per key, not two.
    expect(seen.bundles.length).toBe(WORKBUDDY_CARD_KEYS.length)
    expect(new Set(seen.bundles).size).toBe(seen.bundles.length)
    expect(new Set(seen.rows).size).toBe(seen.rows.length)
  })

  it('keeps a host with no settings surface registering the card read-only', () => {
    const ctx: any = {
      get: () => undefined,
      effect: (run: () => () => void) => { run() },
      locale: { register: () => () => {}, bind: () => () => '' },
      slots: { inject: (_n: string, run: () => any) => run(), register: () => (() => {}) },
    }
    const seen = applyRegistration(ctx)
    expect(seen.registeredWithoutNamespace).toBe(true)
    expect(seen.calls.length).toBeGreaterThan(0)
  })

  it('the ledger the page reads is built from the SLOT keys, not the settings namespace', () => {
    // Independent second signal: whatever the settings namespace is (or is
    // not), the bundle/row ledgers must be non-empty, because the page renders
    // the configuration section only when `bundles.has(pkg.name)`.
    const served = applyRegistration(contextRecording(['dsh-connect-workbuddy']))
    const unserved = applyRegistration(contextRecording(['unrelated-plugin']))
    for (const seen of [served, unserved]) {
      expect(seen.bundles.length).toBeGreaterThan(0)
      expect(seen.rows.length).toBeGreaterThan(0)
    }
  })

  it('disposes BEFORE it re-registers, so no key is refused', () => {
    // The subtle half. `SlotCore.register` rejects a key that is still live, and
    // `registerCard` swallows that rejection into a `console.error` — so
    // registering first and disposing afterwards leaves the key with NO entry
    // at all: the ledger empties and the page goes blank again, silently.
    // The real `whileServed` runs its `register` synchronously when the mirror
    // already holds the namespace, so the unconditional pass that follows MUST
    // replace rather than append.
    //
    // `applyRegistration` drives the SAME `keyedSlots()` stub for both passes —
    // the ledger is what matters, not the client's own context — so a warm
    // mirror is simply a namespace list that already contains ours.
    const seen = applyRegistration(contextRecording(['dsh-connect-workbuddy']))
    expect(seen.duplicates).toBe(0)
    expect(seen.bundles.length).toBe(WORKBUDDY_CARD_KEYS.length)
    expect(seen.rows.length).toBe(WORKBUDDY_CARD_KEYS.length)
    // Four keys went in twice: once on the served edge, once unconditionally.
    expect(seen.calls.length).toBe(WORKBUDDY_CARD_KEYS.length * 4)
  })

  it('documents the keyed nature of the slots the page reads', () => {
    // A `keyed` slot is one entry per `key` per priority. Registering the same
    // key twice at the same priority THROWS, which is why the unconditional
    // pass disposes before it re-registers — pinned here so a later refactor
    // that appends instead of replacing fails loudly.
    const slots = keyedSlots()
    slots.register({ name: 'plugins.bundle.config', key: 'dsh-connect-workbuddy', priority: 30 }, {})
    expect(() => slots.register({ name: 'plugins.bundle.config', key: 'dsh-connect-workbuddy', priority: 30 }, {})).toThrow(/already has an entry/u)
    expect(slots.duplicates).toBe(1)
  })
})


