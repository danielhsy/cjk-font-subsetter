import { readFileSync } from 'fs'

export interface FontConfig {
  src: string
  family: string
  weight?: number | string
  style?: string
  output?: string
  fontUrlBase?: string
  axisLimits?: Record<string, string>
  commonChars?: string  // characters forced into the common subset for this font family
}

export interface EntryConfig {
  files?: string | string[]
  url?: string
  chars?: string  // literal characters always included regardless of extraction
}

export interface PageConfig extends EntryConfig {
  name: string
}

export interface Config {
  fontDisplay?: string
  cssOutput?: string
  sectionCssOutput?: string
  fonts: FontConfig[]
  common?: EntryConfig
  pages?: PageConfig[]
}

export function loadConfig(configPath: string): Config {
  return JSON.parse(readFileSync(configPath, 'utf8')) as Config
}
