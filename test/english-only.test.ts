import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JAPANESE } from './helpers/japanese.ts'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SOURCE_EXTENSIONS = ['.ts', '.mjs', '.json']

function sourceFiles(dir: string): string[] {
  return readdirSync(join(REPOSITORY_ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)))
    .map((entry) => relative(REPOSITORY_ROOT, join(entry.parentPath, entry.name)))
}

function japaneseLines(file: string): string[] {
  return readFileSync(join(REPOSITORY_ROOT, file), 'utf8')
    .split('\n')
    .flatMap((line, index) => (JAPANESE.test(line) ? [`${file}:${index + 1}`] : []))
}

describe('JAPANESE', () => {
  it.each([
    ['U+3042 (hiragana)', 0x3042],
    ['U+30A2 (katakana)', 0x30a2],
    ['U+6F22 (kanji)', 0x6f22],
    ['U+3231 (enclosed CJK)', 0x3231],
    ['U+F900 (CJK compatibility ideograph)', 0xf900],
    ['U+FF08 (full-width parenthesis)', 0xff08],
    ['U+FF76 (half-width katakana)', 0xff76],
    ['U+1B000 (Kana Supplement)', 0x1b000],
    ['U+20B9F (CJK Extension B)', 0x20b9f],
  ])('matches %s', (_name, codePoint) => {
    expect(JAPANESE.test(String.fromCodePoint(codePoint))).toBe(true)
  })

  it.each([
    ['a', 0x61],
    ['U+00D7 (multiplication sign)', 0xd7],
    ['U+2026 (ellipsis)', 0x2026],
    ['U+2500 (box drawing)', 0x2500],
    ['U+1F600 (emoji)', 0x1f600],
  ])('does not match %s', (_name, codePoint) => {
    expect(JAPANESE.test(String.fromCodePoint(codePoint))).toBe(false)
  })
})

describe('english-only source', () => {
  it('src/, test/ and Makefile contain no Japanese characters (kana, kanji, full-width symbols)', () => {
    const files = [...sourceFiles('src'), ...sourceFiles('test'), 'Makefile'].sort()
    expect(files).toContain('test/english-only.test.ts')
    expect(files).toContain('test/fixtures/exec-preload.mjs')
    expect(files.flatMap(japaneseLines)).toEqual([])
  })
})
