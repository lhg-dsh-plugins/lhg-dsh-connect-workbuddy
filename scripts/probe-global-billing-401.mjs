#!/usr/bin/env node
/**
 * READ-ONLY probe for the reported international-account billing 401
 * (issue #4: "国际版 codebuddy.ai 账号积分查询返回 401").
 *
 * Purpose: establish WHICH credential domain an international account really
 * carries, and — given that domain — reproduce the plugin's exact request
 * construction so the failure can be attributed to a specific layer:
 *
 *   A. does `auth.domain` ever equal `codebuddy.ai`?          (issue's premise)
 *   B. does the plugin's region routing pick the intended host?
 *   C. if a 401 appears, which header/route combination causes it?
 *
 * SAFETY / READ-ONLY CONTRACT
 *   - Reads local auth files only; never writes, never refreshes a token.
 *   - Only issues read-only endpoints:
 *       POST /v2/billing/meter/get-user-resource        (query)
 *       POST /v2/billing/meter/checkin-activity-status  (query)
 *       GET  /v2/enterprises/personal/models            (catalog)
 *   - NEVER calls /daily-checkin or any mutating endpoint.
 *   - No credential material is printed: tokens are shown as a length + a
 *     short SHA-256 fingerprint only.
 *
 * Usage:
 *   node scripts/probe-global-billing-401.mjs               # all credentials
 *   node scripts/probe-global-billing-401.mjs --global-only # international only
 *   node scripts/probe-global-billing-401.mjs --json        # machine-readable
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH_DIR = join(
  homedir(),
  'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth',
)

const TIMEOUT_MS = 30_000
const BODY_LIMIT = 400

// ---------------------------------------------------------------------------
// Mirrors src/upstream.ts regionOf / chatBase / billingBase / originReferer
// ---------------------------------------------------------------------------

/** Verbatim copy of the shipped `regionOf` (src/upstream.ts:210). */
function regionOf(domain) {
  const lowered = (domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** Verbatim copy of the shipped `globalBase` (src/upstream.ts:226). */
function globalBase(domain) {
  const lowered = (domain ?? '').trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

const chatBase = cred => (regionOf(cred.domain) === 'global' ? globalBase(cred.domain) : CN_CHAT_BASE)
const billingBase = cred => (regionOf(cred.domain) === 'global' ? globalBase(cred.domain) : CN_BILLING_BASE)
const originReferer = cred => (regionOf(cred.domain) === 'global' ? globalBase(cred.domain) : CN_BILLING_BASE)

/** Verbatim copy of shipped `billingHeaders` (src/upstream.ts:258). */
function billingHeaders(cred) {
  const headers = {
    'Authorization': `Bearer ${cred.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (cred.uid !== '') headers['X-User-Id'] = cred.uid
  if (cred.enterpriseId !== undefined && cred.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = cred.enterpriseId
    headers['X-Tenant-Id'] = cred.enterpriseId
  }
  if (cred.domain !== '') headers['X-Domain'] = cred.domain
  return headers
}

/** Verbatim copy of shipped `commonHeaders` (src/upstream.ts:218), for contrast. */
function commonHeaders(cred) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(cred),
    'Referer': `${originReferer(cred)}/`,
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
  }
}

// ---------------------------------------------------------------------------
// Auth-file handling
// ---------------------------------------------------------------------------

function fingerprint(token) {
  return `${String(token).length} chars sha256:${createHash('sha256').update(String(token)).digest('hex').slice(0, 12)}`
}

/** Parse both on-disk shapes; mirrors src/auth.ts parseWorkBuddyAuth. */
function parseAuth(text, filePath) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined
  const auth = typeof doc.auth === 'object' && doc.auth !== null ? doc.auth : doc
  const account = typeof doc.account === 'object' && doc.account !== null ? doc.account : auth
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const str = v => (typeof v === 'string' && v !== '' ? v : undefined)
  return {
    filePath,
    fileName: filePath.split('/').pop(),
    accessToken,
    domain: str(auth.domain) ?? '',
    uid: str(account.uid) ?? '',
    enterpriseId: str(account.enterpriseId),
    nickname: str(account.nickname),
    uin: str(account.uin),
  }
}

async function loadCredentials() {
  const names = await readdir(AUTH_DIR)
  const out = []
  for (const name of names.filter(n => n.endsWith('.info'))) {
    const filePath = join(AUTH_DIR, name)
    try {
      const parsed = parseAuth(await readFile(filePath, 'utf8'), filePath)
      if (parsed) out.push(parsed)
    } catch {
      /* unreadable file: skip */
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function probe(url, init) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    const isHtml = /<html|<!doctype/i.test(text)
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return {
      status: response.status,
      ok: response.ok,
      contentType,
      isHtml,
      isJson: json !== undefined,
      code: json?.code,
      message: json?.msg ?? json?.message,
      excerpt: text.slice(0, BODY_LIMIT).replace(/\s+/g, ' ').trim(),
    }
  } catch (error) {
    return { status: 0, ok: false, error: String(error?.message ?? error) }
  }
}

const CREDITS_BODY = JSON.stringify({ PageNumber: 1, PageSize: 20, ProductCode: 'p_tcaca', Status: [0, 3] })

/** All read-only endpoints the plugin touches for credit/check-in display. */
function readOnlyCalls(cred) {
  const billing = billingBase(cred)
  const chat = chatBase(cred)
  return [
    {
      label: 'billing get-user-resource',
      layer: 'billing',
      url: `${billing}/v2/billing/meter/get-user-resource`,
      init: { method: 'POST', headers: billingHeaders(cred), body: CREDITS_BODY },
    },
    {
      label: 'billing checkin-status',
      layer: 'billing',
      url: `${billing}/v2/billing/meter/checkin-activity-status`,
      init: { method: 'POST', headers: billingHeaders(cred), body: '{}' },
    },
    {
      label: 'chat models catalog',
      layer: 'chat',
      url: `${chat}/v2/enterprises/personal/models`,
      init: {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${cred.accessToken}`,
          'Accept': 'application/json',
          'Origin': originReferer(cred),
          'Referer': `${originReferer(cred)}/`,
          'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
        },
      },
    },
  ]
}

