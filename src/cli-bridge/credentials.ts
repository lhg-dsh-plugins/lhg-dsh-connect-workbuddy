/**
 * Which sign-in the bridged CLI should run under.
 *
 * The vault is already the plugin's source of truth, so the bridge reads it
 * through the same region-scoped stores the provider uses rather than looking
 * for credential files a second time. That matters because the two regions are
 * NOT interchangeable: a `www.workbuddy.ai` (global) token is refused with 401
 * by the `copilot.tencent.com` endpoint the domestic CLI build targets.
 *
 * Ordering therefore goes region-first, freshness-second — never freshness
 * alone. Ranking purely by expiry picks whichever file claims the latest date,
 * and the field is not trustworthy: when the upstream revokes a token it leaves
 * `expiresAt` untouched, so a long-dead backup can outrank the live sign-in.
 * `tokenExpiresAtMs` is still used to sort WITHIN a region (it is the only
 * per-account number the store exposes), but it never reorders the regions.
 *
 * @module dsh-connect-workbuddy/cli-bridge/credentials
 */
import type { BridgeCredential } from './runner.ts'

/** The part of a region-scoped credential store the bridge reads. */
export interface BridgeCredentialStore {
  accounts(): Promise<readonly BridgeAccountSummary[]>
  credentialFor(accountId: string): Promise<BridgeStoredCredential | undefined>
}

/** One row of `store.accounts()`, narrowed to what ordering needs. */
export interface BridgeAccountSummary {
  id: string
  tokenExpiresAtMs: number
}

/** One row of `store.credentialFor()`, narrowed to what the CLI needs. */
export interface BridgeStoredCredential {
  accessToken: string
  expiresAtMs: number
}

/** A region and the store that owns its accounts. */
export interface BridgeCredentialRegion {
  region: string
  store: BridgeCredentialStore
}

/** Environment variable that short-circuits the vault entirely. */
export const AUTH_TOKEN_ENV = 'CODEBUDDY_AUTH_TOKEN'

/**
 * Walk the vault in region order and return every usable token, best first.
 *
 * Expired tokens are kept, at the end of their region: `expiresAt` is a claim
 * the upstream does not maintain, and a token that "expired" yesterday is
 * routinely still accepted. Refusing it locally would turn a working sign-in
 * into "not signed in".
 *
 * @throws when nothing at all is available — the caller reports that as a turn
 *   that never started, not as a CLI failure.
 */
export async function resolveCredentials(
  regions: readonly BridgeCredentialRegion[],
  regionOrder: readonly string[],
  log: (message: string) => void,
): Promise<BridgeCredential[]> {
  const fromEnv = process.env[AUTH_TOKEN_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return [{ token: fromEnv.trim(), source: AUTH_TOKEN_ENV, region: 'env', expired: false }]
  }

  const out: BridgeCredential[] = []
  const ordered = [...regions].sort((left, right) => rank(regionOrder, left.region) - rank(regionOrder, right.region))

  for (const { region, store } of ordered) {
    let accounts: readonly BridgeAccountSummary[]
    try {
      accounts = await store.accounts()
    } catch (error) {
      log(`reading the ${region} vault failed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const ranked = [...accounts].sort((left, right) => right.tokenExpiresAtMs - left.tokenExpiresAtMs)
    for (const account of ranked) {
      const credential = await store.credentialFor(account.id)
      if (credential === undefined || credential.accessToken === '') continue
      out.push({
        token: credential.accessToken,
        source: `${region} 账号 ${account.id.slice(0, 6)}`,
        region,
        expired: credential.expiresAtMs > 0 && credential.expiresAtMs <= Date.now(),
      })
    }
  }

  if (out.length === 0) {
    throw new Error(
      '没有可用的 WorkBuddy 登录凭据：插件配置里没读到你登录过的账号。' +
        `先在 WorkBuddy / CodeBuddy 里登录，或设置环境变量 ${AUTH_TOKEN_ENV}。`,
    )
  }
  return out
}

/** Position of a region in the preference list; unknown regions sort last. */
function rank(order: readonly string[], region: string): number {
  const index = order.indexOf(region)
  return index === -1 ? order.length : index
}
