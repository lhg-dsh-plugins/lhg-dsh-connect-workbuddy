#!/usr/bin/env node
/**
 * Measure how a region's gateway COUNTS a prompt (issue #59).
 *
 * Issue #59 reports a long session whose prompt the CN gateway called ~708K
 * tokens and the international gateway called ~1.374M — the same history,
 * ≈1.94× apart, which turns a switch to international into an instant
 * `code 11115 prompt is too long`. Two worlds explain that, and they have
 * opposite owners:
 *
 *   - the gateways count identical bytes differently (upstream's business); or
 *   - the gateways count identically and the gap came from what was SENT, or
 *     from which part of the prompt each one reports (ours to fix).
 *
 * This probe separates them with two measurements on ONE byte-identical English
 * filler, so neither language nor content differences can produce the answer:
 *
 *   1. `tokens_per_1k_chars` — a cheap cross-region comparability figure. Run
 *      the same `--chars` in both regions and compare; a ratio near 1.0 means
 *      the counters agree on identical bytes.
 *   2. the CACHE CONVENTION — whether `prompt_tokens` INCLUDES the cached
 *      portion. Turn 1 sends the prefix to warm the cache; turns 2..N send the
 *      byte-identical prefix again, and the upstream's own `prompt_cache_hit_tokens`
 *      / `prompt_cache_miss_tokens` say which accounting it uses:
 *        - hit + miss === prompt_tokens  → OpenAI convention (cached is a SUBSET;
 *          pi-ai's `input = prompt - cacheRead` is arithmetically right);
 *        - prompt_tokens === miss alone  → Anthropic convention (cached sits
 *          OUTSIDE prompt_tokens; anything anchoring on prompt_tokens sees only
 *          the uncached remainder and therefore UNDERSTATES the real context).
 *      The second case is a live candidate for #59: a warm long session would
 *      report a prompt far smaller than the bytes actually sent, so a host that
 *      anchors compaction on it never compacts — and the other region, counting
 *      the whole thing, answers 11115.
 *
 * It walks the region's accounts and reports every failure per account, because
 * the first credential a region resolves is often the one that is rate-limited
 * or out of credits (measured 2026-10-14: the CN default answered 6004, all
 * three international accounts answered 14018).
 *
 * READ-ONLY w.r.t. account state, but it DOES spend credits: `--turns`
 * completions of a few tokens over an ~2.6K-token prompt. Account names are
 * masked to their first 8 characters; no token material is printed.
 *
 * Usage:
 *   node scripts/probe-region-token-accounting.mjs --region cn --model deepseek-v4.1-flash
 *   node scripts/probe-region-token-accounting.mjs --region global --model deepseek-v4.1-flash-sg
 *   node scripts/probe-region-token-accounting.mjs --region cn --model glm-5.2 --turns 4
 *   node scripts/probe-region-token-accounting.mjs --region global --kind code --language en
 *   node scripts/probe-region-token-accounting.mjs --region cn --kind json --language zh
 *
 * Run the SAME --language/--kind/--chars in both regions and compare
 * `tokens_per_1k_chars`; that ratio is the cross-region comparability figure.
 */

import { WorkBuddyCredentialStore, WorkBuddyUpstreamClient, prepareChatBody } from '../lib/index.js'

const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1]
}

const REGION = value('--region', 'cn')
const MODEL = value('--model', undefined)
const CHARS = Number.parseInt(value('--chars', '12000'), 10)
const TURNS = Number.parseInt(value('--turns', '2'), 10)
const MAX_TOKENS = Number.parseInt(value('--max-tokens', '8'), 10)
const MAX_ACCOUNTS = Number.parseInt(value('--max-accounts', '10'), 10)
const LANGUAGE = value('--language', 'en')
const KIND = value('--kind', 'prose')

