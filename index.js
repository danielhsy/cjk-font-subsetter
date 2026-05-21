#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { resolve, dirname, join, basename, extname } from 'path'
import { glob } from 'glob'
import { parse as parseHTML } from 'node-html-parser'

const configPath = resolve(process.argv[2] ?? 'subset.config.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))

// --- character extraction: files ---

function extractChars(text) {
  return new Set([...text].filter(ch => ch.codePointAt(0) > 0x20))
}

function extractCharsFromHTML(html) {
  const root = parseHTML(html)
  root.querySelectorAll('script, style').forEach(el => el.remove())
  return extractChars(root.text)
}

async function charsFromFiles(patterns, base) {
  const chars = new Set()
  const files = await glob(patterns, { cwd: base, absolute: true, nodir: true })
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const fileChars = /\.html?$/.test(file) ? extractCharsFromHTML(text) : extractChars(text)
    for (const ch of fileChars) chars.add(ch)
  }
  return chars
}

// --- character extraction: browser ---
//
// For each unique character in elements that include fontFamily in their computed
// font stack, we use canvas to check whether removing fontFamily from that stack
// changes the rendered output. If it does, fontFamily is the one rendering the
// character — so we include it. If it doesn't (e.g. a Latin font earlier in the
// stack already handles it), we skip it.

async function charsFromURL(browserPage, url, fontFamily) {
  await browserPage.goto(url, { waitUntil: 'networkidle2' })
  await browserPage.evaluate(() => document.fonts.ready)

  const chars = await browserPage.evaluate((targetFamily) => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')

    function renderPixels(char, fontSpec) {
      ctx.clearRect(0, 0, 64, 64)
      ctx.font = `32px ${fontSpec}`
      ctx.fillText(char, 4, 48)
      return ctx.getImageData(0, 0, 64, 64).data
    }

    function targetRendersChar(char, fullStack, stackWithoutTarget) {
      const with_ = renderPixels(char, fullStack)
      const without = renderPixels(char, stackWithoutTarget)
      for (let i = 0; i < with_.length; i++) {
        if (with_[i] !== without[i]) return true
      }
      return false
    }

    // Walk visible text nodes in elements that include our font in their stack.
    // For each unique character, record one (fullStack, stackWithoutTarget) pair
    // to test against — first occurrence is fine since glyph presence is a font-
    // level property, not element-level.
    const candidates = new Map() // char → { fullStack, stackWithoutTarget }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const el = node.parentElement
      if (!el) continue
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue

      const families = style.fontFamily.split(',').map(f => f.trim().replace(/['"]/g, ''))
      if (!families.some(f => f.toLowerCase() === targetFamily.toLowerCase())) continue

      const withoutTarget = families
        .filter(f => f.toLowerCase() !== targetFamily.toLowerCase())
        .join(', ') || 'serif'

      for (const ch of node.textContent) {
        if (ch.codePointAt(0) > 0x20 && !candidates.has(ch)) {
          candidates.set(ch, { fullStack: style.fontFamily, withoutTarget })
        }
      }
    }

    // Canvas-check each candidate
    const result = []
    for (const [char, { fullStack, withoutTarget }] of candidates) {
      if (targetRendersChar(char, fullStack, withoutTarget)) result.push(char)
    }
    return result
  }, fontFamily)

  return new Set(chars)
}

// --- set helpers ---

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

  // Launch browser only if any entry uses a URL
  const allEntries = [config.common, ...(config.pages ?? [])].filter(Boolean)
  const needsBrowser = allEntries.some(e => e.url)
  let browser = null
  let browserPage = null

  if (needsBrowser) {
    let puppeteer
    try {
      puppeteer = await import('puppeteer')
    } catch {
      throw new Error('Browser mode requires puppeteer: npm install puppeteer')
    }
    browser = await puppeteer.default.launch()
    browserPage = await browser.newPage()
  }

  try {
    for (const font of config.fonts) {
      const fontSrc = resolve(base, font.src)
      const outDir = resolve(base, font.output ?? 'dist/fonts')
      const stem = basename(font.src, extname(font.src))
      const cssBlocks = []

      console.log(`\nProcessing ${basename(fontSrc)}`)

      async function extractEntry(entry) {
        const chars = new Set()
        if (entry.files) {
          const patterns = [entry.files].flat()
          for (const ch of await charsFromFiles(patterns, base)) chars.add(ch)
        }
        if (entry.url) {
          for (const ch of await charsFromURL(browserPage, entry.url, font.family)) chars.add(ch)
        }
        return chars
      }

      // common subset
      let commonChars = new Set()
      if (config.common) {
        commonChars = await extractEntry(config.common)
        const src = config.common.url ?? [config.common.files].flat().join(', ')
        console.log(`  common: ${commonChars.size} chars from ${src}`)

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
        const allPageChars = await extractEntry(page)
        const pageChars = subtract(allPageChars, commonChars)
        const src = page.url ?? [page.files].flat().join(', ')
        console.log(`  ${page.name}: ${pageChars.size} unique chars (${allPageChars.size} total) from ${src}`)

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
  } finally {
    if (browser) await browser.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
