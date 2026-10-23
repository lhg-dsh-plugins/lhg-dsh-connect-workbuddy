/**
 * Issue #77: the account list must not wait for billing.
 *
 * THE REPORT. After updating the plugin, opening the settings page took 30–60
 * seconds before any account appeared — on a machine where 4.6.7 showed them
 * instantly. The screenshot taken ~30 s in shows the SIGNED-OUT branch ("detect
 * accounts / scan to add"), which is what an absent document used to render as.
 *
 * THE CAUSE. The card painted nothing until ONE document landed, and that
 * document's tail awaited an upstream call per account: `poolMembersOf` fetched
 * credits for every member, `checkedInToday` fetched check-in for every account,
 * and the selected account paid its own two requests. Each has a 30-second
 * timeout and no retry (`JSON_TIMEOUT_MS` in src/upstream.ts), so a slow or
 * throttled upstream stacked them.
 *
 * THE FIX under test here: `detail=fast` answers from LOCAL state only — the
 * credential already on disk, the local pool roster and the already-measured
 * check-in cells — so the account table costs one local round trip. The full
 * document still follows and upgrades the live figures.
 *
 * These tests count CALLS on the dependencies rather than inspecting prose: the
 * whole point is that a first paint makes no upstream request at all, and a
 * future edit that reintroduces one must fail here.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerWorkBuddyStatusRoute } from '../src/web-status.ts'
import type { WorkBuddyPoolDeps, WorkBuddyStatusRouteOptions } from '../src/web-status.ts'
import {
  WORKBUDDY_DETAIL_FAST,
  WORKBUDDY_DETAIL_PARAM,
  WORKBUDDY_USAGE_PATH,
  fastDetailOf,
  withWorkBuddyRegionFastDetail,
} from '../src/status-paths.ts'

const NOW = Date.now()

const CREDENTIAL = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAtMs: NOW + 86_400_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-a',
  uin: '100000000001',
  nickname: 'Alpha',
  source: 'desktop' as const,
  filePath: '/tmp/a.info',
}

const ACCOUNTS = [{
  id: 'a',
  accountName: 'Alpha',
  domain: 'www.codebuddy.cn',
  source: 'desktop' as const,
  tokenExpiresAtMs: CREDENTIAL.expiresAtMs,
  filePath: CREDENTIAL.filePath,
  selected: true,
}]

interface StoreSpies {
  store: unknown
  current: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
}

/** A store double recording whether the first paint went through `resolve()`. */
function storeSpies(): StoreSpies {
  const current = vi.fn(async () => CREDENTIAL)
  const resolve = vi.fn(async () => CREDENTIAL)
  return {
    current,
    resolve,
    store: {
      accounts: async () => ACCOUNTS,
      current,
      resolve,
      credentialFor: async () => CREDENTIAL,
      selectionLost: async () => false,
      status: async () => ({ state: 'signed-in', expiresAtMs: CREDENTIAL.expiresAtMs }),
      hasExplicitSelection: () => true,
    },
  }
}

interface PoolSpies {
  pool: WorkBuddyPoolDeps
  members: ReturnType<typeof vi.fn>
  localMembers: ReturnType<typeof vi.fn>
  checkedInToday: ReturnType<typeof vi.fn>
  cachedCheckedInToday: ReturnType<typeof vi.fn>
  otherAccounts: ReturnType<typeof vi.fn>
}

/**
 * A pool double whose expensive and local sources are BOTH recorded, so a test
 * can assert which one a document used — and, for the first paint, that the
 * expensive one was never touched.
 */
function poolSpies(): PoolSpies {
  const members = vi.fn(async () => [{
    account: { id: 'a', accountName: 'Alpha' },
    credits: { total: 500, expiringSoon: 0 },
  }])
  const localMembers = vi.fn(async () => [
    { account: { id: 'a', accountName: 'Alpha' }, tokenExpiresAtMs: CREDENTIAL.expiresAtMs },
  ])
  const checkedInToday = vi.fn(async () => ({ a: true, b: false }))
  const cachedCheckedInToday = vi.fn(() => ({ a: true }))
  const otherAccounts = vi.fn(async () => [])
  const pool: WorkBuddyPoolDeps = {
    preferences: () => ({
      enabled: true,
      targetModelId: '',
      memberAccountIds: ['a'],
    }),
    members,
    localMembers,
    checkedInToday,
    cachedCheckedInToday,
    otherAccounts,
    catalog: () => [],
  }
  return { pool, members, localMembers, checkedInToday, cachedCheckedInToday, otherAccounts }
}

interface UpstreamSpies {
  fetchCredits: ReturnType<typeof vi.fn>
  fetchCheckinStatus: ReturnType<typeof vi.fn>
}

