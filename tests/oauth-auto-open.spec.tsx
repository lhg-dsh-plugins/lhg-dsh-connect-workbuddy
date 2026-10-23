// @vitest-environment jsdom
/**
 * The sign-in AUTO-OPEN, and the `window.open` call that has to carry it.
 *
 * The defect this file pins was invisible to every other test in the suite,
 * because jsdom's `window.open` is a stub that logs "Not implemented" and
 * returns `undefined` — so nothing here could observe what the real browser
 * does with the arguments. The bug lived entirely in the ARGUMENTS:
 *
 *   `window.open('', '_blank', 'noopener,noreferrer')`
 *
 * Per the spec, a call carrying `noopener` opens the browsing context but
 * returns `null` (MDN, `Window.open`: "the new window will not have access to
 * the originating window via `Window.opener` and returns `null`"). The
 * placeholder exists ONLY to be navigated once the Host answers, so a null
 * handle means the navigation is skipped: the user got an empty `about:blank`
 * tab and never saw the sign-in page, while the dialog happily said 「已打开，
 * 等待你完成登录…」.
 *
 * So this file does two things the suite could not do before:
 *   BEHAVIOUR  a spec-faithful `window.open` double (null when `noopener` is
 *              present) drives the real component and asserts the auth URL was
 *              actually loaded into the placeholder.
 *   GUARD      a source check that the PLACEHOLDER call never regains
 *              `noopener`/`noreferrer`, since restoring either one silently
 *              reverses the fix without failing anything else.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OAuthSignIn } from '../src/client/OAuthSignIn.tsx'
import { mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

/** One `window.open` call as a spec-faithful browser would serve it. */
interface OpenedWindow {
  location: { href: string }
  closed: boolean
  close: () => void
  openerCleared: boolean
}

/**
 * A `window.open` double that obeys the `noopener` rule.
 *
 * This is the whole point of the file: the previous call shape "worked" against
 * a permissive double and failed against every real browser.
 */
function specFaithfulOpen(): { calls: string[][], opened: OpenedWindow[], open: ReturnType<typeof vi.fn> } {
  const calls: string[][] = []
  const opened: OpenedWindow[] = []
  const open = vi.fn((url: string, target: string, features?: string) => {
    calls.push([String(url), String(target), String(features ?? '')])
    const entry: OpenedWindow = {
      location: { href: String(url) },
      closed: false,
      close() { entry.closed = true },
      openerCleared: false,
    }
    opened.push(entry)
    // The spec's rule, verbatim: `noopener` (and `noreferrer`, which implies it)
    // yields a null handle even though the tab does open.
    const featuresText = String(features ?? '')
    if (featuresText.includes('noopener') || featuresText.includes('noreferrer')) return null
    // `opener = null` is how the component keeps the security property on the
    // handle it does get; record whether it applied it.
    return new Proxy(entry, {
      set(target, property, value) {
        if (property === 'opener') {
          target.openerCleared = value === null
          return true
        }
        return Reflect.set(target, property, value)
      },
      get(target, property) {
        return Reflect.get(target, property)
      },
    })
  })
  return { calls, opened, open }
}

describe('the auto-open actually loads the sign-in page', () => {
  it('navigates the placeholder to the authorization URL', async () => {
    const { calls, opened, open } = specFaithfulOpen()
    vi.stubGlobal('open', open)
    stubFetch(url => url.includes('action=start')
      ? { body: { loginId: 'L1', verificationUri: 'https://www.codebuddy.cn/login?state=st-1', expiresIn: 600 } }
      : { body: { done: false } })
    const view = await mount(OAuthSignIn, { t, region: 'cn' })
    await view.click(view.button('row.oauthStart'))
    await view.settle()

    // The placeholder must be created WITHOUT the features that null the handle.
    const placeholderCall = calls[0]
    expect(placeholderCall).toBeDefined()
    expect(placeholderCall![2]).not.toContain('noopener')
    expect(placeholderCall![2]).not.toContain('noreferrer')

    // And the URL must have landed in it. Before the fix the handle was null, so
    // this stayed at the empty string and the user saw a blank tab.
    expect(opened[0]?.location.href).toBe('https://www.codebuddy.cn/login?state=st-1')
    // The security property is preserved on the handle, just not via the
    // feature that would have removed the handle.
    expect(opened[0]?.openerCleared).toBe(true)
    await view.unmount()
  })

  it('still degrades to the dialog link when the open is blocked outright', async () => {
    // A genuinely blocked popup (null for any reason): the flow must survive,
    // which is the fallback the dialog's link and copy button exist for.
    vi.stubGlobal('open', vi.fn(() => null))
    stubFetch(url => url.includes('action=start')
      ? { body: { loginId: 'L1', verificationUri: 'https://www.codebuddy.cn/login?state=st-1', expiresIn: 600 } }
      : { body: { done: false } })
    const view = await mount(OAuthSignIn, { t, region: 'cn' })
    await view.click(view.button('row.oauthStart'))
    await view.settle()
    expect(view.text()).toContain('row.oauthWaiting')
    expect(view.html()).toContain('https://www.codebuddy.cn/login?state=st-1')
    await view.unmount()
  })
})

describe('the placeholder call shape is guarded at the source', () => {
  /**
   * Resolve the source path from `import.meta.url` through `node:path`.
   *
   * Two traps, each of which fails on one machine while passing on another:
   *   JSDOM   `new URL('../src/…', import.meta.url)` does NOT resolve against
   *           the module URL in this environment — it resolves against the jsdom
   *           document, so `fileURLToPath` rejects the result with 「The URL must
   *           be of scheme file」. This file opts into jsdom for the render
   *           tests below, so the obvious form is unusable here.
   *   WINDOWS Building a `file:` URL by concatenating `process.cwd()` is not an
   *           escape either: the drive letter and backslashes produce a URL
   *           whose path resolves to `/D:/…`, which no `fs` call accepts. It
   *           would fail on `windows-latest` only.
   * `fileURLToPath(import.meta.url)` is correct under both, and `join` keeps the
   * separators platform-native. Mirrors `tests/client-host-contract.spec.ts`.
   */
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'OAuthSignIn.tsx'),
    'utf8',
  )

  it('never passes noopener when a handle is needed', () => {
    // Matched on the actual call, not on the helper's name: renaming the
    // function must not be able to hide the regression.
    const placeholderCalls = source.match(/window\.open\(\s*''\s*,[^)]*\)/gu) ?? []
    expect(placeholderCalls.length).toBeGreaterThan(0)
    for (const call of placeholderCalls) {
      expect(call).not.toContain('noopener')
      expect(call).not.toContain('noreferrer')
    }
  })

  it('keeps the security property by clearing opener on the handle', () => {
    // The substitute for the feature, so a future edit cannot drop BOTH.
    expect(source).toMatch(/placeholder\.opener\s*=\s*null/u)
  })
})
