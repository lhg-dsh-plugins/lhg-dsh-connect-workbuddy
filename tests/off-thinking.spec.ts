import { describe, expect, it } from 'vitest'
import {
  defaultOffModelIds,
  forgetRefusals,
  lastRefusalFor,
  offDefaultFor,
  offRefused,
  recentRefusals,
  recordRefusal,
  REFUSES_OFF_MODEL_IDS,
  withEffectiveOff,
} from '../src/off-thinking.ts'

/**
 * Which models can actually turn thinking off (issue #34).
 *
 * The upstream's `reasoning.canDisableThinking` is the only declared signal, and
 * it is WRONG for nine models: they answer HTTP 400 to
 * `reasoning_effort: "off"`, the refusal does not name the parameter, and
 * because the level is part of the saved per-model selection it fails on every
 * later request too. These tests lock the reviewed table in as the correction,
 * and lock the user's override to a genuine two-way answer.
 *
 * The refusing ids are listed here INDEPENDENTLY of the source table on
 * purpose: a test that iterated the implementation's own set would stay green
 * if an id were quietly dropped from it.
 */
const REFUSING_PER_ISSUE_34 = [
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'primary-model',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gemini-3.5-flash',
]

/**
 * Models issue #34 measured as ACCEPTING `off` (HTTP 200) while declaring
 * `canDisableThinking: true`. They must keep the level, because hiding it would
 * be a functional regression for the majority of the roster.
 */
const ACCEPTING_PER_ISSUE_34 = [
  'fast-model',
  'balanced-model',
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'kimi-k3',
  'kimi-k2.6',
  'kimi-k2.8-preview',
]

/** A model that declares thinking can be disabled, as the gateways report it. */
function declaring(id: string) {
  return { id, reasoning: { supportedEfforts: ['low', 'medium', 'high'], canDisableThinking: true } }
}

describe('REFUSES_OFF_MODEL_IDS', () => {
  it('lists exactly the ids issue #34 measured as refusing off', () => {
    expect([...REFUSES_OFF_MODEL_IDS].sort()).toEqual([...REFUSING_PER_ISSUE_34].sort())
  })
})

describe('offDefaultFor', () => {
  it('withdraws off for every model measured as refusing it', () => {
    for (const id of REFUSING_PER_ISSUE_34) {
      expect(offDefaultFor(declaring(id)), id).toBe(false)
    }
  })

  it('keeps off for every model measured as accepting it', () => {
    // The guard against an over-broad table: these all declare the same
    // capability as the refusing nine, and only the table separates them.
    for (const id of ACCEPTING_PER_ISSUE_34) {
      expect(offDefaultFor(declaring(id)), id).toBe(true)
    }
  })

  it('keeps off for an unlisted model that declares it can be disabled', () => {
    // A brand-new model must not inherit its family's answer in either
    // direction; the declaration decides until the table is updated.
    expect(offDefaultFor(declaring('grok-4.7'))).toBe(true)
  })

  it('never offers off without an explicit declaration', () => {
    expect(offDefaultFor({ id: 'glm-5.3', reasoning: { supportedEfforts: ['high'] } })).toBe(false)
    expect(offDefaultFor({ id: 'glm-5.3', reasoning: { canDisableThinking: false } })).toBe(false)
    expect(offDefaultFor({ id: 'glm-5.3' })).toBe(false)
  })

  it('matches on the EXACT id, never a family prefix', () => {
    // `deepseek-v4-pro` is tabled (and refuses); an unknown sibling must fall
    // back to its own declaration rather than inheriting the correction.
    expect(offDefaultFor(declaring('deepseek-v4-pro'))).toBe(false)
    expect(offDefaultFor(declaring('deepseek-v4-pro-preview'))).toBe(true)
    expect(offDefaultFor(declaring('gpt-5.6-sol'))).toBe(false)
    expect(offDefaultFor(declaring('gpt-5.6-sol-x'))).toBe(true)
  })
})

describe('defaultOffModelIds', () => {
  it('seeds the set with exactly the accepting models, refusing ones excluded', () => {
    // The default is the SEED of the user's checkbox set: it must include the
    // 23 that accept `off` and exclude the 9 that refuse it.
    const roster = [...REFUSING_PER_ISSUE_34, ...ACCEPTING_PER_ISSUE_34].map(declaring)
    const seeded = defaultOffModelIds(roster)
    for (const id of REFUSING_PER_ISSUE_34) {
      expect(seeded, id).not.toContain(id)
    }
    for (const id of ACCEPTING_PER_ISSUE_34) {
      expect(seeded, id).toContain(id)
    }
  })

  it('excludes models that do not declare they can disable thinking', () => {
    const roster = [
      declaring('glm-5.3'),
      { id: 'glm-5.3-no-declare', reasoning: { supportedEfforts: ['high'] } },
      { id: 'glm-5.3-declares-false', reasoning: { supportedEfforts: ['high'], canDisableThinking: false } },
      { id: 'no-reasoning-at-all' },
    ]
    expect(defaultOffModelIds(roster)).toEqual(['glm-5.3'])
  })

  it('includes an unlisted model that declares it can be disabled', () => {
    // A brand-new model must not inherit its family's answer in either
    // direction; the declaration decides until the table is updated.
    expect(defaultOffModelIds([declaring('grok-4.7')])).toEqual(['grok-4.7'])
  })
})