/**
 * Deterministic filler for one content class, byte-identical between regions and
 * turns. The sameness is what makes the numbers comparable at all.
 *
 * `--language` and `--kind` exist because the reporter's own round of this
 * experiment (2026-10-14) showed the two gateways agreeing PERFECTLY on prose —
 * 224.3 vs 224.9 tokens/1k chars on English, 668.6 vs 669.2 on Chinese — while a
 * real session's *history* was charged 1.94× apart. Prose is the one content
 * class a long agentic session is mostly NOT made of: its bulk is tool results
 * (source files, diffs, command output, JSON). So the remaining question is
 * whether the two counters still agree on THOSE, and it can only be answered by
 * measuring them instead of assuming.
 *
 * Chinese carries ~3× the tokens per character of English (measured: 0.669 vs
 * 0.224 tokens/char), which is why `--language` matters too: a ratio computed
 * against the wrong language is off by 3×.
 *
 * ## Why the high-entropy kinds exist (added 2026-10-16)
 *
 * The `prose`/`code`/`json` triple above turned out to MISS THE MOST EXPENSIVE
 * CLASS IN A REAL SESSION. A body-composition capture of a real long session
 * (`WORKBUDDY_BODY_REPORT`, issue #59) showed `tool-result` is the single
 * largest block type — 47% of all characters — and measuring IT gave
 * **455.5 tokens/1k chars**, i.e. 1.6× the `code` rate that a table without it
 * would treat as the ceiling. Feeding that one number back into the capture's
 * composition closed a 28% prediction gap to ~1%.
 *
 * Within `tool-result`, the dearest content is high-entropy: measured against
 * `code(en) = 287.9`, base64 runs **2.50×**, hex **2.04×**, ANSI terminal output
 * **1.92×**, aligned process/table output **1.63×**. A probe that samples only
 * prose therefore UNDERSTATES a real history by a factor, and the understatement
 * is silent — which is exactly the shape of the original 1.94× report.
 *
 * ## Sampling rule (added 2026-10-16, learned the hard way)
 *
 * These fillers must be sampled UNIFORMLY across their source, not taken from
 * the head of a log. The reporter measured the same real `tool-result` text two
 * ways: the first 12k characters gave 322.6 tokens/1k, and a full-range uniform
 * sample gave 455.5 — **41% apart, same class, same regions**. Head-of-log is
 * where a session's prose and prompts live; the tool output that dominates the
 * bulk sits later. Every generator below therefore cycles its alphabet with a
 * stride chosen to be coprime with the period, so the first `CHARS` characters
 * are a full-range sample rather than a prefix of one motif.
 */
const FILLERS = {
  'en:prose': 'The quick brown fox jumps over the lazy dog. Prometheus bound the cache key to the prefix. ',
  'zh:prose': '敏捷的棕色狐狸跳过了那只懒狗。缓存键被绑定在前缀之上，于是重发的请求命中了它。',
  'en:code': 'export function scan(nodes: Node[], threshold: number): number {\n  let hits = 0\n  for (const node of nodes) if (node.weight > threshold) { hits += 1; emit(node.id, node.weight) }\n  return hits\n}\n',
  'zh:code': 'export function 扫描(节点表: 节点[], 阈值: number): number {\n  let 命中 = 0\n  for (const 节点 of 节点表) if (节点.权重 > 阈值) { 命中 += 1; 输出(节点.id, 节点.权重) }\n  return 命中\n}\n',
  'en:json': '{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/upstream.ts\\",\\"limit\\":400}"}}]}\n{"status":"ok","bytes":18244,"cached":true,"region":"ap-others"}\n',
  'zh:json': '{"角色":"助手","工具调用":[{"编号":"调用_1","类型":"函数","函数":{"名称":"读取文件","参数":"{\\"路径\\":\\"src/upstream.ts\\",\\"上限\\":400}"}}]}\n{"状态":"成功","字节数":18244,"已缓存":true,"区域":"ap-others"}\n',
}

const ENTROPY_FILLERS = {}

/**
 * Greatest common divisor. Exported so a test can prove the strides below share
 * no factor with their alphabet lengths.
 * @param a - first integer.
 * @param b - second integer.
 * @returns the greatest common divisor.
 */
export function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * Emit `count` characters of pseudo-random-looking text from an alphabet.
 *
 * WHY NOT JUST CYCLE THE ALPHABET: reading `ABC…Zabc…z012…` in order produces a
 * short-period motif that a tokenizer compresses far better than real
 * high-entropy text, which would make the measured rate too LOW — reintroducing
 * exactly the understatement this class exists to correct.
 *
 * WHY NOT A STRIDE ALONE: walking the alphabet with a stride visits all `L`
 * symbols and then repeats, so the text still has period `L` (64 for base64),
 * which is also far too compressible. Measured against a real payload the rate
 * would again be understated.
 *
 * WHAT IS USED: a small linear congruential generator over 32 bits, mixed with a
 * fixed per-call seed. The period is ~4 billion rather than 64, the output is a
 * pure function of the seed (so both regions and both turns get identical text),
 * and it costs no fixture file. `seed` differs per class so the classes are not
 * the same bytes in different clothes.
 *
 * @param alphabet - symbols to draw from.
 * @param count - how many characters to emit.
 * @param seed - mixing constant; the same seed always yields the same text.
 * @returns the generated filler.
 */
