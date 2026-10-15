// emit-sql: transform output -> SQL files for `wrangler d1 execute <db> --remote --file <file>`.      ⛔ Brian applies them.
//
//   npx -y pnpm@10 --filter @food-log/migrate emit-sql --sheet out/sheet-<stamp>.json --user-id <owner user.id> [--reset] [--local]
//
// * Every row is an upsert keyed like the Worker's own writes:  INSERT ... ON CONFLICT (user_id, id) DO UPDATE
//   (favorites: (user_id, item_id); config: (user_id)). Running the import again just overwrites.
// * At most 500 rows share one version (Workers free plan: the CPU of one pull page is limited, plan 0.2). Each chunk of one
//   table starts with `UPDATE meta SET value = value + 1 WHERE key = 'version'` and its rows are stamped with that new version.
// * --reset first deletes the owner's rows of the six business tables and writes a NEW meta.epoch, so every client resets.
// * WITHOUT --reset an import is only safe as the FIRST import into an EMPTY D1. If the v2 app already wrote rows (a weight on the same
//   day, a store with the same name) the upserts can hit the partial unique indexes and fail midway. For any later import use --reset.
//   If a file fails, do NOT patch around it: re-run the whole import (emit-sql ... --reset) and apply all files again from the first.
// * Output is split into files of at most --max-bytes (default 900 KB), always between chunks, in order: apply them in order.
// * No transaction statements (D1 rejects BEGIN/COMMIT); one statement per line; control characters in strings are written with char().
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { TABLES } from '@food-log/core'
import type { Table } from '@food-log/core'
import { DEFAULT_OUT_DIR } from './fetch-sheet.ts'
import { die, fileStamp, isMain, parseArgs, shQuote } from './cli-util.ts'
import { transform } from './transform.ts'
import type { TransformResult } from './transform.ts'
import type { Anomaly, SheetSnapshot } from './types.ts'

export const MAX_ROWS_PER_VERSION = 500
export const DEFAULT_MAX_FILE_BYTES = 900_000

