import { readFileSync } from 'fs'
import { glob } from 'glob'
import { parse as parseHTML } from 'node-html-parser'
import type { Page } from 'puppeteer'

function extractChars(text: string): Set<string> {
  return new Set([...text].filter(ch => ch.codePointAt(0)! > 0x20))
}

function extractCharsFromHTML(html: string): Set<string> {
  const root = parseHTML(html)
  root.querySelectorAll('script, style').forEach(el => el.remove())
  return extractChars(root.text)
}

export async function charsFromFiles(patterns: string[], base: string): Promise<Set<string>> {
  const chars = new Set<string>()
  const files = await glob(patterns, { cwd: base, absolute: true, nodir: true })
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const fileChars = /\.html?$/.test(file) ? extractCharsFromHTML(text) : extractChars(text)
    for (const ch of fileChars) chars.add(ch)
  }
  return chars
}

// For each character in elements whose computed font stack includes fontFamily
// (and, if fontWeight is given, whose computed font-weight matches), use canvas
// to check whether removing fontFamily from the stack changes the rendered output
// at the given weight. This correctly excludes characters rendered by earlier
// fonts in the stack (e.g. Latin text covered by Noto before GenKiMin2TW).
export async function charsFromURL(
  page: Page,
  url: string,
  fontFamily: string,
  fontWeight?: number,
): Promise<Set<string>> {
  await page.goto(url, { waitUntil: 'networkidle2' })
  await page.evaluate(() => document.fonts.ready)

  const chars = await page.evaluate((targetFamily: string, targetWeight: number | null): string[] => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')!

    function renderPixels(char: string, fontSpec: string): Uint8ClampedArray {
      ctx.clearRect(0, 0, 64, 64)
      ctx.font = `${targetWeight ?? 400} 32px ${fontSpec}`
      ctx.fillText(char, 4, 48)
      return ctx.getImageData(0, 0, 64, 64).data
    }

    function targetRendersChar(char: string, fullStack: string, stackWithoutTarget: string): boolean {
      const with_ = renderPixels(char, fullStack)
      const without = renderPixels(char, stackWithoutTarget)
      for (let i = 0; i < with_.length; i++) {
        if (with_[i] !== without[i]) return true
      }
      return false
    }

    const candidates = new Map<string, { fullStack: string; stackWithoutTarget: string }>()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const el = node.parentElement
      if (!el) continue
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue

      const families = style.fontFamily.split(',').map(f => f.trim().replace(/['"]/g, ''))
      if (!families.some(f => f.toLowerCase() === targetFamily.toLowerCase())) continue

      if (targetWeight !== null && parseInt(style.fontWeight) !== targetWeight) continue

      const stackWithoutTarget = families
        .filter(f => f.toLowerCase() !== targetFamily.toLowerCase())
        .join(', ') || 'serif'

      for (const ch of node.textContent ?? '') {
        if (ch.codePointAt(0)! > 0x20 && !candidates.has(ch)) {
          candidates.set(ch, { fullStack: style.fontFamily, stackWithoutTarget })
        }
      }
    }

    return [...candidates.entries()]
      .filter(([char, { fullStack, stackWithoutTarget }]) =>
        targetRendersChar(char, fullStack, stackWithoutTarget))
      .map(([char]) => char)
  }, fontFamily, fontWeight ?? null)

  return new Set(chars)
}
