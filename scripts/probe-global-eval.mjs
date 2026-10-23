#!/usr/bin/env node
/**
 * Read-only evaluation probe: does the WorkBuddy GLOBAL upstream
 * (www.workbuddy.ai) implement the same three plugin-owned read-only
 * endpoints as the CN upstream?
 *
 *   1. GET  /v2/enterprises/personal/models     (global model catalog — the
 *      CN path /console/enterprises/personal/models returns HTTP 500 on
 *      www.workbuddy.ai; the correct global path was extracted from the
 *      WorkBuddy AI.app bundle, main/server.js listAvailableModels)
 *   2. POST /v2/billing/meter/get-user-resource    (credits; ProductCode p_tcaca)
 *   3. POST /v2/billing/meter/checkin-activity-status (daily check-in status)
 *
 * Never calls chat (consumes credits) and never calls token refresh
 * (mutates the desktop session). Token material is never printed.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH = join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info')
const GLOBAL_BASE = 'https://www.workbuddy.ai'
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

function redact(text) {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .slice(0, 600)
}

/** Summarize a JSON document's shape without dumping long values. */
function shape(value, key = '', depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.slice(0, depth > 2 ? 1 : 3).map(item => shape(item, key, depth + 1))
    return `[${value.length}] ${JSON.stringify(items)}${value.length > 3 ? ' …' : ''}`
  }
  if (typeof value === 'object') {
    if (depth > 3) return '{…}'
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = shape(v, k, depth + 1)
    return out
  }
  if (typeof value === 'string') {
    if (/token|secret/i.test(key)) return `<redacted len=${value.length}>`
    if (value.length > 60) return `<str len=${value.length}>`
    return value
  }
  return value
}

async function main() {
  const doc = JSON.parse(await readFile(AUTH, 'utf8'))
  const auth = doc.auth ?? doc
  const account = doc.account ?? {}
  const credential = {
    accessToken: auth.accessToken,
    uid: account.uid ?? '',
    domain: auth.domain ?? '',
    enterpriseId: account.enterpriseId,
  }
  process.stdout.write(`domain  : ${credential.domain} (expect www.workbuddy.ai)\n`)
  process.stdout.write(`nickname: ${account.nickname ?? '(none)'}\n\n`)

  // --- 1. Model catalog: global uses /v2/..., CN uses /console/... ---
  for (const [label, path] of [['global path', '/v2/enterprises/personal/models'], ['cn path (expect 500)', '/console/enterprises/personal/models']]) {
  process.stdout.write(`===== 1. GET ${path} (${label}) =====\n`)
  try {
    const response = await fetch(`${GLOBAL_BASE}${path}`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Origin': GLOBAL_BASE,
        'Referer': `${GLOBAL_BASE}/`,
        'User-Agent': CLIENT_UA,
      },
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    process.stdout.write(`HTTP ${response.status}\n`)
    try {
      const envelope = JSON.parse(text)
      process.stdout.write(`envelope.code = ${JSON.stringify(envelope.code)}\n`)
      const data = envelope.data ?? {}
      const models = Array.isArray(data.models) ? data.models : []
      const agents = Array.isArray(data.agents) ? data.agents : []
      process.stdout.write(`models  : ${models.length}\n`)
      if (models.length > 0) {
        process.stdout.write(`model[0] keys: ${Object.keys(models[0]).join(', ')}\n`)
        process.stdout.write(`model[0] shape: ${JSON.stringify(shape(models[0]), null, 0)}\n`)
        const ids = models.map(m => m.id).filter(Boolean)
        process.stdout.write(`model ids: ${ids.join(', ')}\n`)
      }
      process.stdout.write(`agents  : ${JSON.stringify(agents.map(a => ({ name: a.name, count: Array.isArray(a.models) ? a.models.length : 0 })))}\n`)
    } catch {
      process.stdout.write(`non-JSON body: ${redact(text)}\n`)
    }
  } catch (error) {
    process.stdout.write(`transport error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.stdout.write('\n')
  }

  // --- 2. Credits, exactly as the plugin sends it ---
  process.stdout.write('\n===== 2. POST /v2/billing/meter/get-user-resource =====\n')
  const now = new Date()
  const format = (date) => [
    date.getFullYear().toString().padStart(4, '0'),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0'),
  ].join('-') + ' ' + [
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
    date.getSeconds().toString().padStart(2, '0'),
  ].join(':')
  try {
    const response = await fetch(`${GLOBAL_BASE}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(credential.uid !== '' ? { 'X-User-Id': credential.uid } : {}),
        ...(credential.enterpriseId ? { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId } : {}),
        ...(credential.domain !== '' ? { 'X-Domain': credential.domain } : {}),
      },
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    process.stdout.write(`HTTP ${response.status}\n`)
    try {
      const envelope = JSON.parse(text)
      process.stdout.write(`envelope.code = ${JSON.stringify(envelope.code)}\n`)
      process.stdout.write(`shape: ${JSON.stringify(shape(envelope.data), null, 1)}\n`)
    } catch {
      process.stdout.write(`non-JSON body: ${redact(text)}\n`)
    }
  } catch (error) {
    process.stdout.write(`transport error: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  // --- 3. Check-in status, exactly as the plugin sends it ---
  process.stdout.write('\n===== 3. POST /v2/billing/meter/checkin-activity-status =====\n')
  try {
    const response = await fetch(`${GLOBAL_BASE}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(credential.uid !== '' ? { 'X-User-Id': credential.uid } : {}),
        ...(credential.enterpriseId ? { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId } : {}),
        ...(credential.domain !== '' ? { 'X-Domain': credential.domain } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    process.stdout.write(`HTTP ${response.status}\n`)
    process.stdout.write(`body: ${redact(text).replace(/\s+/gu, ' ')}\n`)
  } catch (error) {
    process.stdout.write(`transport error: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
