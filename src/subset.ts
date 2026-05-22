import { mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname, basename } from 'path'

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

export function cssSrcPaths(srcs: SubsetOutput[], outputDir: string, urlBase?: string): SubsetOutput[] {
  return srcs.map(({ outFile, format }) => ({
    outFile: urlBase
      ? `${urlBase.replace(/\/$/, '')}/${basename(outFile)}`
      : join(outputDir, basename(outFile)),
    format,
  }))
}
