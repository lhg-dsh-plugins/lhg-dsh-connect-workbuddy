/**
 * Issue #83: the PROFILE default tier, which is a separate seam from the level
 * map.
 *
 * The other half of the fix is covered in `tests/issue83-off-refusal.spec.ts`
 * (the level map no longer offers `off` for a tabled model, and the request body
 * guard strips it). This file pins the second, independent barrier: the profile
 * every request is dispatched through declares its own default effort.
 *
 * WHY IT MATTERS. `dsh-llm-pi-ai` resolves a request's tier as
 * `options.reasoningEffort ?? profile.reasoning`, and pi-ai's `openai-
 * completions` then substitutes `model.thinkingLevelMap?.off` whenever that
 * result is absent. A compaction summary passes no effort, so with no profile
 * default the tier was whatever pi-ai's map happened to say — and when anything
 * upstream of the adapter (a hand-built descriptor, an older catalog snapshot,
 * an alias the gateway resolves differently) still carried `off → "off"`, the
 * summary request asked a model like `deepseek-v4.1-flash` to disable thinking.
 * It answers 400 / 11133, and `/compact` failed for good.
 *
 * The assertion is therefore about the PROFILE, not the body: the body shape of
 * a non-reasoning model (the only kind that reaches pi-ai without a supported
 * level) never carries the field, so a body-level test cannot observe this seam
 * at all — which is exactly how the gap survived the level-map fix.
 */

import { describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter, WORKBUDDY_DEFAULT_EFFORT, WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'

interface ProfileShape {
  reasoning?: string
  provider: string
  piProvider: { id: string }
}

function profilesOf(): Map<string, ProfileShape> {
  const { adapter } = createWorkBuddyAdapter({
    shim: { baseUrl: () => 'http://127.0.0.1:1', token: async () => 'shared-secret' } as never,
    store: {} as never,
    catalog: new WorkBuddyCatalog(),
  })
  return (adapter as unknown as { config: { profiles: () => Map<string, ProfileShape> } })
    .config.profiles()
}

describe('issue #83: the dispatch profile never leaves the tier to pi-ai', () => {
  it('declares an explicit default effort', () => {
    // An absent default is not "no opinion": it delegates to the level map,
    // whose `off → "off"` is the value the upstream rejects.
    for (const [key, profile] of profilesOf()) {
      expect(profile.reasoning, key).toBe(WORKBUDDY_DEFAULT_EFFORT)
    }
  })

  it('declares it on the route key the host resolves', () => {
    // The profile map can publish more than one key (the identity key added for
    // issue #75); every one of them must carry the default, so the assertion is
    // "all of them" and not "the first one found".
    const profiles = profilesOf()
    expect(profiles.size).toBeGreaterThan(0)
    expect([...profiles.values()].every(profile => profile.reasoning === WORKBUDDY_DEFAULT_EFFORT)).toBe(true)
    expect(profiles.has(WORKBUDDY_PROVIDER)).toBe(true)
  })

  it('never defaults to off', () => {
    // The one value that must never be the default: it is the level the upstream
    // refuses, and compaction is precisely the caller that uses the default.
    for (const profile of profilesOf().values()) {
      expect(profile.reasoning).not.toBe('off')
    }
  })
})
