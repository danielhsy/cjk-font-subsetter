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

// For each unique character in elements that include fontFamily in their computed
// font stack, use canvas to check whether removing fontFamily from the stack
// changes the rendered output. If it does, fontFamily is rendering that character.
// This correctly excludes e.g. Latin text that a font earlier in the stack handles.
export async function charsFromURL(page: Page, url: string, fontFamily: string): Promise<Set<string>> {
  await page.goto(url, { waitUntil: 'networkidle2' })
  await page.evaluate(() => document.fonts.ready)

  const chars = await page.evaluate((targetFamily: string): string[] => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')!

    function renderPixels(char: string, fontSpec: string): Uint8ClampedArray {
      ctx.clearRect(0, 0, 64, 64)
      ctx.font = `32px ${fontSpec}`
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

    // Walk visible text nodes in elements that include our font in their stack.
    // Record one (fullStack, stackWithoutTarget) pair per unique character —
    // glyph presence is a font-level property so first occurrence is sufficient.
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
  }, fontFamily)

  return new Set(chars)
}
