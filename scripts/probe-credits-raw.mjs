#!/usr/bin/env node
/**
 * Dump the WorkBuddy billing response VERBATIM, to decide what a credit balance
 * actually is (issue #58).
 *
 * The card's number is a SUM the plugin computes over `Accounts[]`. The official
 * client shows a number that does not always match it, and the candidate causes
 * are all visible in this one response:
 *
 *   1. `CapacityRemain` may be the package's CAP rather than its remaining —
 *      decidable by comparing it with `CapacitySize` across accounts: a field
 *      that is always equal to the size never drains.
 *   2. The response may carry an authoritative aggregate (a summary element, a
 *      per-package "remain" with decimals) that the card should read INSTEAD of
 *      summing.
 *   3. `CycleCapacityRemain` may be the true remaining of a monthly package.
 *
 * So this prints, per package, EVERY field the upstream sent (unknown keys
 * included, which is the whole point), then the three competing sums, then any
 * keys the response has outside `Accounts`.
 *
 * READ-ONLY: one billing GET per account, no chat request, no account mutation.
 * Account names are masked; no token material is printed.
 *
 * Usage:
 *   node scripts/probe-credits-raw.mjs --region cn
 *   node scripts/probe-credits-raw.mjs --region global --max-accounts 3
 */

import { WorkBuddyCredentialStore, WorkBuddyUpstreamClient } from '../lib/index.js'

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1]
}

const REGION = value('--region', 'cn')
const MAX_ACCOUNTS = Number.parseInt(value('--max-accounts', '10'), 10)

const client = new WorkBuddyUpstreamClient()
const store = new WorkBuddyCredentialStore({ refresh: c => client.refreshToken(c), region: REGION })

/** Mask a display name: enough to tell accounts apart, not enough to leak one. */
const mask = name => (typeof name !== 'string' || name === '' ? '(unnamed)' : name.length <= 8 ? name : `${name.slice(0, 8)}…`)

const billingBase = domain => (domain.endsWith('workbuddy.ai') ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn')

const pad = n => n.toString().padStart(2, '0')
const stamp = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`

async function billing(credential, path, body) {
  const base = billingBase(credential.domain ?? '')
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credential.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
      ...credential.enterpriseId === undefined || credential.enterpriseId === '' ? {} : { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId },
      ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: response.status, parsed, text }
}

/** Which of the three candidate readings a package supports. */
function describePackage(pack, index) {
  const num = key => (typeof pack[key] === 'number' ? pack[key] : undefined)
  const size = num('CapacitySize')
  const remain = num('CapacityRemain')
  const used = num('CapacityUsed')
  const cycleSize = num('CycleCapacitySize')
  const cycleRemain = num('CycleCapacityRemain')
  const cycleUsed = num('CycleCapacityUsed')
  const monthly = num('CapacityType') === 4
  process.stdout.write(`  [${index}] ${typeof pack['PackageName'] === 'string' ? pack['PackageName'] : '(unnamed)'}\n`)
  process.stdout.write(`      CapacityType=${num('CapacityType')} monthly=${monthly}`)
  process.stdout.write(` Status=${num('Status')} ExpiredTime=${JSON.stringify(pack['ExpiredTime'])} CycleEndTime=${JSON.stringify(pack['CycleEndTime'])}\n`)
  process.stdout.write(`      size=${size} remain(CapacityRemain)=${remain} used=${used}`)
  process.stdout.write(` | cycleSize=${cycleSize} cycleRemain=${cycleRemain} cycleUsed=${cycleUsed}\n`)
  if (monthly && remain !== undefined && size !== undefined) {
    process.stdout.write(`      => CapacityRemain ${remain === size ? '== SIZE (never drained: reads as a CAP)' : '!= SIZE (drains: reads as a REMAINING)'}\n`)
  }
  // Anything the plugin does not read. This is where an authoritative balance
  // would hide, so it is printed rather than guessed at.
  const known = new Set(['PackageName', 'CapacityType', 'Status', 'ExpiredTime', 'CycleEndTime',
    'CapacitySize', 'CapacityRemain', 'CapacityUsed',
    'CycleCapacitySize', 'CycleCapacityRemain', 'CycleCapacityUsed'])
  const extra = Object.keys(pack).filter(key => !known.has(key))
  if (extra.length > 0) {
    process.stdout.write(`      OTHER FIELDS: ${extra.map(key => `${key}=${JSON.stringify(pack[key])}`).join(' ')}\n`)
  }
}

const accounts = await store.accounts()
process.stdout.write(`region  : ${REGION}\n`)
process.stdout.write(`accounts: ${accounts.length}\n\n`)

if (accounts.length === 0) {
  process.stdout.write('no account for this region\n')
  process.exitCode = 1
} else {
  const now = new Date()
  for (const account of accounts.slice(0, MAX_ACCOUNTS)) {
    const credential = await store.credentialFor(account.id)
    if (credential === undefined) {
      process.stdout.write(`- ${mask(account.accountName)}: no readable credential\n`)
      continue
    }
    const answer = await billing(credential, '/v2/billing/meter/get-user-resource', {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: stamp(now),
      PackageEndTimeRangeEnd: stamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    }).catch(error => ({ status: -1, parsed: undefined, text: String(error) }))

    process.stdout.write(`===== ${mask(account.accountName)} (http ${answer.status}) =====\n`)
    if (answer.status !== 200 || answer.parsed === undefined) {
      process.stdout.write(`  ${answer.text.slice(0, 300)}\n\n`)
      continue
    }
    const envelope = answer.parsed
    const outer = envelope?.data?.Response?.Data
    const packs = Array.isArray(outer?.Accounts) ? outer.Accounts : []
    // Everything the response says at the top level, so an aggregate balance we
    // are not reading cannot hide.
    process.stdout.write(`  envelope.code=${envelope?.code} responseData keys=[${Object.keys(outer ?? {}).join(', ')}]\n`)
    for (const [key, entry] of Object.entries(outer ?? {})) {
      if (key === 'Accounts') continue
      process.stdout.write(`  NON-PACKAGE FIELD ${key} = ${JSON.stringify(entry).slice(0, 400)}\n`)
    }
    packs.forEach((pack, index) => describePackage(pack, index))

    const sum = key => packs.reduce((acc, pack) => acc + (typeof pack[key] === 'number' ? pack[key] : 0), 0)
    const preciseSum = key => packs.reduce((acc, pack) => {
      const raw = pack[`${key}Precise`]
      const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN
      if (Number.isFinite(parsed)) return acc + parsed
      return acc + (typeof pack[key] === 'number' ? pack[key] : 0)
    }, 0)
    process.stdout.write(`  ---- sums ----\n`)
    process.stdout.write(`  Σ CapacityRemain               = ${sum('CapacityRemain')}   (the POOL family; not a balance — see issue #58)\n`)
    process.stdout.write(`  Σ CycleCapacityRemain          = ${sum('CycleCapacityRemain')}\n`)
    process.stdout.write(`  Σ CycleCapacityRemainPrecise   = ${preciseSum('CycleCapacityRemain')}   <-- what the official client shows\n`)
    process.stdout.write(`  (TotalDosage above is the pool sum, so it does NOT match the client.)\n\n`)
  }
}
