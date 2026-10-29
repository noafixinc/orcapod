import { describe, expect, it } from 'vitest'
import { cellText, displayWidth, fitWidth } from '../src/terminal-text.ts'

describe('displayWidth', () => {
  it.each([
    ['ASCII', 'abc', 3],
    ['Kanji', '\u6f22\u5b57', 4],
    ['Half-width katakana', '\uff76\uff85', 2],
    ['e + U+0301 combining character', 'é', 1],
    ['ZWJ emoji sequence', '👨‍👩‍👧', 2],
    ['© without Emoji_Presentation', '©', 1],
    ['© with U+FE0F', '©️', 2],
    ['U+1B000', '\u{1b000}', 2],
    ['Full-width parentheses and corner brackets', '\uff08\u300c\u300d\uff09', 8],
    ['Box-drawing characters and ellipsis have width 1', '─│┌┐└┘├┤…', 9],
    ['Combining character only', '́', 0],
    ['A and B separated by U+200B (zero-width space)', 'A​B', 2],
    ['U+200C, U+200D, U+200E, U+200F, U+2060, U+2064, U+FEFF only', '‌‍‎‏⁠⁤﻿', 0],
    ['Variation selectors U+FE00 and U+E0100 only', '︀\u{e0100}', 0],
    ['U+00AD (soft hyphen) has width 1', 'a­b', 3],
  ])('%s', (_name, text, expected) => {
    expect(displayWidth(text)).toBe(expected)
  })
})

describe('fitWidth', () => {
  it('A24: with width 80, 79 a-characters + U+1B000 (width 2) become 79 a-characters + an ellipsis, fitting in 80 columns without overflow', () => {
    expect(fitWidth(`${'a'.repeat(79)}\u{1b000}`, 80)).toBe(`${'a'.repeat(79)}…`)
  })

  it('A24: a width-2 character that does not fit in the last column is replaced with padding', () => {
    expect(fitWidth(`${'a'.repeat(78)}\u{1b000}b`, 80)).toBe(`${'a'.repeat(78)}… `)
    expect(fitWidth('\u6f22\u5b57\u304b\u306a', 6)).toBe('\u6f22\u5b57… ')
  })

  it('A24: a single © is padded as width 1', () => {
    expect(fitWidth('©', 3)).toBe('©  ')
  })

  it('I6: zero-width format characters are padded as width 0 and not counted as columns even when truncating', () => {
    expect(fitWidth('A​B', 5)).toBe('A​B   ')
    expect(fitWidth('a​bc⁠def', 4)).toBe('a​bc⁠…')
  })

  it('a string that fits the width is padded with spaces, and width 0 yields an empty string', () => {
    expect(fitWidth('\u6f22\u5b57', 6)).toBe('\u6f22\u5b57  ')
    expect(fitWidth('abc', 0)).toBe('')
    expect(fitWidth('abc', 1)).toBe('…')
  })

  it('A23: control characters (C0, DEL, C1) and lone surrogates each become one space before the width is counted', () => {
    expect(fitWidth('a\u001b[2Jb\u0007\n\t\u007f\u009b31m', 14)).toBe('a [2Jb     31m')
    expect(fitWidth('x\ud800y\udc00z', 6)).toBe('x y z ')
    expect(fitWidth('😀', 3)).toBe('😀 ')
  })
})

describe('cell edges', () => {
  it.each(['\ufe0f', '\u3099', '\u309a', '\u0301', '\u200d', '\ufeff', '\u{e0100}'])('U+%s at the start of a cell does not change the width of the joined row', (mark) => {
    const row = `\u2502${fitWidth(`${mark}abc`, 78)}\u2502`
    expect(displayWidth(row)).toBe(80)
    expect(cellText(`${mark}abc`)).toBe('abc')
  })

  it('a format character at the end of a cell does not merge with the next border', () => {
    const row = `\u2502${fitWidth('abc\u0600', 5)}\u2502`
    expect(displayWidth(row)).toBe(7)
  })
})