/** Business columns per table, without user_id and version. Mirrors workers/api/src/db/tables.ts (a test compares it with the real schema). */
export const COLUMNS = {
  stores: ['id', 'name', 'name_norm', 'last_eaten_at', 'created_by', 'ts', 'deleted_at', 'updated_at'],
  items: ['id', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'store_id', 'created_by', 'ts', 'cascade_of', 'deleted_at', 'updated_at'],
  logs: ['id', 'day', 'ts', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb', 'source', 'store_id', 'deleted_at', 'updated_at'],
  weights: ['id', 'day', 'ts', 'kg', 'deleted_at', 'updated_at'],
  favorites: ['item_id', 'deleted_at', 'updated_at'],
  config: ['target_kcal', 'target_protein', 'target_fat', 'target_carb', 'tdee', 'remind_meal_times', 'remind_weight_time', 'deleted_at', 'updated_at'],
} as const satisfies Record<Table, readonly string[]>

/** Primary key columns after user_id (config: one row per user). */
export const PK = {
  stores: ['id'],
  items: ['id'],
  logs: ['id'],
  weights: ['id'],
  favorites: ['item_id'],
  config: [],
} as const satisfies Record<Table, readonly string[]>

export type Rec = Record<string, unknown>

/** SQL literal for a JS value. Strings: quotes doubled, control characters via char() so the file survives line-based splitting. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`cannot write ${v} as SQL`)
    return String(v)
  }
  if (typeof v === 'boolean') return v ? '1' : '0'
  const s = String(v)
  // eslint-disable-next-line no-control-regex
  if (!/[\u0000-\u001f]/.test(s)) return `'${s.replaceAll("'", "''")}'`
  return s
    .split(/([\u0000-\u001f])/)
    .filter((p) => p !== '')
    .map((p) => (p.length === 1 && p.charCodeAt(0) < 32 ? `char(${p.charCodeAt(0)})` : `'${p.replaceAll("'", "''")}'`))
    .join(' || ')
}

/** Rows of a table as plain records (config is one record). */
export function rowsOf(result: TransformResult, table: Table): Rec[] {
  if (table === 'config') return [result.config as unknown as Rec]
  return result[table] as unknown as Rec[]
}

export interface Chunk {
  table: Table
  rows: Rec[]
}

/** The import in order: per table, at most MAX_ROWS_PER_VERSION rows per chunk; one chunk = one version. */
export function chunkRows(result: TransformResult, size = MAX_ROWS_PER_VERSION): Chunk[] {
  const out: Chunk[] = []
  for (const table of TABLES) {
    const rows = rowsOf(result, table)
    for (let i = 0; i < rows.length; i += size) out.push({ table, rows: rows.slice(i, i + size) })
  }
  return out
}

/** The value written to the column (config.remind_meal_times is JSON text in D1). */
export function dbValue(table: Table, col: string, row: Rec): unknown {
  const v = row[col]
  if (table === 'config' && col === 'remind_meal_times') return JSON.stringify(v ?? [])
  return v === undefined ? null : v
}

/** One upsert. `versionExpr` is the SQL that yields the version (the meta counter after the chunk's bump). */
export function upsertSql(table: Table, userId: string, row: Rec, versionExpr = `(SELECT value FROM meta WHERE key = 'version')`): string {
  const cols = COLUMNS[table]
  const pk = PK[table] as readonly string[]
  const values = [sqlLiteral(userId), ...cols.map((c) => sqlLiteral(dbValue(table, c, row))), versionExpr]
  const sets = [...cols.filter((c) => !pk.includes(c)), 'version'].map((c) => `${c} = excluded.${c}`)
  return (
    `INSERT INTO ${table} (user_id, ${cols.join(', ')}, version) VALUES (${values.join(', ')}) ` +
    `ON CONFLICT (${['user_id', ...pk].join(', ')}) DO UPDATE SET ${sets.join(', ')};`
  )
}

export const BUMP_VERSION_SQL = `UPDATE meta SET value = value + 1 WHERE key = 'version';`

export function resetSql(userId: string, epoch: string): string[] {
  return [...TABLES.map((t) => `DELETE FROM ${t} WHERE user_id = ${sqlLiteral(userId)};`), `UPDATE meta SET value = ${sqlLiteral(epoch)} WHERE key = 'epoch';`]
}

export function newEpoch(now: number = Date.now()): string {
  return `m${now.toString(36)}`
}

export interface EmitOptions {
  reset?: boolean
  /** required with reset; pass newEpoch() */
  epoch?: string
  maxFileBytes?: number
}

export interface EmitFile {
  name: string
  sql: string
  rows: number
  /** number of versions (chunks) in the file */
  versions: number
}

export function emitSql(result: TransformResult, opts: EmitOptions = {}): EmitFile[] {
  const max = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const header = (k: number, n: number) => `-- food-log v2 import, file ${k}/${n}. Apply the files in order. Generated by tools/migrate/emit-sql; contains private data, never commit.\n`
  const pieces: { sql: string; rows: number; versions: number }[] = []
  if (opts.reset) {
    if (!opts.epoch) throw new Error('emitSql: reset needs an epoch')
    pieces.push({ sql: resetSql(result.userId, opts.epoch).join('\n') + '\n', rows: 0, versions: 0 })
  }
  for (const chunk of chunkRows(result)) {
    const lines = [BUMP_VERSION_SQL, ...chunk.rows.map((r) => upsertSql(chunk.table, result.userId, r))]
    pieces.push({ sql: lines.join('\n') + '\n', rows: chunk.rows.length, versions: 1 })
  }
  // pack pieces into files without splitting one
  const files: { sql: string; rows: number; versions: number }[] = []
  for (const p of pieces) {
    const cur = files[files.length - 1]
    if (cur && Buffer.byteLength(cur.sql) + Buffer.byteLength(p.sql) <= max) {
      cur.sql += p.sql
      cur.rows += p.rows
      cur.versions += p.versions
    } else files.push({ ...p })
  }
  if (files.length === 0) files.push({ sql: '', rows: 0, versions: 0 })
  return files.map((f, i) => ({
    name: `import-${String(i + 1).padStart(3, '0')}-of-${String(files.length).padStart(3, '0')}.sql`,
    sql: header(i + 1, files.length) + f.sql,
    rows: f.rows,
    versions: f.versions,
  }))
}

/** The wrangler commands that apply the files (printed, never run here). */
export function wranglerCommands(files: string[], opts: { db: string; local: boolean }): string[] {
  const where = opts.local ? '--local' : '--remote'
  return files.map((f) => `npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute ${opts.db} ${where} --file ${shQuote(f)}`)
}

export function anomalySummary(anomalies: Anomaly[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of anomalies) out[`${a.table}:${a.kind}:${a.code}`] = (out[`${a.table}:${a.kind}:${a.code}`] ?? 0) + 1
  return out
}

function main(): void {
  const { flags, opts } = parseArgs(process.argv.slice(2))
  if (!opts.sheet) die('--sheet <out/sheet-*.json> is required')
  if (!opts['user-id']) die('--user-id <owner user.id> is required (SELECT id FROM user, see docs/runbooks/v2-cutover.md)')
  const snapshot = JSON.parse(readFileSync(path.resolve(opts.sheet), 'utf8')) as SheetSnapshot
  const result = transform(snapshot, { userId: opts['user-id'] })
  const stamp = fileStamp()
  const dir = path.resolve(opts.out ?? path.join(DEFAULT_OUT_DIR, `import-${stamp}`))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const maxBytes = opts['max-bytes'] ? Number(opts['max-bytes']) : DEFAULT_MAX_FILE_BYTES
  const files = emitSql(result, { reset: flags.has('reset'), epoch: newEpoch(), maxFileBytes: maxBytes })
  const paths = files.map((f) => {
    const p = path.join(dir, f.name)
    writeFileSync(p, f.sql, { mode: 0o600 })
    return p
  })
  writeFileSync(path.join(dir, 'anomalies.json'), JSON.stringify(result.anomalies, null, 1) + '\n', { mode: 0o600 })
  console.log(`rows: ${JSON.stringify(Object.fromEntries(Object.entries(result.counts).map(([k, v]) => [k, `${v.in} -> ${v.out}`])))}, favorites ${result.favorites.length}`)
  console.log('anomalies:')
  for (const [k, n] of Object.entries(anomalySummary(result.anomalies)).sort()) console.log(`  ${n}\t${k}`)
  console.log(`wrote ${files.length} file(s) and anomalies.json to ${dir}`)
  if (!flags.has('reset')) {
    console.error('')
    console.error('!!! WARNING: --reset is absent. Only for the first import into an empty D1; for any later import use --reset.')
    console.error('!!! Without it, rows the v2 app already wrote (same-day weight, same-name store) can make a file fail midway on a unique index.')
    console.error('!!! If a file fails: re-run the whole import with --reset and apply every file again from the first.')
    console.error('')
  }
  console.log(flags.has('reset') ? '# --reset: owner rows are deleted first and a new epoch is written' : '# no --reset: rows are upserted over what is there (first import into an empty D1 only)')
  console.log(`# apply in this order (${flags.has('local') ? 'local D1' : '⛔ REMOTE D1: Brian only'}):`)
  for (const c of wranglerCommands(paths, { db: opts.db ?? 'food-log', local: flags.has('local') })) console.log(c)
}

if (isMain(import.meta.url)) main()
