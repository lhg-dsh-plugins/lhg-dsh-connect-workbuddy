// @vitest-environment jsdom
/**
 * The refresh-after-mutation wiring: what makes a delete and an import VISIBLE
 * without closing the settings page.
 *
 * Two real defects live here, and both are invisible to a source-text guard:
 *
 *   VEIL HOLD  A row removal awaits the re-read before dropping its veil. The
 *        old fire-and-forget onRefresh call dropped the veil immediately,
 *        while the OLD snapshot was still rendered — so the deleted row sat
 *        there looking undeleted. That is the confusion the veil removes, and
 *        it is only removed if the veil outlives the re-read.
 *   REFRESH ON IMPORT  AccountTransfer asks the card to re-read once an import
 *        lands. Without that call the new accounts appear only on a later
 *        poll, and on a region that had no account before there is no poll at
 *        all — the exact "imported but still not listed" report.
 *
 * Both assertions are behavioural: they read the real DOM and count real calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { AccountPool } from '../src/client/AccountPool.tsx'
import { AccountTransfer } from '../src/client/AccountTransfer.tsx'
import { accountOf, fakeScope, mount, poolOf, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const POOL_PATH = '/plugins/dsh-connect-workbuddy/pool'
const TRANSFER_PATH = '/plugins/dsh-connect-workbuddy/transfer'

function poolProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t,
    region: 'cn',
    settingsScope: fakeScope({}),
    pool: poolOf({
      memberAccountIds: ['a1', 'a2'],
      effectiveMemberAccountIds: ['a1', 'a2'],
      accounts: [
        accountOf({ accountId: 'a1', accountName: 'A1', current: true }),
        accountOf({ accountId: 'a2', accountName: 'A2' }),
      ],
    }),
    ...overrides,
  }
}

describe('a row removal keeps its veil up until the list re-read lands', () => {
  it('awaits onRefresh before clearing the busy state', async () => {
    // A re-read that never resolves stands in for a slow usage route. If the
    // removal does NOT await it, the veil is already gone here — and the row
    // is still on screen from the stale props, which is the defect.
    let releaseRefresh: (() => void) | undefined
    const refresh = vi.fn(() => new Promise<void>(resolve => { releaseRefresh = resolve }))
    stubFetch(url => url.includes(POOL_PATH)
      ? { body: { removed: true } }
      : { body: {} })
    const view = await mount(AccountPool, poolProps({ onRefresh: refresh }))
    const removeButtons = view.buttons().filter(b => (b.textContent ?? '') === 'row.poolRowRemove')
    expect(removeButtons.length).toBe(2)
    await view.click(removeButtons[1]!)
    await view.settle()
    expect(refresh).toHaveBeenCalledTimes(1)
    // Still waiting on the re-read: the veil MUST still be up.
    expect(view.container.querySelector('.dsm-workbuddy-veil')).not.toBeNull()
    expect(view.text()).toContain('row.poolRowRemoving')
    releaseRefresh?.()
    await view.settle()
    expect(view.container.querySelector('.dsm-workbuddy-veil')).toBeNull()
    await view.unmount()
  })
})

describe('the import button opens the system picker directly', () => {
  it('shows no dialog before a file is chosen', async () => {
    // The deleted pre-dialog was a one-line box whose only content was "choose
    // a JSON file" plus the file input — ceremony in front of a dialog the OS
    // shows anyway. What must remain is the CONFIRMATION step, which appears
    // only once there is something to confirm.
    stubFetch(() => ({ body: {} }))
    const view = await mount(AccountTransfer, { t, region: 'cn', accounts: [] })
    // Nothing is on screen until a file is picked.
    expect(view.container.querySelector('.dsm-workbuddy-transfer-dialog')).toBeNull()
    // The button delegates to the hidden input rather than rendering a dialog
    // of its own; spying proves the delegation, which a wording check cannot.
    const input = view.container.querySelector<HTMLInputElement>('input[type=file]')
    expect(input).not.toBeNull()
    const clicked = vi.fn()
    input!.addEventListener('click', clicked)
    await view.click(view.button('row.transferImport'))
    expect(clicked).toHaveBeenCalledTimes(1)
    // Still no dialog: opening the picker is not a step the user must see.
    expect(view.container.querySelector('.dsm-workbuddy-transfer-dialog')).toBeNull()
    await view.unmount()
  })

  it('shows the confirmation dialog once a file IS chosen', async () => {
    stubFetch(url => url.includes('action=preview')
      ? { body: { accounts: [{ index: 0, uid: 'u1', nickname: 'Picked One', email: '', hasToken: true }], total: 1 } }
      : { body: {} })
    const view = await mount(AccountTransfer, { t, region: 'cn', accounts: [] })
    const input = view.container.querySelector<HTMLInputElement>('input[type=file]')
    const file = new File(['[]'], 'accounts.json', { type: 'application/json' })
    Object.defineProperty(input!, 'files', { value: [file], configurable: true })
    await act(() => {
      input!.dispatchEvent(new window.Event('change', { bubbles: true }))
      return Promise.resolve()
    })
    await view.settle()
    expect(view.text()).toContain('row.transferPreviewTotal')
    expect(view.text()).toContain('Picked One')
    await view.unmount()
  })
})

describe('an import asks the card to re-read so the new accounts appear', () => {
  it('calls onChanged after the import is stored', async () => {
    const onChanged = vi.fn(async () => {})
    stubFetch(url => {
      if (!url.includes(TRANSFER_PATH)) return { body: {} }
      if (url.includes('action=preview')) {
        return { body: { accounts: [{ index: 0, uid: 'u1', nickname: 'New One', email: '', hasToken: true }], total: 1 } }
      }
      return { body: { imported: 1, skipped: 0 } }
    })
    const view = await mount(AccountTransfer, { t, region: 'cn', accounts: [], onChanged })
    await view.click(view.button('row.transferImport'))
    // The input lives in the section, not in a pre-dialog.
    const input = view.container.querySelector<HTMLInputElement>('input[type=file]')
    expect(input).not.toBeNull()
    // A picked file resolves through the preview, then the checkbox is on by
    // default for an entry with a token, so the confirm button can run.
    const file = new File(['[]'], 'accounts.json', { type: 'application/json' })
    Object.defineProperty(input!, 'files', { value: [file], configurable: true })
    await act(() => {
      input!.dispatchEvent(new window.Event('change', { bubbles: true }))
      return Promise.resolve()
    })
    await view.settle()
    expect(view.text()).toContain('New One')
    await view.click(view.button('row.transferImportConfirm'))
    await view.settle()
    expect(onChanged).toHaveBeenCalledTimes(1)
    await view.unmount()
  })
})
