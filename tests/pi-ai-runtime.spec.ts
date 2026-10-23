/**
 * `piAiRuntimeInfo()` consistency.
 *
 * The whole #24/#25/#26 fix hinges on one question — which pi-ai copy does
 * THIS plugin resolve — and the answer must be self-consistent: the reported
 * generation has to follow the version of the manifest owning the reported
 * path, the path has to be the one Node actually resolves, and a market-style
 * install (no local pi-ai at all) must report host-provided WITHOUT crashing
 * the standalone CLI — which is why the detection deliberately never imports
 * pi-ai. These tests do NOT pin a version number: this checkout resolves
 * 0.85.1 today, but the gate admits the modern transcript generations we have
 * verified (0.87.x and 1.x; DSH 0.2.1-alpha.2 ships 1.0.2 and npm currently
 * publishes 1.1.0). The point of the gate is to FOLLOW the resolution within
 * those known generations, not to freeze it or guess at a future major.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { piAiRuntimeFor, piAiRuntimeInfo } from '../src/pi-ai-runtime.ts'

const tempRoots: string[] = []

/**
 * Lay down a fake pi-ai package reporting `version` and return its entry file,
 * so `piAiRuntimeFor` reads a real manifest instead of the checkout's.
 */
function piAiEntryWithVersion(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-ai-version-'))
  tempRoots.push(root)
  mkdirSync(join(root, 'dist'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-ai', version }),
  )
  const entry = join(root, 'dist', 'index.js')
  writeFileSync(entry, '')
  return entry
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
})

describe('piAiRuntimeFor (the branch that only runs on other machines)', () => {
  it('reports host-provided and defaults to the modern gate when nothing resolves', () => {
    // A market install probed outside the host: no local pi-ai at all. Inside
    // DSH the host supplies it, and hosts that normalize (0.2.0+) ship the
    // modern generation — so the pass-through branch is the correct default,
    // and it is also harmless on older hosts, whose native 0.85 shape is an
    // identity under either branch.
    const info = piAiRuntimeFor(undefined)
    expect(info.generation).toBe('modern')
    expect(info.resolvedLocally).toBe(false)
    expect(info.version).toBeUndefined()
    expect(info.resolvedFrom).toBeUndefined()
  })

  it('decides the generation from the manifest beside the resolved entry', () => {
    const modern = piAiRuntimeFor('/nonexistent/pi-ai/dist/index.js')
    // No readable manifest there: conservatively legacy, and resolvedLocally
    // still true so doctor can show the path it tried.
    expect(modern.resolvedLocally).toBe(true)
    expect(modern.generation).toBe('legacy')
    expect(modern.version).toBeUndefined()
    expect(modern.resolvedFrom).toBe('/nonexistent/pi-ai/dist/index.js')
  })
})

describe('the version → generation split', () => {
  it.each([
    ['0.85.0', 'legacy'],
    ['0.85.1', 'legacy'],
    ['0.86.3', 'legacy'],
    ['0.87.0', 'modern'],
    ['0.87.1', 'modern'],
    ['1.0.0', 'modern'],
    ['1.0.2', 'modern'],
    ['1.1.0', 'modern'],
    ['2.0.0', 'legacy'],
  ])('maps pi-ai %s to the %s gate', (version, expected) => {
    const info = piAiRuntimeFor(piAiEntryWithVersion(version))
    expect(info.version).toBe(version)
    expect(info.generation).toBe(expected)
  })

  it('bridges the verified major-0 to major-1 transcript boundary, but does not assume major 2', () => {
    // The regression this pins: `/^0\.(\d+)\./` matches nothing inside
    // '1.0.2', so that version fell through to `legacy`. Legacy folds the
    // normalized transcript into the 0.85 shape — moving tools onto a
    // top-level `tools` field that pi-ai 1.x never reads — and requests then
    // went upstream without tools. 0.87.1, 1.0.2, and 1.1.0 have been checked
    // to read transcript tools from the same `messages[].toolsAdded` contract.
    // Major 2 is deliberately NOT classified as modern without verification.
    expect(piAiRuntimeFor(piAiEntryWithVersion('0.86.9')).generation).toBe('legacy')
    expect(piAiRuntimeFor(piAiEntryWithVersion('0.87.1')).generation).toBe('modern')
    expect(piAiRuntimeFor(piAiEntryWithVersion('1.0.2')).generation).toBe('modern')
    expect(piAiRuntimeFor(piAiEntryWithVersion('1.1.0')).generation).toBe('modern')
    expect(piAiRuntimeFor(piAiEntryWithVersion('2.0.0')).generation).toBe('legacy')
  })

  it('keeps an unreadable version conservative', () => {
    expect(piAiRuntimeFor(piAiEntryWithVersion('not-a-version')).generation).toBe('legacy')
    expect(piAiRuntimeFor(piAiEntryWithVersion('')).generation).toBe('legacy')
  })
})

describe('piAiRuntimeInfo', () => {
  it('reports the generation the resolved manifest version belongs to', () => {
    const info = piAiRuntimeInfo()
    if (info.resolvedLocally && info.version !== undefined) {
      const major = Number(/^(\d+)\./u.exec(info.version)?.[1])
      const minor = Number(/^0\.(\d+)\./u.exec(info.version)?.[1])
      expect(info.generation).toBe(major === 1 || minor >= 87 ? 'modern' : 'legacy')
    }
  })

  it('reports the file Node resolves for the bare specifier', () => {
    const info = piAiRuntimeInfo()
    expect(info.resolvedLocally).toBe(true)
    expect(info.resolvedFrom).toContain('pi-ai')
    expect(info.resolvedFrom).toMatch(/\.js$/u)
  })

  it('reads the version from the manifest owning the resolved file', () => {
    const info = piAiRuntimeInfo()
    if (!info.resolvedLocally) return
    // 0.8x (the declared peer range) or 1.x (what DSH 0.2.1-alpha.2 ships) —
    // both spell the version this way. Anything else means the wrong manifest
    // was read (for instance a virtual-store parent's package.json).
    expect(info.version).toMatch(/^(?:0\.[89]\d*|[1-9]\d*)\.\d+/u)
  })

  it('is stable across calls (resolved once, then cached)', () => {
    expect(piAiRuntimeInfo()).toBe(piAiRuntimeInfo())
  })
})