function deps(store: StoreSpies, pool: PoolSpies): WorkBuddyStatusRouteOptions {
  return {
    store: () => store.store as never,
    client: {
      fetchCredits: vi.fn(async () => ({ total: 500, packages: [], expiringSoon: 0 })),
      fetchCheckinStatus: vi.fn(async () => ({ active: true, todayCheckedIn: true }) as never),
      claimDailyCheckin: vi.fn(async () => ({ credit: 0, streakDays: 0, isStreakDay: false })),
      fetchBenefits: vi.fn(async () => []),
      claimBenefit: vi.fn(async () => undefined),
    },
    displayModels: () => [],
    enabledModelIds: () => [],
    imageModelIds: () => [],
    offModelIds: () => [],
    contextBudgets: () => ({}),
    regionEnabled: () => true,
    pool: pool.pool,
  }
}

/** Mount the routes against a fake web server and return the usage handler. */
async function mountUsage(options: WorkBuddyStatusRouteOptions): Promise<
  (req: { method: string, url: string, headers: Record<string, string> }, res: unknown) => Promise<void> | void
> {
  interface CapturedEntry {
    path: string
    handler: (req: unknown, res: unknown) => Promise<void> | void
  }
  const captured: CapturedEntry[] = []
  const FakeWebServer = {
    name: 'webServer',
    inject: [] as const,
    apply(ctx: Context) {
      ctx.provide('webServer', {
        register: (entry: unknown) => {
          captured.push(entry as CapturedEntry)
          return () => {}
        },
      })
    },
  }
  const ctx = new Context()
  await ctx.plugin(FakeWebServer)
  registerWorkBuddyStatusRoute(ctx, options)
  await ctx.fiber.dispose()
  const usage = captured.find(entry => entry.path === WORKBUDDY_USAGE_PATH)
  if (usage === undefined) throw new Error('usage route was not registered')
  return usage.handler as never
}

/** A response recorder: `body()` reads the single JSON document written. */
function response(): {
  res: { writeHead: (status: number, headers?: Record<string, string>) => void, end: (payload?: string) => void }
  status: () => number
  body: () => Record<string, unknown>
} {
  let statusCode = 0
  let written = ''
  return {
    res: {
      writeHead: (status: number) => { statusCode = status },
      end: (payload?: string) => { if (payload !== undefined) written = payload },
    },
    status: () => statusCode,
    body: () => JSON.parse(written) as Record<string, unknown>,
  }
}

function usageRequest(url: string): { method: string, url: string, headers: Record<string, string> } {
  return { method: 'GET', url, headers: {} }
}

type PoolBody = {
  accounts?: { accountId: string, accountName: string, credits?: number, checkedInToday?: boolean }[]
}