function entropy(alphabet, count, seed) {
  const out = []
  // Numerical Recipes LCG constants: full 32-bit period, no low-bit pattern.
  let state = seed >>> 0
  for (let emitted = 0; emitted < count; emitted += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    // MIX BEFORE TAKING THE MODULUS. `(state >>> 8) % L` reads only log2(L) bits
    // of the state, and those bits of an LCG repeat far sooner than the full
    // 32-bit period: measured with L = 64 it repeated every 16384 characters,
    // which a 65536-character filler then contains four times over — a short
    // period is exactly the compressibility this generator exists to avoid. Two
    // xorshift-multiply rounds fold the high bits into the low ones first, which
    // measured no period at all within 120000 characters.
    let mixed = (state ^ (state >>> 15)) >>> 0
    mixed = Math.imul(mixed, 0x2c1b3c6d) >>> 0
    mixed = (mixed ^ (mixed >>> 12)) >>> 0
    out.push(alphabet[mixed % alphabet.length])
  }
  return out.join('')
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const HEX = '0123456789abcdef'
const ANSI_SYMS = 'abcdefghijklmnopqrstuvwxyz0123456789 ./'
const PROC_COLS = 'abcdefghijklmnopqrstuvwxyz0123456789-_.'
const TOOL_SRC = 'export function readFile(p: string) {\n  const b = await fs.readFile(p, "utf8")\n  return { p, bytes: b.length, ok: true }\n}\n{"path":"src/upstream.ts","line":175,"text":"contextWindow: info.contextWindow"}\nRun 1/12: ok 18244ms  cached=true\n'
const TOOL_SRC_ZH = 'export function 读取文件(路径: string): boolean {\n  const 内容 = await fs.readFile(路径, "utf8")\n  return { 路径, 字节数: 内容.length, 成功: true }\n}\n{"路径":"src/upstream.ts","行":175,"文本":"contextWindow: info.contextWindow"}\n第 1/12 次: 成功 18244毫秒 已缓存=true\n'

// base64 is the dearest measured class (2.50× code): a real encoded payload.
const BASE64_TEXT = entropy(B64, 65536, 0x9e3779b9)
// hex covers hashes and digests (2.04×).
const HEX_TEXT = entropy(HEX, 65536, 0x85ebca6b)
// ANSI is coloured terminal output (1.92×). The SGR framing is PART of the cost,
// so it is emitted rather than stripped — stripping it would measure a class
// nobody sends. Colour codes cycle 31-37 like a real logger's levels.
const ANSI_TEXT = (() => {
  const symbols = entropy(ANSI_SYMS, 6000, 0xc2b2ae35)
  let out = ''
  for (let i = 0; i < symbols.length; i += 1) {
    out += `\u001B[3${1 + (i % 7)}m${symbols[i]}\u001B[0m`
  }
  return out
})()
// proc is aligned process/table output (1.63×): padded columns, as `ps`/`df` emit.
const PROC_TEXT = (() => {
  const cells = entropy(PROC_COLS, 4096, 0x27d4eb2f)
  let out = ''
  for (let i = 0; i < cells.length; i += 1) {
    const pid = String(1000 + ((i * 7919) % 89999))
    out += `${pid.padStart(6, ' ')}  ${cells[i].repeat(8).padEnd(8, cells[i])}  ${String((i * 37) % 100000).padStart(5, ' ')}  ok\n`
  }
  return out
})()

for (const lang of ['en', 'zh']) {
  ENTROPY_FILLERS[`${lang}:base64`] = BASE64_TEXT
  ENTROPY_FILLERS[`${lang}:hex`] = HEX_TEXT
  ENTROPY_FILLERS[`${lang}:ansi`] = ANSI_TEXT
  ENTROPY_FILLERS[`${lang}:proc`] = PROC_TEXT
}
// `tool-result` is a CLASS OF ITS OWN, not a blend: code, JSON-ish structure,
// paths and command output in one blob is what a real tool result carries, and
// it is the single largest block type in a long session (47% of characters).
//
// It is deliberately NOT sampled through `entropy()`: scrambling the template
// character-by-character would produce text no tool ever emits, and the whole
// point of this class is that its CONTENT SHAPE is realistic (identifiers,
// braces, quoted keys, paths, aligned numbers). Its variation comes from
// repeating the template at an offset that advances per copy, so the filler has
// no short period either.
const TOOL_RESULT_EN = (() => {
  let out = ''
  let offset = 0
  while (out.length < 16384) {
    out += TOOL_SRC.slice(offset % TOOL_SRC.length) + TOOL_SRC.slice(0, offset % TOOL_SRC.length)
    offset += 97
  }
  return out.slice(0, 16384)
})()
const TOOL_RESULT_ZH = (() => {
  let out = ''
  let offset = 0
  while (out.length < 16384) {
    out += TOOL_SRC_ZH.slice(offset % TOOL_SRC_ZH.length) + TOOL_SRC_ZH.slice(0, offset % TOOL_SRC_ZH.length)
    offset += 97
  }
  return out.slice(0, 16384)
})()
ENTROPY_FILLERS['en:tool-result'] = TOOL_RESULT_EN
ENTROPY_FILLERS['zh:tool-result'] = TOOL_RESULT_ZH

const fillerKey = `${LANGUAGE}:${KIND}`
const FILLER = FILLERS[fillerKey] ?? FILLERS['en:prose']
const PREFIX = FILLER.repeat(Math.ceil(CHARS / FILLER.length)).slice(0, CHARS)
const SUFFIX = ' Reply with exactly: OK'

/** Split an SSE body into decoded `data:` payloads. */
function decodeSse(text) {
  const payloads = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (raw === '' || raw === '[DONE]') continue
      try {
        payloads.push(JSON.parse(raw))
      } catch {
        // Keepalive/comment lines are never usage events.
      }
    }
  }
  return payloads
}

