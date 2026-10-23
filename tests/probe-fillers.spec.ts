/**
 * The probe's fillers must be trustworthy in three ways before any number they
 * produce can be quoted (issue #59).
 *
 * 1. **Deterministic and region-independent.** The whole method rests on both
 *    regions being sent BYTE-IDENTICAL text; if generation drifted between runs,
 *    a measured ratio would be measuring the generator, not the gateway. The
 *    generator therefore must not read a clock, a random source, or the
 *    filesystem.
 * 2. **Incompressible enough to be a fair sample.** A filler with a short period
 *    (cycling the alphabet in order, or walking it with a stride) is far more
 *    compressible than real high-entropy text, so it would UNDERSTATE the rate —
 *    the exact error this class exists to correct. The reporter measured the
 *    real cost of head-of-log sampling at 322.6 tokens/1k against 455.5 for a
 *    full-range sample of the same class: 41% apart.
 * 3. **Shape-appropriate.** A `tool-result` filler whose characters are scrambled
 *    is not a tool result; the class exists precisely because its content shape
 *    (identifiers, braces, quoted keys, paths) drives the rate.
 *
 * The filler block is extracted from the script text and evaluated, rather than
 * imported from the script itself: the script runs a network probe at module
 * load, so importing it in a test would try to reach the upstream.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SCRIPT = 'scripts/probe-region-token-accounting.mjs'
const source = readFileSync(SCRIPT, 'utf8')

/** The filler-generation block, lifted out of the script and evaluated. */
async function fillers(): Promise<Record<string, string>> {
  const start = source.indexOf('const ENTROPY_FILLERS = {}')
  const end = source.indexOf('const fillerKey')
  expect(start, 'the entropy filler block must exist in the script').toBeGreaterThan(-1)
  expect(end, 'the filler block must precede fillerKey').toBeGreaterThan(start)
  const block = source.slice(start, end)
  const url = `data:text/javascript;base64,${
    Buffer.from(`${block}\nexport { ENTROPY_FILLERS };`).toString('base64')
  }`
  const module_ = await import(url) as { ENTROPY_FILLERS: Record<string, string> }
  return module_.ENTROPY_FILLERS
}

/** The classes the reporter's experiments established as analytically distinct. */
const REQUIRED_KINDS = ['base64', 'hex', 'ansi', 'proc', 'tool-result']

describe('probe fillers (issue #59)', () => {
  it('defines every measured content class, in both languages', async () => {
    // `tool-result` is the one the ORIGINAL probe table was missing, and its
    // absence is what made a 28% prediction gap look like a new mechanism.
    // base64/hex/ansi/proc are the entropy ladder inside it.
    const table = await fillers()
    for (const kind of REQUIRED_KINDS) {
      for (const language of ['en', 'zh']) {
        expect(table[`${language}:${kind}`], `${language}:${kind} must exist`).toBeTruthy()
      }
    }
  })

  it('generates the same bytes on every call, since both regions must see one text', async () => {
    // Determinism is what makes a cross-region ratio a statement about the
    // gateway. Any clock, random or filesystem read in the generator would make
    // the two regions differ for a reason that has nothing to do with counting.
    const first = await fillers()
    const second = await fillers()
    for (const key of Object.keys(first)) {
      expect(second[key], `${key} must be byte-identical across generations`).toBe(first[key])
    }
  })

  it('contains no random source or clock read anywhere in the filler block', async () => {
    // Asserted on the TEXT rather than on behaviour: a generator can be
    // deterministic by luck in one process and not in another (a seeded PRNG
    // whose seed moves with time is the classic case), and only the source shows
    // that it cannot move at all.
    const block = source.slice(source.indexOf('const ENTROPY_FILLERS = {}'), source.indexOf('const fillerKey'))
    expect(block).not.toMatch(/Math\.random/)
    expect(block).not.toMatch(/Date\.now/)
    expect(block).not.toMatch(/new Date/)
    // `readFile` appears legitimately inside the tool-result TEMPLATE, so the
    // check is for a filesystem CALL, not for the word.
    expect(block).not.toMatch(/from 'node:fs'/)
    expect(block).not.toMatch(/readFileSync\(/)
  })

  it('gives every class a period far longer than the sample, not a cycling motif', async () => {
    // The Discriminating Case, and it caught a REAL defect while being written:
    // the first generator took `(state >>> 8) % L`, which reads only log2(L) bits
    // of an LCG state, and those repeated every 16384 characters — so a 65536
    // -character filler contained the same 16 KiB four times. A tokenizer sees
    // that repetition and charges less, which is exactly the understatement this
    // class exists to correct.
    //
    // The check is therefore against the SHORTEST period a real payload would not
    // have, not against the half-length split: comparing halves alone passes for
    // any even-numbered period that happens to land on the boundary.
    const table = await fillers()
    for (const key of ['en:base64', 'en:hex', 'en:ansi']) {
      const text = table[key]!
      for (const period of [64, 1024, 16384]) {
        expect(
          text.slice(0, period),
          `${key} must not repeat with a ${period}-character period`,
        ).not.toBe(text.slice(period, period * 2))
      }
    }
  })

  it('emits a tool-result that still looks like one', async () => {
    // Scrambling the template per character would satisfy every determinism and
    // period assertion above while measuring a class no tool emits. The shape is
    // the point of this filler, so it is asserted directly.
    const table = await fillers()
    const text = table['en:tool-result']!
    expect(text).toContain('export function')
    expect(text).toContain('"path"')
    expect(text).toMatch(/await fs\.readFile/)
    // …and the Chinese variant is genuinely Chinese, not the English template.
    expect(table['zh:tool-result']).toContain('读取文件')
    expect(table['zh:tool-result']).not.toContain('export function readFile')
  })

  it('produces ANSI output with real SGR framing rather than literal backslash escapes', async () => {
    // The escape sequence is PART of what upstream tokenizes. Writing the two
    // characters `\` `u001B` instead of the control byte would silently measure a
    // class nobody sends — and the measured cost difference would be invisible,
    // because both regions would receive the same wrong text and agree.
    const table = await fillers()
    const text = table['en:ansi']!
    expect(text).toContain('\u001B[')
    expect(text).not.toContain('\\u001B')
    expect(text).toMatch(/\u001B\[3[1-7]m/)
  })

  it('emits no NaN in the structured classes, where it would mean a broken generator', async () => {
    // The first draft of these generators took an index parameter the caller
    // never passed, so `i % 8` on `undefined` produced `NaN` in every escape
    // sequence and every padded column — and both regions would have agreed on
    // it, so no cross-region comparison could ever have caught it.
    //
    // Scoped to ansi/proc/tool-result ON PURPOSE: those are built by FORMATTING
    // (`\u001B[3${n}m`, `.padStart`), where NaN is always a defect. base64 and
    // hex are drawn from an alphabet that merely happens to contain the letters
    // `N`, `a`, `N`, so the substring occurs by coincidence roughly once per
    // 64^3 characters and says nothing.
    const table = await fillers()
    for (const key of ['en:ansi', 'zh:ansi', 'en:proc', 'zh:proc', 'en:tool-result', 'zh:tool-result']) {
      expect(table[key], `${key} must not contain NaN`).not.toContain('NaN')
    }
  })

  it('is long enough that a default --chars sample never runs past the end', async () => {
    // `--chars` defaults to 12000; a filler shorter than the requested length
    // would be repeated by the caller and reintroduce a short period.
    const table = await fillers()
    for (const [key, text] of Object.entries(table)) {
      expect(text.length, `${key} must exceed the default --chars`).toBeGreaterThan(12_000)
    }
  })
})
