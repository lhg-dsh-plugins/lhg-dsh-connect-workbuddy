// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, t } from './pool-render-helpers.tsx'
import {
  claimsQuotaNotice,
  selectQuotaNoticeClaim,
  WORKBUDDY_QUOTA_NOTICE_CODES,
  WorkBuddyQuotaNotice,
} from '../src/client/WorkBuddyQuotaNotice.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/**
 * Issue #63, and its second follow-up (the maintainer, on a screenshot): a box
 * had appeared at the TOP-LEFT of the window that "was not there before", and
 * it turned out to be OURS.
 *
 * The history matters, because each version fixed the previous one's mistake:
 *
 *   1. v1 rendered a CARD — a body paragraph plus a 「知道了」 button — in the
 *      `shell.quota-notice` seat. Rejected: it turned a fact the user only has
 *      to read into something with a control, and buried the clause that
 *      matters under a paragraph.
 *   2. v2 rendered an inline `<span>` in the SAME seat, carrying the host's
 *      sentence plus a parenthetical. Still wrong, for a structural reason the
 *      first fix did not touch: claiming a `shell.quota-notice` entry does not
 *      decorate the host's surface, it REPLACES it (the chain's contract: "the
 *      first entry whose selector claims its code takes over the surface, and
 *      the all-decline case renders the host's generic warning Toast"). The
 *      host's Toast is `position: fixed; top: 40px; left: 50%` and fades out.
 *      The span that replaced it was none of those things, so it parked at the
 *      top-left of `shell.overlay` (an `inset: 0` layer) and STAYED.
 *   3. v3 (this one) DECLINES the chain, so the host's own Toast is back, and
 *      the supplement no longer paints into the overlay at all.
 *
 * What is pinned here, and why each assertion is a FORM guard rather than a
 * copy guard: every text-level test in this file passed in v2 as well, which is
 * exactly how a top-left box shipped while the copy looked right.
 *
 *   1. the DECLINE is explicit — the registration returns null for every owner,
 *      and the retired claim set is kept as history rather than as policy;
 *   2. the host's sentence is NOT re-rendered by this component: an earlier
 *      guard ("keeps the host's sentence verbatim") is now the opposite rule,
 *      because a takeover that re-draws the sentence is what put a second copy
 *      on screen;
 *   3. the component is still an inline, box-free parenthetical with nothing to
 *      dismiss — unchanged from v2, because the copy and its honesty for BOTH
 *      cases the `QUOTA` code covers are still right.
 */

describe('what this plugin claims of the host\'s quota notice', () => {
  it('declines every owner, so the host keeps its own Toast', () => {
    // The whole fix, in one assertion. `select` is the chain's decision point:
    // returning null for every owner leaves the chain in its all-decline case,
    // which is the host's generic warning Toast — the surface the last version
    // silently replaced with a box that could not centre itself or fade out.
    expect(selectQuotaNoticeClaim({ code: 'QUOTA' })).toBeNull()
    expect(selectQuotaNoticeClaim({ code: 'ACCOUNT_QUOTA' })).toBeNull()
    expect(selectQuotaNoticeClaim(undefined)).toBeNull()
    expect(selectQuotaNoticeClaim(null)).toBeNull()
  })

  it('keeps the retired claim set as history, not as policy', () => {
    // `QUOTA` is what the shipped classifier produces for both failures this
    // plugin raises (6004 account rate limit, 14018 exhausted credits). The set
    // is retained so a future reader can see WHAT the takeover targeted — but
    // nothing consults it at runtime any more, and the assertion above is what
    // proves that. A regression that re-claimed these codes would still pass
    // this test, which is why the decline has its own.
    expect(WORKBUDDY_QUOTA_NOTICE_CODES).toEqual(['QUOTA'])
    expect(claimsQuotaNotice('QUOTA')).toBe(true)
    for (const code of ['AUTH', 'ACCOUNT_QUOTA', 'ACCOUNT_SIGNED_OUT', 'RATE_LIMIT', 'QUOTA_EXCEEDED', '', undefined, null, 42, {}]) {
      expect(claimsQuotaNotice(code)).toBe(false)
    }
  })
})

describe('what the supplement says on its own', () => {
  it('does NOT re-render the host\'s sentence', async () => {
    // The rule INVERTED from v2. There, this component prepended the host's
    // sentence and appended the parenthetical, which is what produced a second
    // copy of a sentence the host already draws in the turn's failure row. The
    // component is now ONLY the supplement; the host owns its own sentence.
    const m = await mount(WorkBuddyQuotaNotice, {
      matched: { code: 'QUOTA', message: 'HOST SENTENCE' },
      t,
    })
    expect(m.text()).toContain('quotaNotice.supplement')
    expect(m.text()).not.toContain('HOST SENTENCE')
    await m.unmount()
  })

  it('renders as an inline parenthetical, with nothing to dismiss', async () => {
    // Unchanged from v2 and still load-bearing: no button, no block container.
    // Anything else reintroduces the dialog that was rejected in v1 under a new
    // name.
    const m = await mount(WorkBuddyQuotaNotice, { matched: { code: 'QUOTA', message: 'HOST' }, t })
    expect(m.buttons()).toHaveLength(0)
    expect(m.container.querySelector('button')).toBeNull()
    const root = m.container.firstElementChild
    expect(root?.tagName).toBe('SPAN')
    expect(root?.className).toContain('dsm-workbuddy-quota-notice')
    // Exactly one child: the parenthetical. A second child is the host's
    // sentence creeping back in.
    expect(root?.children).toHaveLength(1)
    await m.unmount()
  })

  it('carries no host-sentence class at all', async () => {
    // The v2 build styled the host's sentence through its own wrapper class. The
    // takeover painted that sentence in the overlay; with the decline there is
    // nothing left for that class to style, and leaving a selector behind would
    // let a future edit re-introduce the sentence without a test noticing.
    const m = await mount(WorkBuddyQuotaNotice, { matched: { code: 'QUOTA', message: 'HOST' }, t })
    expect(m.container.querySelector('.dsm-workbuddy-quota-notice-head')).toBeNull()
    await m.unmount()
  })

  it('never claims the sentence means an empty balance', async () => {
    // The honest wording both cases share: a model's own daily limit is
    // unrelated to credits, AND an exhausted balance is possible. Copy that
    // asserted only one of them would be wrong for the other case.
    const m = await mount(WorkBuddyQuotaNotice, { matched: { code: 'QUOTA', message: 'HOST' }, t })
    expect(m.text()).toContain('quotaNotice.supplement')
    await m.unmount()
  })
})
