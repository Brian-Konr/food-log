// Tiny CLI helpers shared by the tools (no dependencies).
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function parseArgs(argv: string[]): { flags: Set<string>; opts: Record<string, string>; rest: string[] } {
  const flags = new Set<string>()
  const opts: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) {
      rest.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) {
      opts[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next
      i++
    } else flags.add(key)
  }
  return { flags, opts, rest }
}

/** true when this module is the script node / tsx was started with (not when it is imported by a test). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(realpathSync(entry)).href === metaUrl
  } catch {
    return false
  }
}

export function die(message: string, code = 2): never {
  console.error(`error: ${message}`)
  process.exit(code)
}

/** POSIX shell single-quote. */
export const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

/** 20261015-093000 (UTC) for file names. */
export function fileStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}
