#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { resolve, dirname, join, basename, extname } from 'path'
import { glob } from 'glob'

const configPath = resolve(process.argv[2] ?? 'subset.config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))

// --- character extraction ---

function extractChars(text) {
  // all non-ASCII + printable ASCII (let pyftsubset ignore what's not in the font)
  return new Set([...text].filter(ch => ch.codePointAt(0) > 0x20))
}

async function charsFromFiles(patterns, base) {
  const chars = new Set()
  const files = await glob(patterns, { cwd: base, absolute: true, nodir: true })
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const ch of extractChars(text)) chars.add(ch)
  }
  return chars
}

function subtract(setA, setB) {
  const result = new Set(setA)
  for (const ch of setB) result.delete(ch)
  return result
}

// --- unicode-range CSS value ---

function toUnicodeRange(chars) {
  const points = [...chars].map(ch => ch.codePointAt(0)).sort((a, b) => a - b)
  if (points.length === 0) return null

  const ranges = []
  let start = points[0], end = points[0]

  for (let i = 1; i < points.length; i++) {
    if (points[i] === end + 1) {
      end = points[i]
    } else {
      ranges.push(start === end ? `U+${start.toString(16).toUpperCase()}` : `U+${start.toString(16).toUpperCase()}-${end.toString(16).toUpperCase()}`)
      start = end = points[i]
    }
  }
  ranges.push(start === end ? `U+${start.toString(16).toUpperCase()}` : `U+${start.toString(16).toUpperCase()}-${end.toString(16).toUpperCase()}`)

  return ranges.join(', ')
}

// --- pyftsubset ---

const FORMATS = [
  { flavor: 'woff2', ext: 'woff2' },
  { flavor: 'woff',  ext: 'woff'  },
]

function runSubset(fontSrc, chars, outFile, flavor, axisLimits) {
  mkdirSync(dirname(outFile), { recursive: true })

  const text = [...chars].join('')
  const axisFlags = Object.entries(axisLimits ?? {}).map(([tag, range]) => `--axis-limits=${tag}=${range}`)
  execFileSync('pyftsubset', [
    fontSrc,
    `--text=${text}`,
    `--output-file=${outFile}`,
    `--flavor=${flavor}`,
    '--layout-features=*',  // preserve GSUB/GPOS (needed for correct CJK rendering)
    '--desubroutinize',     // workaround for fonttools bug in CID-keyed CFF fonts (common in CJK)
    ...axisFlags,
  ], { stdio: ['ignore', 'inherit', 'inherit'] })
}

function runSubsets(fontSrc, chars, stem, outDir, name, axisLimits) {
  if (chars.size === 0) {
    console.warn(`  skipping ${name} — no characters`)
    return []
  }
  return FORMATS.map(({ flavor, ext }) => {
    const outFile = join(outDir, `${stem}.${name}.${ext}`)
    runSubset(fontSrc, chars, outFile, flavor, axisLimits)
    return { outFile, format: ext }
  })
}

// --- CSS generation ---

function fontFaceBlock({ family, weight, style, srcs, unicodeRange }) {
  const src = srcs.map(({ outFile, format }) => `url('${outFile}') format('${format}')`).join(',\n       ')
  // variable fonts use range values e.g. weight "100 900", style "oblique 0deg 10deg"
  const lines = [
    `@font-face {`,
    `  font-family: '${family}';`,
    `  font-weight: ${weight ?? 400};`,
    `  font-style: ${style ?? 'normal'};`,
    `  font-display: ${config.fontDisplay ?? 'swap'};`,
    `  src: ${src};`,
  ]
  if (unicodeRange) lines.push(`  unicode-range: ${unicodeRange};`)
  lines.push(`}`)
  return lines.join('\n')
}

// --- main ---

async function main() {
  const base = dirname(configPath)

  for (const font of config.fonts) {
    const fontSrc = resolve(base, font.src)
    const outDir = resolve(base, font.output ?? 'dist/fonts')
    const stem = basename(font.src, extname(font.src))
    const cssBlocks = []

    console.log(`\nProcessing ${basename(fontSrc)}`)

    // common subset
    let commonChars = new Set()
    if (config.common) {
      const patterns = [config.common.files].flat()
      commonChars = await charsFromFiles(patterns, base)
      console.log(`  common: ${commonChars.size} chars from ${patterns.join(', ')}`)

      const srcs = runSubsets(fontSrc, commonChars, stem, outDir, 'common', font.axisLimits)
      if (srcs.length) {
        cssBlocks.push(fontFaceBlock({
          family: font.family,
          weight: font.weight,
          style: font.style,
          srcs: srcs.map(({ outFile, format }) => ({ outFile: join(font.output ?? 'dist/fonts', basename(outFile)), format })),
          unicodeRange: toUnicodeRange(commonChars),
        }))
      }
    }

    // per-page subsets
    for (const page of (config.pages ?? [])) {
      const patterns = [page.files].flat()
      const allPageChars = await charsFromFiles(patterns, base)
      const pageChars = subtract(allPageChars, commonChars)
      console.log(`  ${page.name}: ${pageChars.size} unique chars (${allPageChars.size} total)`)

      const srcs = runSubsets(fontSrc, pageChars, stem, outDir, page.name, font.axisLimits)
      if (srcs.length) {
        cssBlocks.push(fontFaceBlock({
          family: font.family,
          weight: font.weight,
          style: font.style,
          srcs: srcs.map(({ outFile, format }) => ({ outFile: join(font.output ?? 'dist/fonts', basename(outFile)), format })),
          unicodeRange: toUnicodeRange(pageChars),
        }))
      }
    }

    // write CSS
    if (cssBlocks.length > 0) {
      const cssPath = join(outDir, `${stem}.css`)
      writeFileSync(cssPath, cssBlocks.join('\n\n') + '\n')
      console.log(`  wrote ${cssPath}`)
    }
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