/** The terminal usage object: the one carrying `prompt_tokens`. */
function findUsage(text) {
  for (const payload of decodeSse(text).reverse()) {
    const usage = payload?.['usage']
    if (typeof usage === 'object' && usage !== null && typeof usage['prompt_tokens'] === 'number') return usage
  }
  return undefined
}

/** Mask a display name: enough to tell accounts apart, not enough to leak one. */
function mask(name) {
  if (typeof name !== 'string' || name === '') return '(unnamed)'
  return name.length <= 8 ? name : `${name.slice(0, 8)}…`
}

/** Send one turn and return either its usage object or the upstream failure. */
async function send(client, credential, modelId, content) {
  const body = prepareChatBody(JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_TOKENS,
  }))
  let result
  try {
    result = await client.chatStream(credential, body, AbortSignal.timeout(120_000))
  } catch (error) {
    return { failure: `transport error ${String(error)}` }
  }
  if (!result.ok) {
    return { failure: `kind=${result.kind} status=${result.status} ${result.message.slice(0, 160)}` }
  }
  const usage = findUsage(await result.response.text())
  return usage === undefined ? { failure: 'ok but no usage block' } : { usage }
}

const client = new WorkBuddyUpstreamClient()
const store = new WorkBuddyCredentialStore({ refresh: c => client.refreshToken(c), region: REGION })

process.stdout.write(`region  : ${REGION}\n`)
process.stdout.write(`prompt  : prefix ${PREFIX.length} chars, byte-identical across regions and turns\n`)
process.stdout.write(`content : language=${LANGUAGE} kind=${KIND}${fillerKey in FILLERS ? '' : ' (UNKNOWN combination; fell back to en:prose)'}\n`)
process.stdout.write(`turns   : ${TURNS} (turn 1 warms the cache, 2..N re-send the same prefix + suffix)\n`)
process.stdout.write(`tokens  : max_tokens=${MAX_TOKENS}\n\n`)

const accounts = await store.accounts()
process.stdout.write(`accounts: ${accounts.length} signed in for this region\n\n`)

