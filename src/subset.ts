import { mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname, basename, relative } from 'path'

const FORMATS = [
  { flavor: 'woff2', ext: 'woff2' },
  { flavor: 'woff',  ext: 'woff'  },
] as const

export interface SubsetOutput {
  outFile: string
  format: string
}

function runSubset(fontSrc: string, chars: Set<string>, outFile: string, flavor: string, axisLimits?: Record<string, string>): void {
  mkdirSync(dirname(outFile), { recursive: true })

  const axisFlags = Object.entries(axisLimits ?? {}).map(([tag, range]) => `--axis-limits=${tag}=${range}`)
  execFileSync('pyftsubset', [
    fontSrc,
    `--text=${[...chars].join('')}`,
    `--output-file=${outFile}`,
    `--flavor=${flavor}`,
    '--layout-features=*',  // preserve GSUB/GPOS (needed for correct CJK rendering)
    '--desubroutinize',     // workaround for fonttools bug in CID-keyed CFF fonts (common in CJK)
    ...axisFlags,
  ], { stdio: ['ignore', 'inherit', 'inherit'] })
}

export function runSubsets(
  fontSrc: string,
  chars: Set<string>,
  stem: string,
  outDir: string,
  name: string,
  axisLimits?: Record<string, string>,
): SubsetOutput[] {
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

// cssDir: absolute path to the directory where the CSS file will be written.
// relative(cssDir, outFile) gives the correct relative URL regardless of whether
// the CSS is co-located with the fonts or in a separate directory.
export function cssSrcPaths(srcs: SubsetOutput[], cssDir: string, urlBase?: string): SubsetOutput[] {
  return srcs.map(({ outFile, format }) => ({
    outFile: urlBase
      ? `${urlBase.replace(/\/$/, '')}/${basename(outFile)}`
      : relative(cssDir, outFile),
    format,
  }))
}
