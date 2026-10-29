const ELLIPSIS = '…'
const EAST_ASIAN_WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f200, 0x1f2ff], [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u
const SOFT_HYPHEN = '­'
const ZERO_WIDTH_ONLY = /^[\p{M}\p{Cf}]+$/u
const LEADING_ZERO_WIDTH = /^[\p{M}\p{Cf}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]+/u
const TRAILING_FORMAT = /\p{Cf}+$/u
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' })

export function displayWidth(text: string): number {
  let width = 0
  for (const { segment } of graphemes.segment(text)) width += graphemeWidth(segment)
  return width
}

export function fitWidth(text: string, width: number): string {
  const clipped = clip(text, width)
  return clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped)))
}

export function printableLines(text: string): string {
  return text.split('\n').map(printable).join('\n')
}

function graphemeWidth(grapheme: string): number {
  if (EMOJI_PRESENTATION.test(grapheme) || grapheme.includes('️')) return 2
  const codePoint = grapheme.codePointAt(0) ?? 0
  if (EAST_ASIAN_WIDE_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last)) return 2
  if (ZERO_WIDTH_ONLY.test(grapheme) && !grapheme.includes(SOFT_HYPHEN)) return 0
  return 1
}

function isControl(unit: number): boolean {
  return unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

export function printable(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    if (isHighSurrogate(unit) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
      out += text.slice(i, i + 2)
      i += 1
    } else {
      out += isControl(unit) || isHighSurrogate(unit) || isLowSurrogate(unit) ? ' ' : text[i]
    }
  }
  return out
}

export function cellText(text: string): string {
  return printable(text).replace(LEADING_ZERO_WIDTH, '').replace(TRAILING_FORMAT, '')
}

export function clip(text: string, width: number): string {
  const safe = cellText(text)
  if (displayWidth(safe) <= width) return safe
  if (width <= 0) return ''
  let kept = ''
  let used = 0
  for (const { segment } of graphemes.segment(safe)) {
    const segmentWidth = graphemeWidth(segment)
    if (used + segmentWidth > width - 1) break
    kept += segment
    used += segmentWidth
  }
  return kept + ELLIPSIS
}
