// @vitest-environment jsdom
/**
 * The veil must come down even when the list re-read never answers (issue #51).
 *
 * ## The defect
 *
 * Reported as 「登录成功后这里会转很久，等一分钟也没等完，每次都是直接退出 DSH
 * 重新打开」, with a screenshot in which the account table is ALREADY populated —
 * three accounts, one of them serving — while the veil still reads 「正在添加
 * 账号…｜完成后列表会立即刷新」.
 *
 * That combination is the whole diagnosis. The credential is written by the Host
 * BEFORE the poll answers `done`, so the table being populated means the sign-in
 * genuinely succeeded; what hung was the next step. In `OAuthSignIn` the poll's
 * `done` branch does:
 *
 *     setPhase({ kind: 'syncing', accountName })
 *     await onAdded?.()                       // ← no deadline, no catch
 *     setPhase({ kind: 'finished', … })
 *
 * and the veil is `visible={phase.kind === 'syncing'}`. So the veil's only exit
 * condition was a promise settling. A re-read that never settles — the card's
 * same-origin usage fetch, which the Host can leave open indefinitely — held the
 * phase at `syncing` forever, with no timer to break it. The `waiting` phase one
 * branch up HAS such a deadline; `syncing` had neither that nor a `catch`,
 * which is the asymmetry this file pins.
 *
 * The user's only recovery was to destroy the component: close the card or
 * force-quit DSH. Hence "half usable" — the account works, the UI never said so.
 *
 * ## Why the clock is driven by hand
 *
 * The behaviour under test is a DEADLINE, so the test has to own time — but the
 * shared harness's `settle()` drains async work with `setTimeout`, which fake
 * timers freeze, so it cannot be used past `vi.useFakeTimers()` (it hangs until
 * the test times out). The flow is therefore driven with explicit
 * `advanceTimersByTimeAsync` plus `act`, which both moves the fake clock and
 * lets the awaited fetch/json chain run — and `advanceTimersByTimeAsync` is
 * awaitable precisely so the microtasks it woke up get to finish.
 *
 * ## What is asserted
 *
 * Not the timer's value, and not the implementation: the OBSERVABLE, which is
 * that the veil disappears and the success line replaces it while the re-read is
 * still pending. A regression that reintroduces a bare `await onAdded?.()` fails
 * this file regardless of how it is spelled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { OAuthSignIn } from '../src/client/OAuthSignIn.tsx'
import { AccountTransfer } from '../src/client/AccountTransfer.tsx'
import { mount, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** The auth + poll route pair, the poll ending in `done` exactly once. */
function stubSignIn(): void {
  // The poll must answer `done` only once: a second `done` would re-enter the
  // sync path on the next poll and re-report the same account.
  let polled = false
  stubFetch((url: string) => {
    if (url.includes('action=start')) {
      return { body: { loginId: 'L1', verificationUri: 'https://www.codebuddy.cn/login?state=st-1', expiresIn: 600 } }
    }
    if (polled) return { body: { done: false } }
    polled = true
    return { body: { done: true, accountName: 'Alpha' } }
  })
}