describe('withEffectiveOff', () => {
  it('stamps the saved selection onto the runtime catalog', () => {
    // The runtime descriptor is consumed by `workBuddyThinkingLevelMap`, which
    // reads ONLY `canDisableThinking` — so the user's Set has to land here.
    const roster = [declaring('deepseek-v4.1-flash'), declaring('glm-5.3')]
    const [refused, accepted] = withEffectiveOff(roster, new Set(['glm-5.3']))
    expect(refused?.reasoning?.canDisableThinking).toBe(false)
    expect(accepted?.reasoning?.canDisableThinking).toBe(true)
  })

  it('does NOT let the user offer off for a model the table withdraws (issue #83)', () => {
    // What used to be the escape hatch. It is closed on purpose: the escape hatch
    // was also the trigger, because a stamped `off` is what pi-ai sends for
    // requests that name no reasoning tier at all.
    const roster = [declaring('deepseek-v4.1-flash'), declaring('gemini-3.5-flash')]
    for (const model of withEffectiveOff(roster, new Set(roster.map(m => m.id)))) {
      expect(model.reasoning?.canDisableThinking, model.id).toBe(false)
    }
  })

  it('preserves every other field on the model and on its reasoning', () => {
    const [model] = withEffectiveOff([
      {
        id: 'deepseek-v4.1-flash',
        name: 'Deepseek-V4.1-Flash',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        reasoning: { supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high', canDisableThinking: true },
      },
    ], new Set())
    expect(model).toMatchObject({
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
    expect(model?.reasoning).toEqual({
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      canDisableThinking: false,
    })
  })

  it('leaves a model with no reasoning untouched', () => {
    // No reasoning means no level to correct — inventing a `reasoning` object
    // here would fabricate a capability answer out of nothing.
    const input: Array<{
      id: string
      name: string
      contextWindow: number
      maxTokens: number
      reasoning?: { supportedEfforts: readonly string[], canDisableThinking: boolean }
    }> = [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000, maxTokens: 32_000 }]
    const output = withEffectiveOff(input, new Set(['glm-5.3']))
    expect(output[0]).toBe(input[0])
    expect(output[0]?.reasoning).toBeUndefined()
  })

  it('REFUSES to honour a selection for a model the table says refuses off (issue #83)', () => {
    // This used to assert the opposite. The tick is not a capability claim: with
    // `off` stamped on, pi-ai sends `reasoning_effort: "off"` for EVERY request
    // that carries no effort at all — compaction summaries are exactly that — so
    // one tick failed every `/compact` with 400 / 11133, for good. The table wins
    // because the asymmetry is unchanged: a hidden level costs one option, a
    // failing one costs every request for the model.
    const [model] = withEffectiveOff([declaring('deepseek-v4.1-flash')], new Set(['deepseek-v4.1-flash']))
    expect(model?.reasoning?.canDisableThinking).toBe(false)
  })

  it('still honours the selection for a model the table does not list', () => {
    // The wall is the table, not the checkbox: an entry the table has not learned
    // about keeps the user's answer.
    const [model] = withEffectiveOff([declaring('grok-4.7')], new Set(['grok-4.7']))
    expect(model?.reasoning?.canDisableThinking).toBe(true)
  })

  it('withdraws every model when the selection is empty', () => {
    const roster = [...REFUSING_PER_ISSUE_34, ...ACCEPTING_PER_ISSUE_34].map(declaring)
    for (const model of withEffectiveOff(roster, new Set())) {
      expect(model.reasoning?.canDisableThinking, model.id).toBe(false)
    }
  })
})

describe('offRefused', () => {
  it('answers for the table, by exact id', () => {
    for (const id of REFUSING_PER_ISSUE_34) expect(offRefused(id), id).toBe(true)
    for (const id of ACCEPTING_PER_ISSUE_34) expect(offRefused(id), id).toBe(false)
    expect(offRefused('deepseek-v4.1-flash-next')).toBe(false)
  })

  it('is the SAME predicate the catalog stamping uses', () => {
    // One source of truth: if these could disagree, the card would say "cannot be
    // enabled" on a row the runtime happily offered the level for.
    for (const id of [...REFUSING_PER_ISSUE_34, ...ACCEPTING_PER_ISSUE_34]) {
      const [model] = withEffectiveOff([declaring(id)], new Set([id]))
      expect(model?.reasoning?.canDisableThinking, id).toBe(!offRefused(id))
    }
  })
})

describe('observed refusals (issue #83)', () => {
  it('records newest first and answers per model', () => {
    forgetRefusals()
    recordRefusal({ param: 'reasoning_effort', tier: 'off', code: 11133, modelId: 'gpt-6-astra', at: 1 })
    recordRefusal({ param: 'reasoning_effort', tier: 'off', code: 11133, modelId: 'glm-5.3', at: 2 })
    expect(recentRefusals().map(report => report.modelId)).toEqual(['glm-5.3', 'gpt-6-astra'])
    expect(lastRefusalFor('gpt-6-astra')?.code).toBe(11133)
    expect(lastRefusalFor('kimi-k3')).toBeUndefined()
  })

  it('is bounded, so a refusal storm cannot grow memory', () => {
    forgetRefusals()
    for (let index = 0; index < 50; index += 1) {
      recordRefusal({ param: 'reasoning_effort', at: index })
    }
    expect(recentRefusals()).toHaveLength(20)
    expect(recentRefusals()[0]?.at).toBe(49)
  })

  it('hands out a copy, so a reader cannot mutate the ring', () => {
    forgetRefusals()
    recordRefusal({ param: 'reasoning_effort', at: 1 })
    const copy = recentRefusals() as unknown as Array<{ at: number }>
    copy.pop()
    expect(recentRefusals()).toHaveLength(1)
  })
})