/**
 * Cross-check: run the SAME billing path against BOTH hosts, regardless of
 * what regionOf decided. This is what localizes a 401 — if the intended host
 * fails but the other host answers, the fault is routing; if both fail the
 * same way, the fault is auth/headers, not routing.
 */
function crossHostCalls(cred) {
  const creditsInit = () => ({
    method: 'POST',
    headers: { ...billingHeaders(cred) },
    body: CREDITS_BODY,
  })
  return [
    {
      label: 'get-user-resource @ workbuddy.ai (global gateway)',
      url: `${GLOBAL_BASE}/v2/billing/meter/get-user-resource`,
      init: creditsInit(),
    },
    {
      label: 'get-user-resource @ codebuddy.cn (CN gateway)',
      url: `${CN_BILLING_BASE}/v2/billing/meter/get-user-resource`,
      init: creditsInit(),
    },
    {
      label: 'get-user-resource @ codebuddy.ai (issue premise host)',
      url: `https://www.codebuddy.ai/v2/billing/meter/get-user-resource`,
      init: creditsInit(),
    },
  ]
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' }

function verdict(result) {
  if (result.error) return `${C.yellow}NETWORK ERROR${C.off} ${result.error}`
  if (result.status === 401) return `${C.red}401${C.off}${result.isHtml ? ' (openresty HTML — gateway-layer rejection)' : ''}`
  if (!result.ok) return `${C.red}${result.status}${C.off}${result.code !== undefined ? ` code=${result.code}` : ''}`
  if (result.isJson && result.code !== undefined && result.code !== 0) return `${C.yellow}HTTP ${result.status} code=${result.code}${C.off}`
  return `${C.green}${result.status} OK${C.off}`
}

async function main() {
  const argv = new Set(process.argv.slice(2))
  const globalOnly = argv.has('--global-only')
  const asJson = argv.has('--json')

  const all = await loadCredentials()
  const creds = globalOnly ? all.filter(c => regionOf(c.domain) === 'global') : all

  if (creds.length === 0) {
    process.stderr.write(`No credentials found under ${AUTH_DIR}\n`)
    process.exitCode = 1
    return
  }

  // ---- Premise A: does `codebuddy.ai` ever appear as a credential domain? ----
  const domains = new Map()
  for (const cred of all) domains.set(cred.domain, (domains.get(cred.domain) ?? 0) + 1)
  const codebuddyAiCreds = all.filter(c => c.domain.toLowerCase().includes('codebuddy.ai'))

  if (!asJson) {
    process.stdout.write(`\n${C.bold}=== A. Credential domains actually present on this machine ===${C.off}\n`)
    process.stdout.write(`auth dir: ${AUTH_DIR}\n`)
    process.stdout.write(`files scanned: ${all.length}\n`)
    for (const [domain, count] of [...domains].sort((a, b) => b[1] - a[1])) {
      const region = regionOf(domain)
      process.stdout.write(`  ${String(count).padStart(2)}x  ${String(domain || '(empty)').padEnd(22)} -> regionOf()=${region}\n`)
    }
    process.stdout.write(
      codebuddyAiCreds.length === 0
        ? `${C.yellow}PREMISE A: not observed here${C.off} — no credential under this auth dir carries a codebuddy.ai domain. NOTE: the desktop app signs in at workbuddy.ai; a CodeBuddy CLI login writes codebuddy.ai, so an empty result only means THIS machine has no CLI login.\n`
        : `${C.green}PREMISE A: HOLDS${C.off} — ${codebuddyAiCreds.length} credential(s) carry codebuddy.ai (now classified global by regionOf).\n`,
    )
  }

  const report = { authDir: AUTH_DIR, fileCount: all.length, domains: Object.fromEntries(domains), credentials: [] }

  for (const cred of creds) {
    const region = regionOf(cred.domain)
    const entry = {
      fileName: cred.fileName,
      domain: cred.domain,
      region,
      uid: cred.uid,
      nickname: cred.nickname,
      enterpriseId: cred.enterpriseId ?? null,
      tokenFingerprint: fingerprint(cred.accessToken),
      calls: [],
      crossHost: [],
    }

    if (!asJson) {
      process.stdout.write(`\n${C.bold}=== ${cred.fileName} ===${C.off}\n`)
      process.stdout.write(`  domain=${cred.domain || '(empty)'}  regionOf()=${C.bold}${region}${C.off}  nickname=${cred.nickname ?? '?'}\n`)
      process.stdout.write(`  uid=${cred.uid || '(empty)'}  enterpriseId=${cred.enterpriseId ?? '(absent)'}\n`)
      process.stdout.write(`  token=${entry.tokenFingerprint}\n`)
      process.stdout.write(`  ${C.dim}chatBase=${chatBase(cred)}  billingBase=${billingBase(cred)}${C.off}\n`)
    }

    for (const call of readOnlyCalls(cred)) {
      const result = await probe(call.url, call.init)
      entry.calls.push({ label: call.label, url: call.url, status: result.status, code: result.code, isHtml: result.isHtml, excerpt: result.excerpt })
      if (!asJson) {
        process.stdout.write(`  [${call.layer}] ${call.label.padEnd(26)} ${verdict(result)}\n`)
        process.stdout.write(`         ${C.dim}${call.url}${C.off}\n`)
      }
      // The issue's exact symptom: HTML 401 from an openresty gateway.
      if (result.status === 401 && result.isHtml) {
        if (!asJson) process.stdout.write(`         ${C.red}^^ matches the reported symptom (HTTP 401, openresty HTML)${C.off}\n`)
      }
    }

    // Cross-host only matters when something actually failed.
    const anyFailure = entry.calls.some(c => c.status === 0 || c.status >= 400)
    if (anyFailure) {
      if (!asJson) process.stdout.write(`  ${C.dim}-- cross-host isolation --${C.off}\n`)
      for (const call of crossHostCalls(cred)) {
        const result = await probe(call.url, call.init)
        entry.crossHost.push({ label: call.label, status: result.status, code: result.code, isHtml: result.isHtml, excerpt: result.excerpt })
        if (!asJson) process.stdout.write(`     ${call.label.padEnd(50)} ${verdict(result)}\n`)
      }
    }

    report.credentials.push(entry)
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`\n${C.bold}=== SUMMARY ===${C.off}\n`)
    const failing = report.credentials.flatMap(c => c.calls.filter(x => x.status === 0 || x.status >= 400).map(x => ({ ...x, domain: c.domain })))
    const html401 = failing.filter(f => f.status === 401 && f.isHtml)
    process.stdout.write(`credentials probed      : ${report.credentials.length}\n`)
    process.stdout.write(`failing read-only calls : ${failing.length}\n`)
    process.stdout.write(`openresty HTML 401s     : ${html401.length}\n`)
    if (html401.length === 0) {
      process.stdout.write(`${C.green}No openresty 401 reproduced on any read-only endpoint.${C.off}\n`)
    } else {
      process.stdout.write(`${C.red}Reproduced on:${C.off}\n`)
      for (const f of html401) process.stdout.write(`  - ${f.domain} :: ${f.label} -> ${f.url}\n`)
    }
    process.stdout.write(`\n${C.dim}(read-only: no token refresh, no check-in claim, no state mutation)${C.off}\n`)
  }
}

await main()
