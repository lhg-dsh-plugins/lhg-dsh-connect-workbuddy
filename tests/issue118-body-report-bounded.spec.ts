import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendBodyReport,
  BODY_REPORT_MAX_BYTES,
  describeBody,
  recordBodyReport,
  USAGE_ATTACH_TAIL_BYTES,
  WORKBUDDY_BODY_REPORT_ENV,
} from '../src/body-report.ts'

/**
 * Issue #118: with `WORKBUDDY_BODY_REPORT` left on, `<region>.jsonl` grew
 * without bound (the reporter measured 508 MB), and every usage attach read the
 * WHOLE file into heap, split it, and rewrote the WHOLE file — roughly three
 * copies of a half-gigabyte file inside a host process capped at ~3 GB.
 *
 * Three properties are pinned here:
 *   1. an append past the cap ROLLS the file instead of growing it forever, and
 *      the roll keeps exactly one predecessor;
 *   2. the usage attach touches only the tail window — a file far larger than
 *      the window still gets its recent line annotated, and bytes BEFORE the
 *      window survive the rewrite byte-for-byte;
 *   3. the window's line-boundary handling survives the nasty alignment: a
 *      window that starts exactly ON a boundary (its first line is complete and
 *      must survive the rewrite — dropping it would delete a line from disk).
 */

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workbuddy-body-report-118-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/**
 * One report line of a controllable size, built through the real describer.
 *
 * The pad rides on the MODEL field because a report carries COUNTS ONLY — the
 * message text never reaches the line, so padding a message would not change
 * the line's size at all. `model` is copied verbatim (`describeBody`), which
 * makes it the one knob that sizes a line exactly.
 */
function lineOf(nowMs: number, padChars: number): string {
  const report = describeBody(
    JSON.stringify({ model: 'm'.repeat(padChars), messages: [] }),
    'cn',
    nowMs,
  )
  if (report === undefined) throw new Error('describeBody returned undefined for a valid body')
  return `${JSON.stringify(report)}\n`
}

/**
 * A body whose report line is EXACTLY `targetBytes` long.
 *
 * Two knobs move a line's size, and both are self-referential: the model id is
 * copied verbatim into the line, and `bodyBytes` re-states the body's length —
 * so padding the model also grows the digit count of `bodyBytes`. Iterating
 * converges in one or two steps because the digit count stops changing.
 */
function bodyWithLineSize(targetBytes: number, nowMs: number, message: unknown): string {
  let pad = Math.max(0, targetBytes - Buffer.byteLength(`${JSON.stringify(describeBody(JSON.stringify({ model: '', messages: [message] }), 'cn', nowMs))}\n`, 'utf8'))
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const body = JSON.stringify({ model: 'm'.repeat(pad), messages: [message] })
    const line = describeBody(body, 'cn', nowMs)
    if (line === undefined) throw new Error('describeBody returned undefined')
    const delta = targetBytes - Buffer.byteLength(`${JSON.stringify(line)}\n`, 'utf8')
    if (delta === 0) return body
    pad += delta
  }
  throw new Error(`could not size a report line to exactly ${targetBytes} bytes`)
}