if (accounts.length === 0) {
  process.stdout.write('no account for this region; nothing to measure\n')
  process.exitCode = 1
} else {
  const firstCredential = await store.credentialFor(accounts[0].id)
  const models = firstCredential === undefined ? [] : await client.fetchModels(firstCredential)
  const modelId = MODEL ?? models[0]?.id
  if (modelId === undefined) {
    process.stdout.write('model catalog is empty; cannot probe\n')
    process.exitCode = 1
  } else {
    process.stdout.write(`model   : ${modelId}\n\n`)

    /** The first account that completes turn 1 owns the rest of the run. */
    let chosen
    for (const account of accounts.slice(0, MAX_ACCOUNTS)) {
      const credential = await store.credentialFor(account.id)
      if (credential === undefined) {
        process.stdout.write(`- ${mask(account.accountName)}: no readable credential\n`)
        continue
      }
      const answer = await send(client, credential, modelId, PREFIX)
      if (answer.usage === undefined) {
        process.stdout.write(`- ${mask(account.accountName)}: ${answer.failure}\n`)
        continue
      }
      process.stdout.write(`- ${mask(account.accountName)}: answered turn 1\n\n`)
      chosen = { account, credential, first: answer.usage }
      break
    }

    if (chosen === undefined) {
      process.stdout.write('\nno account in this region answered; nothing measurable from here\n')
      process.exitCode = 1
    } else {
      const rows = [{ turn: 1, warming: true, usage: chosen.first }]
      const probePrompt = `${PREFIX}${SUFFIX}`
      for (let turn = 2; turn <= TURNS; turn += 1) {
        const answer = await send(client, chosen.credential, modelId, probePrompt)
        if (answer.usage === undefined) {
          process.stdout.write(`turn ${turn}: ${answer.failure}\n`)
          break
        }
        rows.push({ turn, warming: false, usage: answer.usage })
      }

      process.stdout.write(`account : ${mask(chosen.account.accountName)}\n`)
      process.stdout.write(`model   : ${modelId}\n\n`)
      for (const row of rows) {
        const usage = row.usage
        const prompt = usage['prompt_tokens']
        const hit = usage['prompt_cache_hit_tokens']
        const miss = usage['prompt_cache_miss_tokens']
        const cached = usage['prompt_tokens_details']?.['cached_tokens'] ?? usage['cached_tokens']
        process.stdout.write(`turn ${row.turn}${row.warming ? ' (warm only)' : ''}: prompt_tokens=${prompt}`)
        if (typeof hit === 'number') process.stdout.write(` hit=${hit}`)
        if (typeof miss === 'number') process.stdout.write(` miss=${miss}`)
        if (typeof cached === 'number' && cached !== 0) process.stdout.write(` cached_tokens=${cached}`)
        process.stdout.write(` credit=${usage['credit'] ?? '(none)'}\n`)
        if (row.warming) process.stdout.write(`  raw: ${JSON.stringify(usage)}\n`)
      }

      const first = rows[0].usage
      const identical = rows.filter(row => !row.warming)
      process.stdout.write('\n===== result =====\n')
      process.stdout.write(`region=${REGION} model=${modelId} language=${LANGUAGE} kind=${KIND} chars=${PREFIX.length + SUFFIX.length}`)
      process.stdout.write(` prompt_tokens=${first['prompt_tokens']}`)
      process.stdout.write(` tokens_per_1k_chars=${(first['prompt_tokens'] / (PREFIX.length + SUFFIX.length) * 1000).toFixed(2)}\n`)

      if (identical.length === 0) {
        process.stdout.write('cache convention: not measurable (no identical-prompt turn completed)\n')
      } else {
        const usable = identical.filter(row => typeof row.usage['prompt_cache_hit_tokens'] === 'number'
          && typeof row.usage['prompt_cache_miss_tokens'] === 'number')
        const partitioned = usable.length > 0 && usable.every(row => row.usage['prompt_cache_hit_tokens'] + row.usage['prompt_cache_miss_tokens'] === row.usage['prompt_tokens'])
        const missOnly = usable.length > 0 && usable.every(row => row.usage['prompt_cache_hit_tokens'] > 0
          && row.usage['prompt_cache_miss_tokens'] === row.usage['prompt_tokens'])
        process.stdout.write(`cache convention: ${partitioned ? 'OpenAI (prompt_tokens INCLUDES cached)' : missOnly ? 'ANTHROPIC (prompt_tokens EXCLUDES cached)' : 'inconclusive'}\n`)
        if (missOnly) {
          process.stdout.write('  => a warm long session reports only the UNCACHED remainder, so anything\n')
          process.stdout.write('     anchoring on prompt_tokens understates the real context.\n')
        }
      }
    }
  }
}
