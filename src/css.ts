import type { SubsetOutput } from './subset.js'

export function toUnicodeRange(chars: Set<string>): string | null {
  const points = [...chars].map(ch => ch.codePointAt(0)!).sort((a, b) => a - b)
  if (points.length === 0) return null

  const ranges: string[] = []
  let start = points[0], end = points[0]
  for (let i = 1; i < points.length; i++) {
    if (points[i] === end + 1) {
      end = points[i]
    } else {
      ranges.push(formatRange(start, end))
      start = end = points[i]
    }
  }
  ranges.push(formatRange(start, end))
  return ranges.join(', ')
}

function formatRange(start: number, end: number): string {
  const hex = (n: number) => n.toString(16).toUpperCase()
  return start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`
}

export interface FontFaceOptions {
  family: string
  weight?: number | string
  style?: string
  fontDisplay: string
  srcs: SubsetOutput[]
  unicodeRange: string | null
}

export function fontFaceBlock({ family, weight, style, fontDisplay, srcs, unicodeRange }: FontFaceOptions): string {
  // variable fonts use range values e.g. weight "100 900", style "oblique 0deg 10deg"
  const src = srcs.map(({ outFile, format }) => `url('${outFile}') format('${format}')`).join(',\n       ')
  const lines = [
    `@font-face {`,
    `  font-family: '${family}';`,
    `  font-weight: ${weight ?? 400};`,
    `  font-style: ${style ?? 'normal'};`,
    `  font-display: ${fontDisplay};`,
    `  src: ${src};`,
  ]
  if (unicodeRange) lines.push(`  unicode-range: ${unicodeRange};`)
  lines.push(`}`)
  return lines.join('\n')
}