describe('the append side is bounded (issue #118)', () => {
  it('rolls the file to .1 instead of growing past the cap', async () => {
    const pad = Math.floor(BODY_REPORT_MAX_BYTES / 2)
    await appendBodyReport(directory, JSON.parse(lineOf(1000, pad)))
    await appendBodyReport(directory, JSON.parse(lineOf(2000, pad)))

    const names = (await readdir(directory)).sort()
    expect(names).toEqual(['cn.jsonl', 'cn.jsonl.1'])
    expect((await readFile(join(directory, 'cn.jsonl.1'), 'utf8')).trim().split('\n')).toHaveLength(1)
    expect((await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    expect((await stat(join(directory, 'cn.jsonl'))).size).toBeLessThan(BODY_REPORT_MAX_BYTES)
    // The live line is the NEWER one — a reporter diffing "the last line" must
    // never be handed the rolled-away capture.
    expect(JSON.parse((await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim()).at)
      .toBe(new Date(2000).toISOString())
  })

  it('keeps at most one predecessor: a second roll replaces the first', async () => {
    const pad = Math.floor(BODY_REPORT_MAX_BYTES / 2)
    for (const at of [1000, 2000, 3000, 4000]) {
      await appendBodyReport(directory, JSON.parse(lineOf(at, pad)))
    }
    expect((await readdir(directory)).sort()).toEqual(['cn.jsonl', 'cn.jsonl.1'])
    // The kept predecessor is the THIRD line, not the first: each roll drops
    // the older roll.
    expect(JSON.parse((await readFile(join(directory, 'cn.jsonl.1'), 'utf8')).trim()).at)
      .toBe(new Date(3000).toISOString())
  })

  it('does not roll an empty file, and does not roll while under the cap', async () => {
    await appendBodyReport(directory, JSON.parse(lineOf(1000, 10)))
    await appendBodyReport(directory, JSON.parse(lineOf(2000, 10)))
    expect(await readdir(directory)).toEqual(['cn.jsonl'])
    expect((await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
  })
})

describe('the usage attach reads only the tail (issue #118)', () => {
  it('annotates a recent line in a file far larger than the window', async () => {
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    // ~1.2 windows of unrelated lines, so the target is not the only line and
    // the window cannot reach the file's start.
    const filler = 'y'.repeat(Math.floor(USAGE_ATTACH_TAIL_BYTES / 40))
    for (let index = 0; index < 45; index += 1) {
      await appendBodyReport(directory, JSON.parse(lineOf(100 + index, filler.length)))
    }
    expect((await stat(join(directory, 'cn.jsonl'))).size).toBeGreaterThan(USAGE_ATTACH_TAIL_BYTES)

    const attach = await recordBodyReport('cn', JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'target' }] }), { env, nowMs: 9000 })
    attach({ promptTokens: 4242 })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(lines[lines.length - 1] as string).promptTokens).toBe(4242)
    })

    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    // In-place rewrite: 45 fillers + the handle's own line, no extra.
    expect(lines).toHaveLength(46)
    // Everything before the window survives byte-for-byte.
    for (let index = 0; index < 45; index += 1) {
      const parsed = JSON.parse(lines[index] as string)
      expect(parsed.at).toBe(new Date(100 + index).toISOString())
      expect(parsed.promptTokens).toBeUndefined()
    }
  })

  it('survives a window that starts exactly on a line boundary', async () => {
    // Prefix of two complete lines, then ONE appended line sized so the file is
    // exactly `prefix + TAIL`: the window then starts on the byte right after
    // the prefix's terminating newline — the lookback byte IS a newline, so the
    // window's first line is complete. The old mid-line-only logic would have
    // dropped that line from the rewrite and deleted it from the file.
    const prefix = lineOf(1000, 10) + lineOf(1500, 10)
    await writeFile(join(directory, 'cn.jsonl'), prefix, 'utf8')

    // Size the appended line EXACTLY to the window, so the file ends precisely
    // `prefix + TAIL` and the window starts on a line boundary.
    const body = bodyWithLineSize(USAGE_ATTACH_TAIL_BYTES, 2000, { role: 'user', content: 'target' })

    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    const attach = await recordBodyReport('cn', body, { env, nowMs: 2000 })
    const size = (await stat(join(directory, 'cn.jsonl'))).size
    expect(size).toBe(Buffer.byteLength(prefix, 'utf8') + USAGE_ATTACH_TAIL_BYTES)

    attach({ promptTokens: 555 })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
      expect(JSON.parse(lines[lines.length - 1] as string).promptTokens).toBe(555)
    })
    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    // Nothing deleted: both prefix lines plus the annotated one.
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0] as string).at).toBe(new Date(1000).toISOString())
    expect(JSON.parse(lines[1] as string).at).toBe(new Date(1500).toISOString())
    expect(JSON.parse(lines[0] as string).promptTokens).toBeUndefined()
    expect(JSON.parse(lines[1] as string).promptTokens).toBeUndefined()
  })

  it('leaves a line older than the window un-annotated instead of corrupting the file', async () => {
    const env = { [WORKBUDDY_BODY_REPORT_ENV]: directory }
    const errors: unknown[] = []
    const attach = await recordBodyReport('cn', JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'old' }] }), { env, nowMs: 1000, onError: error => errors.push(error) })
    // Push the target out of the window with filler bigger than a window.
    const filler = 'z'.repeat(Math.floor(USAGE_ATTACH_TAIL_BYTES / 20))
    for (let index = 0; index < 30; index += 1) {
      await appendBodyReport(directory, JSON.parse(lineOf(5000 + index, filler.length)))
    }
    attach({ promptTokens: 1 })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(errors).toEqual([])
    const lines = (await readFile(join(directory, 'cn.jsonl'), 'utf8')).trim().split('\n')
    // Every line still parses: a failed attach must not truncate or shred.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect(lines).toHaveLength(31)
    expect(JSON.parse(lines[0] as string).promptTokens).toBeUndefined()
  })
})
