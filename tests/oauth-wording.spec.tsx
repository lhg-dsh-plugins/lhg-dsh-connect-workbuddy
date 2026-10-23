// @vitest-environment jsdom
/**
 * The sign-in section NAMES ITS METHOD per region.
 *
 * CN signs in by scanning a QR code with the WorkBuddy app; the international
 * build signs in on a browser web page. The card used to say 「扫码登录」 on both,
 * which is simply wrong on the international tab — there is no QR there.
 *
 * The split is deliberately three strings wide (title, button, unavailable), not
 * a full second copy of the section: everything else is about the flow rather
 * than the method, so keeping it shared is what stops the two regions drifting.
 *
 * The title is no longer PRINTED. It used to sit on its own line above the one
 * button the section holds, restating it (「扫码添加账号」 over 「扫码登录」), so it
 * now exists only as the section's `aria-label`. That moves the assertion off
 * `textContent` — jsdom cannot see an attribute through `text()` — and onto the
 * attribute itself, which is also what fails if someone deletes the name
 * outright: `sectionName` then returns null instead of quietly passing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthSignIn } from '../src/client/OAuthSignIn.tsx'
import { mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** The section's accessible name — the title's only home now that it is silent. */
function sectionName(view: { container: HTMLElement }): string | null {
  return view.container.querySelector('.dsm-workbuddy-bar')?.getAttribute('aria-label') ?? null
}

describe('the sign-in wording follows the region', () => {
  it('says QR on the domestic tab', async () => {
    stubFetch(() => ({ body: {} }))
    const view = await mount(OAuthSignIn, { t, region: 'cn' })
    expect(sectionName(view)).toBe('row.oauthTitle')
    expect(view.text()).toContain('row.oauthStart')
    // The name is a name, not a caption: nothing on screen repeats it, and the
    // old caption class is gone from the DOM rather than merely emptied.
    expect(view.text()).not.toContain('row.oauthTitle')
    expect(view.container.querySelector('.dsm-workbuddy-bar-label')).toBeNull()
    expect(view.text()).not.toContain('row.oauthStartGlobal')
    await view.unmount()
  })

  it('says web sign-in on the international tab', async () => {
    stubFetch(() => ({ body: {} }))
    const view = await mount(OAuthSignIn, { t, region: 'global' })
    expect(view.text()).toContain('row.oauthStartGlobal')
    // The QR wording must be GONE, not merely joined by the new one: both
    // keys rendering would mean the region branch does nothing. The accessible
    // name is compared for EQUALITY because 'row.oauthTitle' is a PREFIX of
    // 'row.oauthTitleGlobal' — a substring check would pass with both present.
    expect(sectionName(view)).toBe('row.oauthTitleGlobal')
    expect(view.text()).not.toMatch(/row\.oauthTitle(?![A-Za-z])/)
    expect(view.text()).not.toMatch(/row\.oauthStart(?![A-Za-z])/)
    await view.unmount()
  })

  it('keeps the method-agnostic lines shared between regions', async () => {
    // At rest the button shows the START key, whose region variant is the point
    // of this file; what must stay SHARED is the rest of the flow. The waiting
    // line is the one a user reads while a sign-in is running, and it must not
    // need a second copy per region — so this pins that only the three naming
    // keys were split. Absence of a region variant for it is the assertion.
    stubFetch(() => ({ body: {} }))
    for (const region of ['cn', 'global'] as const) {
      const view = await mount(OAuthSignIn, { t, region })
      // The start key is region-specific...
      expect(view.text()).toMatch(region === 'cn' ? /row\.oauthStart(?![A-Za-z])/ : /row\.oauthStartGlobal/)
      // ...and there is no region variant of the flow lines to render instead.
      expect(view.text()).not.toContain('row.oauthWaitingGlobal')
      expect(view.text()).not.toContain('row.oauthOpenedGlobal')
      await view.unmount()
    }
  })
})
