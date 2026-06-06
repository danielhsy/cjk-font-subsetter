import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname, join, basename, extname } from 'path'
import { loadConfig, type EntryConfig } from './config.js'
import { charsFromFiles, charsFromURL } from './extract.js'
import { runSubsets, cssSrcPaths, type SubsetOutput } from './subset.js'
import { toUnicodeRange, fontFaceBlock } from './css.js'
import type { Page, Browser } from 'puppeteer'

const configPath = resolve(process.argv[2] ?? 'subset.config.json')
const config = loadConfig(configPath)
const base = dirname(configPath)

async function extractEntry(entry: EntryConfig, fontFamily: string, browserPage: Page | null): Promise<Set<string>> {
  const chars = new Set<string>()
  if (entry.files) {
    const patterns = [entry.files].flat()
    for (const ch of await charsFromFiles(patterns, base)) chars.add(ch)
  }
  if (entry.url) {
    if (!browserPage) throw new Error(`url set but browser unavailable — this should not happen`)
    for (const ch of await charsFromURL(browserPage, entry.url, fontFamily)) chars.add(ch)
  }
  return chars
}

function subtract<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set(a)
  for (const x of b) result.delete(x)
  return result
}

interface FamilyData {
  commonChars: Set<string>
  pageCharsMap: Map<string, Set<string>>  // page name → unique chars (common already subtracted)
}

interface SectionEntry {
  family: string
  weight?: number | string
  style?: string
  fontDisplay: string
  unicodeRange: string | null
  rawSrcs: SubsetOutput[]
  urlBase?: string
}

async function main() {
  const allEntries = [config.common, ...(config.pages ?? [])].filter(Boolean)
  const needsBrowser = allEntries.some(e => e?.url)

  let browser: Browser | null = null
  let browserPage: Page | null = null
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
    // Phase 1: extract chars once per unique family name.
    const familyData = new Map<string, FamilyData>()
    const families = [...new Set(config.fonts.map(f => f.family))]

    for (const family of families) {
      console.log(`\nExtracting for family ${family}`)

      let commonChars = new Set<string>()
      if (config.common) {
        commonChars = await extractEntry(config.common, family, browserPage)
        const src = config.common.url ?? [config.common.files ?? []].flat().join(', ')
        console.log(`  common: ${commonChars.size} chars from ${src}`)
      }

      const pageCharsMap = new Map<string, Set<string>>()
      for (const page of (config.pages ?? [])) {
        const allPageChars = await extractEntry(page, family, browserPage)
        const pageChars = subtract(allPageChars, commonChars)
        const src = page.url ?? [page.files ?? []].flat().join(', ')
        console.log(`  ${page.name}: ${pageChars.size} unique chars (${allPageChars.size} total) from ${src}`)
        pageCharsMap.set(page.name, pageChars)
      }

      familyData.set(family, { commonChars, pageCharsMap })
    }

    // Phase 2: subset each font file using the cached extraction results.
    const allCssBlocks: string[] = []
    const sectionCssMap = new Map<string, SectionEntry[]>()

    for (const font of config.fonts) {
      const fontSrc = resolve(base, font.src)
      const outDir = resolve(base, font.output ?? 'dist/fonts')
      const stem = basename(font.src, extname(font.src))
      const fontCssBlocks: string[] = []
      const { commonChars, pageCharsMap } = familyData.get(font.family)!

      console.log(`\nProcessing ${basename(fontSrc)}`)

      const makeCssBlock = (chars: Set<string>, srcs: SubsetOutput[], cssDir: string): string =>
        fontFaceBlock({
          family: font.family,
          weight: font.weight,
          style: font.style,
          fontDisplay: config.fontDisplay ?? 'swap',
          srcs: cssSrcPaths(srcs, cssDir, font.fontUrlBase),
          unicodeRange: toUnicodeRange(chars),
        })

      const recordSection = (name: string, chars: Set<string>, srcs: SubsetOutput[]) => {
        if (!config.sectionCssOutput) return
        const entries = sectionCssMap.get(name) ?? []
        entries.push({
          family: font.family,
          weight: font.weight,
          style: font.style,
          fontDisplay: config.fontDisplay ?? 'swap',
          unicodeRange: toUnicodeRange(chars),
          rawSrcs: srcs,
          urlBase: font.fontUrlBase,
        })
        sectionCssMap.set(name, entries)
      }

      if (config.common) {
        const srcs = runSubsets(fontSrc, commonChars, stem, outDir, 'common', font.axisLimits)
        if (srcs.length) {
          fontCssBlocks.push(makeCssBlock(commonChars, srcs, outDir))
          recordSection('common', commonChars, srcs)
        }
      }

      for (const page of (config.pages ?? [])) {
        const pageChars = pageCharsMap.get(page.name)!
        const srcs = runSubsets(fontSrc, pageChars, stem, outDir, page.name, font.axisLimits)
        if (srcs.length) {
          fontCssBlocks.push(makeCssBlock(pageChars, srcs, outDir))
          recordSection(page.name, pageChars, srcs)
        }
      }

      if (config.cssOutput) {
        allCssBlocks.push(...fontCssBlocks)
      } else if (fontCssBlocks.length > 0) {
        const cssPath = join(outDir, `${stem}.css`)
        writeFileSync(cssPath, fontCssBlocks.join('\n\n') + '\n')
        console.log(`  wrote ${cssPath}`)
      }
    }

    if (config.cssOutput && allCssBlocks.length > 0) {
      const cssPath = resolve(base, config.cssOutput)
      mkdirSync(dirname(cssPath), { recursive: true })
      writeFileSync(cssPath, allCssBlocks.join('\n\n') + '\n')
      console.log(`\nwrote ${cssPath}`)
    }

    if (config.sectionCssOutput && sectionCssMap.size > 0) {
      const sectionDir = resolve(base, config.sectionCssOutput)
      mkdirSync(sectionDir, { recursive: true })
      for (const [name, entries] of sectionCssMap) {
        const cssPath = join(sectionDir, `${name}.css`)
        const blocks = entries.map(entry => fontFaceBlock({
          family: entry.family,
          weight: entry.weight,
          style: entry.style,
          fontDisplay: entry.fontDisplay,
          unicodeRange: entry.unicodeRange,
          srcs: cssSrcPaths(entry.rawSrcs, sectionDir, entry.urlBase),
        }))
        writeFileSync(cssPath, blocks.join('\n\n') + '\n')
        console.log(`  wrote ${cssPath}`)
      }
    }
  } finally {
    await browser?.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