/** Let the awakened promise chain (fetch → json → setState) run. */
async function flush(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

/**
 * Drive the flow to the point where the poll has answered `done`.
 *
 * The advance is `OAUTH_POLL_INTERVAL_MS` (2s), which is the poll's arming delay
 * — NOT the settle deadline's 5s. That asymmetry is what makes the pre-deadline
 * state observable at all: advancing past 5s inside one call would fire the poll
 * AND run the deadline to completion, and the veil would already be gone.
 *
 * It was 60s here at first, on the assumption that the poll rode the card's
 * one-minute usage interval. It does not: the sign-in poll has its own 2s
 * cadence, so a 60s advance simply ran the whole flow to its end.
 */
async function reachSyncing(view: Awaited<ReturnType<typeof mount>>): Promise<void> {
  await view.click(view.button('row.oauthStart'))
  await flush()
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  await flush()
}

/** A promise that never settles — the host-side hang, in its purest form. */
function neverSettles(): Promise<unknown> {
  return new Promise(() => {})
}

describe('#51: the sign-in veil is bounded by a deadline, not by the re-read', () => {
  it('takes the veil down and reports success while the re-read is still pending', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('open', vi.fn(() => null))
    stubSignIn()

    const view = await mount(OAuthSignIn, { t, region: 'cn', onAdded: neverSettles })
    await reachSyncing(view)

    // The re-read is still in flight — asserted, not assumed, because a version
    // that simply stopped calling `onAdded` would also pass the rest.
    expect(view.text()).toContain('row.oauthSyncing')

    // Past the ceiling. This is the assertion that fails on the reported build:
    // `await onAdded?.()` keeps the phase at `syncing` and the veil stays up
    // forever, so nothing about the screen ever changes again.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await flush()

    expect(view.html()).not.toContain('row.oauthSyncing')
    expect(view.text()).toContain('row.oauthDone')
    // The account name the Host reported must survive into the success line —
    // the deadline changes WHEN the line appears, not what it says.
    expect(view.text()).toContain('accountName=Alpha')
    await view.unmount()
  })

  it('does not wait out the deadline when the re-read answers promptly', async () => {
    // The bounded wait must not become a fixed delay: a healthy re-read has to
    // finish the flow immediately, or every sign-in would gain the ceiling.
    vi.useFakeTimers()
    vi.stubGlobal('open', vi.fn(() => null))
    stubSignIn()

    const view = await mount(OAuthSignIn, {
      t,
      region: 'cn',
      onAdded: () => Promise.resolve('snapshot landed'),
    })
    await reachSyncing(view)

    // No extra time advanced past the poll: the flow is already done.
    expect(view.text()).toContain('row.oauthDone')
    expect(view.html()).not.toContain('row.oauthSyncing')
    await view.unmount()
  })

  it('treats a FAILED re-read as success, because the credential is already stored', async () => {
    // `refreshUsage` swallows its own errors, but the prop is typed
    // `() => void | Promise<unknown>` and a rejection must not escape into the
    // poll's `catch` — that branch retries the poll, which would re-enter the
    // done path and re-report an account that is already added.
    vi.useFakeTimers()
    vi.stubGlobal('open', vi.fn(() => null))
    stubSignIn()

    const view = await mount(OAuthSignIn, {
      t,
      region: 'cn',
      onAdded: () => Promise.reject(new Error('usage route died')),
    })
    await reachSyncing(view)

    expect(view.text()).toContain('row.oauthDone')
    expect(view.text()).not.toContain('row.oauthError')
    await view.unmount()
  })

  it('stops holding the veil when the re-read outlives the deadline', async () => {
    // A re-read slower than the deadline is the reported shape: the veil
    // outlived every "it will refresh in a moment" the user was told to expect.
    // What matters is that it ends at the CEILING and not when the re-read
    // eventually lands — hence the 300s work against a 5s deadline.
    vi.useFakeTimers()
    vi.stubGlobal('open', vi.fn(() => null))
    stubSignIn()

    const view = await mount(OAuthSignIn, {
      t,
      region: 'global',
      onAdded: () => new Promise(resolve => setTimeout(resolve, 300_000)),
    })
    await reachSyncing(view)
    expect(view.text()).toContain('row.oauthSyncing')

    // The poll cadence (2s) must NOT be what ends the wait: one more interval
    // leaves the veil up, because only the deadline may release it.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    await flush()
    expect(view.text()).toContain('row.oauthSyncing')

    // Past the ceiling — and long before the 300s re-read would have answered.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    await flush()
    expect(view.text()).toContain('row.oauthDone')
    await view.unmount()
  })
})

describe('#51: the import veil gets the same ceiling', () => {
  it('does not stay up forever behind an import whose re-read never answers', async () => {
    // Same defect, same `await onChanged?.()`, same veil — reached through the
    // import path instead of sign-in. Fixed in the same change so the two
    // cannot drift: both now call the one `settlesWithin`.
    vi.useFakeTimers()
    stubFetch((url: string) => url.includes('action=import')
      ? { body: { imported: 1, skipped: 0 } }
      : { body: { accounts: [{ index: 0, accountName: 'Alpha', hasToken: true }] } })

    const view = await mount(AccountTransfer, {
      t,
      region: 'cn',
      accounts: [],
      onChanged: neverSettles,
    })
    // Open the import dialog, hand it a file, then confirm.
    await view.click(view.button('row.transferImport'))
    await flush()
    const input = view.container.querySelector('input[type=file]') as HTMLInputElement
    expect(input).not.toBeNull()
    const file = new File(['{"accounts":[]}'], 'accounts.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await flush()

    await view.click(view.button('row.transferImportConfirm'))
    await flush()
    // The write landed and the re-read is pending — the phase this file is about.
    expect(view.text()).toContain('row.transferImporting')

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    await flush()

    expect(view.text()).toContain('row.transferImported')
    await view.unmount()
  })
})
