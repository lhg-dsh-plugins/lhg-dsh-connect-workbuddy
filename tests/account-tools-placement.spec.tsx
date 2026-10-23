// @vitest-environment jsdom
/**
 * WHERE the account tools sit, and that they no longer repeat themselves.
 *
 * Two user-visible complaints, both about the same block:
 *
 *   1. The rows were captioned AND labelled: 「扫码添加账号」 above a 「扫码登录」
 *      button, 「导出 / 导入账号」 above 「导出账号」「导入账号」. A one-button
 *      section does not need a caption naming that button — the button says it.
 *      The captions are gone; the section keeps an `aria-label` for screen
 *      readers (pinned in oauth-wording.spec.tsx).
 *
 *   2. The block lived INSIDE 「更多设置」, directly under its heading — and that
 *      heading's note says 「点保存才生效」. Sign-in and import do not wait for a
 *      save; they act at once. A control that commits immediately must not sit
 *      inside a block that promises otherwise, or the user waits for a button
 *      they never needed. The block now sits ABOVE the heading.
 *
 * Both are DOM facts, so both are asserted on a real render: 「above」 is the
 * document-order relation between the tools box and the heading, not a comment
 * in the source. That is the assertion a re-nesting edit cannot accidentally
 * satisfy.
 */
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountPool } from '../src/client/AccountPool.tsx'
import { AccountTransfer } from '../src/client/AccountTransfer.tsx'
import { OAuthSignIn } from '../src/client/OAuthSignIn.tsx'
import { accountOf, fakeScope, mount, poolOf, stubFetch, t } from './pool-render-helpers.tsx'

afterEach(() => { vi.unstubAllGlobals() })

const ACCOUNT = accountOf({ accountId: 'real-1', accountName: 'Real One', current: true })

/** The tools exactly as WorkBuddyCard assembles them. */
const accountTools = React.createElement(React.Fragment, null,
  React.createElement(OAuthSignIn, { t, region: 'cn' }),
  React.createElement(AccountTransfer, { t, region: 'cn', accounts: [ACCOUNT] }),
)

function props(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t,
    region: 'cn',
    settingsScope: fakeScope({}),
    pool: poolOf({
      memberAccountIds: ['real-1'],
      effectiveMemberAccountIds: ['real-1'],
      accounts: [ACCOUNT],
    }),
    accountTools,
    ...overrides,
  }
}

/**
 * Query a node that the test is meaningless without.
 *
 * `expect(node).not.toBeNull()` does not narrow the type, so every later use
 * would need a non-null assertion and a null here would surface as a confusing
 * "cannot read properties of null" instead of naming the node that went missing.
 */
function must<T extends Element>(node: T | null, what: string): T {
  if (node === null) throw new Error(`${what} was not rendered`)
  return node
}

describe('the account tools sit above the settings block, without captions', () => {
  it('renders the tools BEFORE the 更多设置 heading and its rows', async () => {
    stubFetch(() => ({ body: {} }))
    const view = await mount(AccountPool, props())
    const tools = must(view.container.querySelector('.dsm-workbuddy-pool-tools'), 'the tools box')
    const heading = must(view.container.querySelector('.dsm-workbuddy-pool-card-title'), 'the settings heading')
    // 「above」 has to mean document order, not the source order of two siblings
    // that a later edit could swap back.
    expect(tools.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    await view.unmount()
  })

  it('keeps the tools outside the save-gated settings block', async () => {
    stubFetch(() => ({ body: {} }))
    const view = await mount(AccountPool, props())
    const tools = must(view.container.querySelector('.dsm-workbuddy-pool-tools'), 'the tools box')
    // `closest` walks ANCESTORS, so this catches any re-nesting — including one
    // that keeps the tools above the rows but still inside the bordered block
    // whose note promises 「点保存才生效」. That promise is the reason for the move.
    expect(tools.closest('.dsm-workbuddy-pool-settings')).toBeNull()
    // It still lives in the same wrapper as the block it labels, so the two stay
    // one visual group rather than drifting apart.
    expect(tools.parentElement?.className).toContain('dsm-workbuddy-pool-settings-wrap')
    await view.unmount()
  })

  it('draws no caption line for either group', async () => {
    stubFetch(() => ({ body: {} }))
    const view = await mount(AccountPool, props())
    // The class the captions used. Absent from the DOM, not merely empty: an
    // emptied <p> would still cost the line of height the removal was for.
    expect(view.container.querySelector('.dsm-workbuddy-bar-label')).toBeNull()
    // The buttons themselves are what names the rows now.
    expect(view.text()).toContain('row.oauthStart')
    expect(view.text()).toContain('row.transferExport')
    expect(view.text()).toContain('row.transferImport')
    // And no visible text repeats them: the titles survive only as aria-labels,
    // so they must not appear in textContent at all.
    expect(view.text()).not.toContain('row.oauthTitle')
    expect(view.text()).not.toContain('row.transferTitle')
    await view.unmount()
  })

  it('leaves the panel unchanged when the card supplies no tools', async () => {
    // The signed-out card renders the tools itself, in its own container; the
    // pool panel must not invent an empty dashed box in that case.
    stubFetch(() => ({ body: {} }))
    const view = await mount(AccountPool, props({ accountTools: undefined }))
    expect(view.container.querySelector('.dsm-workbuddy-pool-tools')).toBeNull()
    expect(view.container.querySelector('.dsm-workbuddy-pool-card-title')).not.toBeNull()
    // The heading is still there and the tools are simply absent, not moved
    // somewhere else in the panel.
    expect(view.text()).not.toContain('row.oauthStart')
    await view.unmount()
  })
})
