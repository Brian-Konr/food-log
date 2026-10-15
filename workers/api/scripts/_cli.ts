// Shared helpers for the ops scripts. These scripts only PRINT SQL / wrangler commands (and bot-key.ts writes one local
// 600-permission file). Brian runs the printed commands himself; nothing here talks to Cloudflare.
export const DEFAULT_DB = 'food-log'

export function parseArgs(argv: string[]): { flags: Set<string>; opts: Record<string, string> } {
  const flags = new Set<string>()
  const opts: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next
      i++
    } else flags.add(key)
  }
  return { flags, opts }
}

export { sqlStr } from '../src/ops-sql.ts'

/** POSIX shell single-quote. */
export const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

export function assertEmail(email: string | undefined): string {
  if (!email || !/^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email)) {
    console.error('error: --email <address> is required (the address must also be in the ALLOWED_EMAILS secret)')
    process.exit(2)
  }
  return email.toLowerCase()
}

export function target(flags: Set<string>): '--remote' | '--local' {
  if (flags.has('remote') && flags.has('local')) {
    console.error('error: pick one of --remote / --local')
    process.exit(2)
  }
  return flags.has('remote') ? '--remote' : '--local'
}

/** `pnpm --filter @food-log/api exec wrangler d1 execute <db> --remote --command '<sql>'` (local pnpm: `npx -y pnpm@10 ...`). */
export function wranglerCommand(db: string, where: string, sql: string): string {
  return `npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute ${db} ${where} --command ${shQuote(sql.replace(/\s+/g, ' ').trim())}`
}
