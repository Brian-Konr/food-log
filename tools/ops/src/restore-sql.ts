// Export -> D1 restore SQL (disaster recovery). Pure: rows in, SQL text out. restore-drill --emit-sql writes the text to a
// file, and ONLY after the drill itself came out OK; Brian applies it with `wrangler d1 execute food-log --remote --file <file>`.
//
// What the file does, in this order:
//   1. guard      every user_id it is going to write must exist in `user` (otherwise the batch aborts before anything is deleted)
//   2. clear      DELETE FROM sync_clients, mutation_outcomes and the six business tables (stores, items, logs, weights, favorites, config)
//   3. insert     every exported row, multi-row INSERTs (<= 100 rows and <= ~50 KB of SQL each: D1 caps one statement at 100 KB)
//   4. meta       version = max(highest row version, versionAtEnd); epoch = a NEW value, so every client's pull answers reset:true
//                 (needsReset: epoch differs) and rebuilds its local copy from the server
// It never touches the auth tables (user, session, account, verification, passkey, apikey, login_codes) or export_progress.
// meta keys and formats: 0001_init.sql (`meta(key, value ANY)`, rows 'version' = integer, 'epoch' = text such as 'e1'), d1-store.ts (headOf / META_SQL).
// One statement per line (control characters in strings are written with char()), like tools/migrate/emit-sql.
// No BEGIN / COMMIT: D1 rejects them in a file. The file is safe to apply again (it starts with the deletes), which is the recovery if an apply stops half way.
import { randomBytes } from 'node:crypto'

export type Row = Record<string, unknown>

/** the six business tables, in insert order (no foreign keys between them) */
const BUSINESS = ['stores', 'items', 'logs', 'weights', 'favorites', 'config'] as const
/** cleared as well: per-device cursors and recorded outcomes belong to the old data set */
const CLEARED_EXTRA = ['sync_clients', 'mutation_outcomes'] as const

export const MAX_INSERT_ROWS = 100
export const MAX_INSERT_BYTES = 50_000

/** `e` + 12 random hex digits. No ':' (the pull cookie is `<epoch>:<version>`). */
export const newEpoch = (): string => 'e' + randomBytes(6).toString('hex')

/** One SQL literal. Strings: single quotes doubled (SQLite has no other escape in '...'); NUL is refused; arrays / objects become JSON text. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`cannot write a non-finite number to SQL: ${String(v)}`)
    return String(v)
  }
  if (typeof v === 'boolean') return v ? '1' : '0'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s.includes('\u0000')) throw new Error('cannot write a string containing NUL to SQL')
  // eslint-disable-next-line no-control-regex
  if (!/[\u0001-\u001f]/.test(s)) return `'${s.replaceAll("'", "''")}'`
  // control characters (newline, tab, ...) via char(): the file stays one statement per line, so it survives line-based splitting
  return s
    .split(/([\u0001-\u001f])/)
    .filter((p) => p !== '')
    .map((p) => (p.length === 1 && p.charCodeAt(0) < 32 ? `char(${p.charCodeAt(0)})` : `'${p.replaceAll("'", "''")}'`))
    .join(' || ')
}

const IDENT = /^[a-z][a-z0-9_]*$/

export type RestoreSqlInput = {
  rowsByTable: Record<string, Row[]>
  versionAtEnd: number
  epoch: string
  exportDay: string
  /** rewrite every row's user_id (only allowed when the export has exactly one user) */
  userId?: string
}

export type RestoreSql = { sql: string; version: number; users: number; statements: number }

export function buildRestoreSql(input: RestoreSqlInput): RestoreSql {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.epoch)) throw new Error(`invalid epoch: ${input.epoch}`)
  if (input.userId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.userId)) throw new Error('--user-id must be 1-64 characters of A-Z a-z 0-9 _ -')
  const stmts: string[] = []

  // ---- which users ----
  const exported = new Set<string>()
  for (const t of BUSINESS) for (const r of input.rowsByTable[t] ?? []) exported.add(String(r.user_id))
  if (input.userId !== undefined && exported.size > 1) throw new Error(`--user-id needs a single-user export, this one has ${exported.size} users`)
  const target = input.userId !== undefined && exported.size === 1 ? new Set([input.userId]) : exported

  // ---- 1. guard ----
  if (target.size > 0) {
    const ids = [...target].map(sqlLiteral).join(', ')
    stmts.push(`INSERT INTO cas_guard (ok) SELECT CASE WHEN (SELECT COUNT(*) FROM user WHERE id IN (${ids})) = ${target.size} THEN 1 ELSE 0 END`)
    stmts.push('DELETE FROM cas_guard')
  }

  // ---- 2. clear ----
  for (const t of [...CLEARED_EXTRA, ...BUSINESS]) stmts.push(`DELETE FROM ${t}`)

  // ---- 3. insert ----
  let maxVersion = 0
  for (const t of BUSINESS) {
    const rows = input.rowsByTable[t] ?? []
    if (rows.length === 0) continue
    const cols = Object.keys(rows[0]!)
    for (const c of cols) if (!IDENT.test(c)) throw new Error(`${t}: unsafe column name ${JSON.stringify(c)}`)
    const head = `INSERT INTO ${t} (${cols.join(', ')}) VALUES `
    let values: string[] = []
    let bytes = head.length
    const flush = () => {
      if (values.length > 0) stmts.push(head + values.join(', '))
      values = []
      bytes = head.length
    }
    for (const r of rows) {
      const keys = Object.keys(r)
      if (keys.length !== cols.length || keys.some((k, i) => k !== cols[i])) throw new Error(`${t}: rows do not all have the same columns`)
      const v = typeof r.version === 'number' ? r.version : Number(r.version)
      if (!Number.isInteger(v) || v < 0) throw new Error(`${t}: bad version ${String(r.version)}`)
      if (v > maxVersion) maxVersion = v
      const line = '(' + cols.map((c) => sqlLiteral(c === 'user_id' && input.userId !== undefined ? input.userId : r[c])).join(', ') + ')'
      if (values.length >= MAX_INSERT_ROWS || (values.length > 0 && bytes + line.length > MAX_INSERT_BYTES)) flush()
      values.push(line)
      bytes += line.length + 2
    }
    flush()
  }

  // ---- 4. meta ----
  const version = Math.max(maxVersion, input.versionAtEnd)
  if (!Number.isInteger(version) || version < 0) throw new Error(`bad version ${String(version)}`)
  stmts.push(`INSERT INTO meta (key, value) VALUES ('version', ${version}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
  stmts.push(`INSERT INTO meta (key, value) VALUES ('epoch', ${sqlLiteral(input.epoch)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)

  const header = [
    `-- food-log restore from export ${input.exportDay} (generated by restore-drill --emit-sql)`,
    `-- clears sync_clients, mutation_outcomes and the six business tables, inserts the exported rows`,
    `-- sets meta.version to ${version} and meta.epoch to ${input.epoch}, so every client resets and re-pulls`,
    `-- leaves user, session, account, verification, passkey, apikey, login_codes and export_progress alone`,
    `-- apply: wrangler d1 execute food-log --remote --file <this file>   (safe to apply again if it stopped half way)`,
    '',
  ].join('\n')
  return { sql: header + stmts.map((s) => s + ';\n').join(''), version, users: target.size, statements: stmts.length }
}
