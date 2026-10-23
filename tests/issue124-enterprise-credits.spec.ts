/**
 * Issue #124: enterprise (`type: ultimate`) accounts reported zero credits and
 * displayed their login alias as if it were a person's name.
 *
 * TWO SEPARATE DEFECTS, both about reading the wrong field:
 *
 *   1. BALANCE. `/v2/billing/meter/get-user-resource` answers an enterprise
 *      member with HTTP 200 and an EMPTY `Accounts` list — a legally-shaped
 *      "you have nothing" that is simply false. The member's credits live in
 *      the enterprise table, `/billing/meter/get-enterprise-user-usage`, whose
 *      `credit` field is the amount SPENT, not what remains: the balance is
 *      `limitNum - credit`. Reading `credit` as a balance inverts the answer.
 *   2. NAME. `nickname` on an enterprise credential is the LOGIN ALIAS, so the
 *      card showed something that looked like a stranger's account.
 *
 * The fixtures are the shapes reported on #124 (a live enterprise account), not
 * invented ones: `{credit: 1234, limitNum: 5000, cycleResetTime: ...}` and a
 * credential carrying both `nickname` (the alias) and `displayName`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeCredentialDisplayNames, preferredAccountName } from '../src/auth.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

describe('the account name prefers a real name over the login alias (issue #124)', () => {
  it('uses displayName when the app published one', () => {
    expect(preferredAccountName({
      displayName: '张三',
      enterpriseUserName: 'zhangsan',
      nickname: 'zhangsan@corp',
    })).toBe('张三')
  })

  it('falls back to the enterprise user name before the alias', () => {
    expect(preferredAccountName({
      enterpriseUserName: 'zhangsan',
      nickname: 'zhangsan@corp',
    })).toBe('zhangsan')
  })

  it('falls back to the alias when nothing better exists', () => {
    expect(preferredAccountName({ nickname: 'LaoDing' })).toBe('LaoDing')
  })

  it('reports an empty name rather than an identifier', () => {
    expect(preferredAccountName({})).toBe('')
  })

  it('ignores blank spellings instead of preferring them', () => {
    expect(preferredAccountName({ displayName: '   ', nickname: 'alias' })).toBe('alias')
  })
})

describe('credential display names survive a re-read (issue #124)', () => {
  it('keeps the display name when a later read omits it', () => {
    const merged = mergeCredentialDisplayNames(
      { nickname: 'alias', displayName: '张三' },
      { nickname: 'alias' },
    )
    expect(merged.displayName).toBe('张三')
  })

  it('takes the newer value when both read it', () => {
    const merged = mergeCredentialDisplayNames(
      { displayName: '张三' },
      { displayName: '李四' },
    )
    expect(merged.displayName).toBe('李四')
  })

  it('adds the enterprise user name when only the older read had it', () => {
    const merged = mergeCredentialDisplayNames(
      { enterpriseUserName: 'zhangsan' },
      { nickname: 'alias' },
    )
    expect(merged.enterpriseUserName).toBe('zhangsan')
    expect(merged.nickname).toBe('alias')
  })
})

describe('an enterprise account reads the enterprise credit table (issue #124)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /** A credential that belongs to an enterprise. */
  function enterpriseCredential(): WorkBuddyCredential {
    return {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAtMs: 0,
      domain: 'www.codebuddy.cn',
      uid: 'u',
      enterpriseId: 'ent-1',
      source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    }
  }

  /** Record every URL fetched, and answer per-path. */
  function stub(paths: Record<string, unknown>): string[] {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: any) => {
      const target = String(url)
      seen.push(target)
      for (const [part, body] of Object.entries(paths)) {
        if (target.includes(part)) {
          return {
            ok: true,
            status: 200,
            json: async () => body,
            text: async () => JSON.stringify(body),
          } as unknown as Response
        }
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response
    })
    return seen
  }

  it('asks the enterprise table instead of the personal one', async () => {
    const seen = stub({
      '/billing/meter/get-enterprise-user-usage': {
        code: 0, msg: 'OK',
        data: { credit: 1234, limitNum: 5000, cycleResetTime: '2026-11-01 00:00:00' },
      },
      '/v2/billing/meter/get-user-resource': {
        code: 0, msg: 'OK', data: { Response: { Data: { Accounts: [] } } },
      },
    })
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(enterpriseCredential())
    expect(seen.some(url => url.includes('/billing/meter/get-enterprise-user-usage'))).toBe(true)
    expect(seen.some(url => url.includes('/v2/billing/meter/get-user-resource'))).toBe(false)
    // `credit` is what was SPENT: the balance is limitNum - credit.
    expect(credits.total).toBe(3766)
    expect(credits.packages).toHaveLength(1)
    expect(credits.packages[0]?.size).toBe(5000)
  })

  it('never reports a fully spent allowance as a negative balance', async () => {
    stub({
      '/billing/meter/get-enterprise-user-usage': {
        code: 0, msg: 'OK', data: { credit: 5000, limitNum: 5000 },
      },
    })
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(enterpriseCredential())
    expect(credits.total).toBe(0)
  })

  it('reads the payload when it arrives under Data', async () => {
    stub({
      '/billing/meter/get-enterprise-user-usage': {
        code: 0, msg: 'OK', data: { Data: { credit: 100, limitNum: 900 } },
      },
    })
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(enterpriseCredential())
    expect(credits.total).toBe(800)
  })

  it('fails rather than claiming zero when the answer has no balance', async () => {
    stub({
      '/billing/meter/get-enterprise-user-usage': { code: 0, msg: 'OK', data: {} },
    })
    // A made-up `total: 0` on a funded account is the exact symptom #124
    // reports, so an unreadable answer must surface as a failure.
    await expect(new WorkBuddyUpstreamClient().fetchCredits(enterpriseCredential()))
      .rejects.toThrow(/no readable balance/)
  })

  it('reads cycleResetTime as the monthly refresh point', async () => {
    stub({
      '/billing/meter/get-enterprise-user-usage': {
        code: 0, msg: 'OK',
        data: { credit: 0, limitNum: 100, cycleResetTime: '2026-11-01 00:00:00' },
      },
    })
    const credits = await new WorkBuddyUpstreamClient().fetchCredits(enterpriseCredential())
    expect(credits.packages[0]?.monthly).toBe(true)
    expect(credits.packages[0]?.refreshAtMs).toBe(new Date(2026, 10, 1, 0, 0, 0).getTime())
  })

  it('still uses the personal table for a non-enterprise credential', async () => {
    const seen = stub({
      '/v2/billing/meter/get-user-resource': {
        code: 0, msg: 'OK',
        data: { Response: { Data: { Accounts: [{
          PackageName: 'p', CapacityType: 4,
          CycleCapacityRemain: 500, CycleCapacitySize: 500,
          CapacityRemain: 500, CapacitySize: 500,
        }] } } },
      },
    })
    const credits = await new WorkBuddyUpstreamClient().fetchCredits({
      accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
      domain: 'www.codebuddy.cn', uid: 'u', source: 'desktop',
      filePath: '/tmp/workbuddy-desktop.info',
    })
    expect(credits.total).toBe(500)
    expect(seen.some(url => url.includes('/billing/meter/get-enterprise-user-usage'))).toBe(false)
  })
})
