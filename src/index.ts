import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname, join, basename, extname } from 'path'
import { loadConfig, type EntryConfig } from './config.js'
import { charsFromFiles, charsFromURL } from './extract.js'
import { runSubsets, cssSrcPaths } from './subset.js'
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
    const allCssBlocks: string[] = []

    for (const font of config.fonts) {
      const fontSrc = resolve(base, font.src)
      const outDir = resolve(base, font.output ?? 'dist/fonts')
      const stem = basename(font.src, extname(font.src))
      const fontCssBlocks: string[] = []

      console.log(`\nProcessing ${basename(fontSrc)}`)

      const cssPathsFor = (srcs: ReturnType<typeof runSubsets>) =>
        cssSrcPaths(srcs, font.output ?? 'dist/fonts', font.fontUrlBase)

      let commonChars = new Set<string>()
      if (config.common) {
        commonChars = await extractEntry(config.common, font.family, browserPage)
        const src = config.common.url ?? [config.common.files ?? []].flat().join(', ')
        console.log(`  common: ${commonChars.size} chars from ${src}`)

        const srcs = runSubsets(fontSrc, commonChars, stem, outDir, 'common', font.axisLimits)
        if (srcs.length) {
          fontCssBlocks.push(fontFaceBlock({
            family: font.family,
            weight: font.weight,
            style: font.style,
            fontDisplay: config.fontDisplay ?? 'swap',
            srcs: cssPathsFor(srcs),
            unicodeRange: toUnicodeRange(commonChars),
          }))
        }
      }

      for (const page of (config.pages ?? [])) {
        const allPageChars = await extractEntry(page, font.family, browserPage)
        const pageChars = subtract(allPageChars, commonChars)
        const src = page.url ?? [page.files ?? []].flat().join(', ')
        console.log(`  ${page.name}: ${pageChars.size} unique chars (${allPageChars.size} total) from ${src}`)

        const srcs = runSubsets(fontSrc, pageChars, stem, outDir, page.name, font.axisLimits)
        if (srcs.length) {
          fontCssBlocks.push(fontFaceBlock({
            family: font.family,
            weight: font.weight,
            style: font.style,
            fontDisplay: config.fontDisplay ?? 'swap',
            srcs: cssPathsFor(srcs),
            unicodeRange: toUnicodeRange(pageChars),
          }))
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
  } finally {
    await browser?.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