describe('the address helpers (detail=fast is opt-in and exact)', () => {
  it('appends the detail AFTER the region, so the region parser still works', () => {
    const url = withWorkBuddyRegionFastDetail(WORKBUDDY_USAGE_PATH, 'global')
    expect(url).toBe(`${WORKBUDDY_USAGE_PATH}?region=global&${WORKBUDDY_DETAIL_PARAM}=${WORKBUDDY_DETAIL_FAST}`)
    // The region helper is what the route's region parser reads; appending must
    // not disturb it.
    expect(new URLSearchParams(url.slice(url.indexOf('?'))).get('region')).toBe('global')
  })

  it('recognizes ONLY the exact fast value, so a typo degrades to the FULL document', () => {
    // The failure mode on the wrong side of this rule is an EMPTY panel, which
    // is the very thing #77 is about: an unrecognized value must never be read
    // as "give me the thinner document".
    expect(fastDetailOf(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=fast`)).toBe(true)
    expect(fastDetailOf(`${WORKBUDDY_USAGE_PATH}?detail=fast`)).toBe(true)
    expect(fastDetailOf(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=FAST`)).toBe(false)
    expect(fastDetailOf(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=fastest`)).toBe(false)
    expect(fastDetailOf(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=`)).toBe(false)
    expect(fastDetailOf(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=slow`)).toBe(false)
    expect(fastDetailOf(`${WORKBUDDY_USAGE_PATH}?region=cn`)).toBe(false)
    expect(fastDetailOf(WORKBUDDY_USAGE_PATH)).toBe(false)
    // A query string that is not `key=value` at all must not throw.
    expect(fastDetailOf(`${WORKBUDDY_USAGE_PATH}?region=cn#detail=fast`)).toBe(false)
  })
})

describe('the first-paint document (detail=fast)', () => {
  it('answers with the account table WITHOUT a single upstream request', async () => {
    const store = storeSpies()
    const pool = poolSpies()
    const options = deps(store, pool)
    const handler = await mountUsage(options)
    const { res, status, body } = response()
    await handler(usageRequest(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=fast`), res)
    expect(status()).toBe(200)
    const document = body()
    expect(document['status']).toBe('signed-in')
    // The rows the user came for: they live in the pool block, which is why a
    // fast document MUST carry one.
    const rows = (document['pool'] as PoolBody | undefined)?.accounts ?? []
    expect(rows.map(row => row.accountId)).toEqual(['a'])
    expect(rows[0]?.accountName).toBe('Alpha')
    // No billing read at all — not the per-member credits, not the per-account
    // check-in, not the selected account's own two.
    expect(options.client.fetchCredits).not.toHaveBeenCalled()
    expect(options.client.fetchCheckinStatus).not.toHaveBeenCalled()
    // And the pool used its LOCAL source: the expensive one is untouched.
    expect(pool.localMembers).toHaveBeenCalledWith('cn')
    expect(pool.members).not.toHaveBeenCalled()
    expect(pool.cachedCheckedInToday).toHaveBeenCalledWith('cn')
    expect(pool.checkedInToday).not.toHaveBeenCalled()
  })

  it('reads the credential already on disk instead of resolving (refreshing) it', async () => {
    // `resolve()` may refresh the token over the network. That is right for the
    // full document and wrong for the paint: no token refresh may decide when
    // the account list appears. An expired token is fine to paint with — the
    // full document that follows still validates it.
    const store = storeSpies()
    const pool = poolSpies()
    const handler = await mountUsage(deps(store, pool))
    const { res } = response()
    await handler(usageRequest(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=fast`), res)
    expect(store.current).toHaveBeenCalled()
    expect(store.resolve).not.toHaveBeenCalled()
  })

  it('still diagnoses a MISSING credential through resolve(), so no network is paid either way', async () => {
    // Without a local credential there is nothing to paint, and the resolve()
    // call is what classifies the signed-out state (path probe, no upstream
    // request). Skipping it would degrade the first paint's signed-out copy.
    const store = storeSpies()
    store.current.mockImplementation(async () => undefined as never)
    store.store = {
      ...(store.store as Record<string, unknown>),
      current: store.current,
      resolve: async () => { throw new Error('no local sign-in on this machine') },
    }
    const pool = poolSpies()
    const handler = await mountUsage(deps(store, pool))
    const { res, status, body } = response()
    await handler(usageRequest(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=fast`), res)
    expect(status()).toBe(200)
    expect(store.current).toHaveBeenCalled()
    expect(body()['status']).toBe('signed-out')
    expect(String(body()['message'])).toContain('no local sign-in')
  })

  it('reports check-in state from the measurement cache only', async () => {
    const store = storeSpies()
    const pool = poolSpies()
    pool.cachedCheckedInToday.mockImplementation(() => ({ a: true }) as never)
    const handler = await mountUsage(deps(store, pool))
    const { res, body } = response()
    await handler(usageRequest(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=fast`), res)
    const rows = (body()['pool'] as PoolBody | undefined)?.accounts ?? []
    // Measured: reported. Unmeasured accounts are simply absent, which the card
    // renders as unknown rather than as "not checked in".
    expect(rows[0]?.checkedInToday).toBe(true)
    expect(pool.checkedInToday).not.toHaveBeenCalled()
  })

  it('omits the pool block — rather than paying the expensive read — on a Host without a local source', async () => {
    // An older Host has no `localMembers`. The first paint must then ship no
    // pool block (the card renders no table and waits for the full document)
    // instead of falling back to the read that caused the 30–60 s wait.
    const store = storeSpies()
    const pool = poolSpies()
    const legacy: WorkBuddyPoolDeps = { ...pool.pool }
    delete legacy.localMembers
    const options = deps(store, pool)
    options.pool = legacy
    const handler = await mountUsage(options)
    const { res, status, body } = response()
    await handler(usageRequest(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=fast`), res)
    expect(status()).toBe(200)
    expect(body()['status']).toBe('signed-in')
    expect(body()['pool']).toBeUndefined()
    expect(pool.members, 'the first paint fell back to the expensive source').not.toHaveBeenCalled()
  })
})

describe('the full document is unchanged, and stays the default', () => {
  it('an absent detail parameter still calls the upstream and the expensive pool sources', async () => {
    const store = storeSpies()
    const pool = poolSpies()
    const options = deps(store, pool)
    const handler = await mountUsage(options)
    const { res, status } = response()
    await handler(usageRequest(`${WORKBUDDY_USAGE_PATH}?region=cn`), res)
    expect(status()).toBe(200)
    expect(options.client.fetchCredits).toHaveBeenCalled()
    expect(options.client.fetchCheckinStatus).toHaveBeenCalled()
    expect(store.resolve).toHaveBeenCalled()
    expect(pool.members).toHaveBeenCalledWith('cn')
    expect(pool.checkedInToday).toHaveBeenCalledWith('cn')
  })

  it('an unknown detail value is the FULL document, never a thinner one', async () => {
    for (const value of ['slow', 'FAST', 'fastest', '']) {
      const store = storeSpies()
      const pool = poolSpies()
      const options = deps(store, pool)
      const handler = await mountUsage(options)
      const { res } = response()
      await handler(usageRequest(`${WORKBUDDY_USAGE_PATH}?region=cn&detail=${value}`), res)
      expect(pool.members, `detail=${value} was treated as a first paint`).toHaveBeenCalledWith('cn')
      expect(pool.localMembers).not.toHaveBeenCalled()
    }
  })
})
