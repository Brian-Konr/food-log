// Shared helpers for the ops scripts. These scripts only PRINT SQL / wrangler commands.
// Brian runs the printed commands himself; nothing here talks to Cloudflare.
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

/** SQL string literal. */
export const sqlStr = (s: string): string => `'${s.replaceAll("'", "''")}'`

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

/** `pnpm exec wrangler d1 execute <db> --remote --command '<sql>'` */
export function wranglerCommand(db: string, where: string, sql: string): string {
  return `pnpm --filter @food-log/api exec wrangler d1 execute ${db} ${where} --command ${shQuote(sql.replace(/\s+/g, ' ').trim())}`
}
