// Restore drill, pure logic (no process.exit, no console): read a downloaded R2 export folder, load it into a fresh
// SQLite database built from workers/api/migrations, and compare what came out with what `_ok.json` says went in.
//
// Export format (workers/api/src/cron/export.ts):
//   <dir>/_ok.json                 manifest: { ok, day, consistent, versionAtStart/End, epoch, tables: { <table>: { rows, bytes, parts: [{ key, rows, bytes }] } } }
//   <dir>/<table>.part-N.json      JSON array of rows (user_id + business columns + version); config.remind_meal_times is an array
//   <dir>/logs.part-N.csv          same logs rows; only part 1 has the BOM and the header line
// A part's `key` is the R2 object key (`exports/YYYY-MM-DD/<file>`); only its last path segment is used here, so the
// folder can be wherever Brian downloaded it to.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildRestoreSql, newEpoch } from './restore-sql.ts'

export type PartInfo = { key: string; rows: number; bytes: number }
export type TableManifest = { rows: number; bytes: number; parts: PartInfo[] }
export type ExportManifest = {
  ok: true
  day: string
  finishedAt: string
  versionAtStart: number
  versionAtEnd: number
  epoch: string
  consistent: boolean
  attempts: number
  tables: Record<string, TableManifest>
}

/** The drill refuses to run (exit code 2): there is nothing trustworthy to restore. */
export class DrillRefusal extends Error {}

export type Row = Record<string, unknown>
export type Nutrition = { rows: number; kcal: number; protein: number; fat: number; carb: number }

export type TableReport = {
  table: string
  /** rows the manifest says were exported (undefined when the manifest has no entry for the table) */
  expected: number | undefined
  /** rows found in the part files */
  inParts: number
  /** rows in the restored database */
  live: number
  deleted: number
}

export type DayReport = { day: string } & Nutrition
export type WeightDayReport = { day: string; count: number }

export type DrillReport = {
  ok: boolean
  exportDay: string
  version: { start: number; end: number }
  epoch: string
  tables: TableReport[]
  days: DayReport[]
  weights: WeightDayReport[]
  /** every mismatch / load error; empty when ok */
  problems: string[]
  elapsedMs: number
  /** set when --emit-sql wrote a file */
  emittedSql?: { path: string; epoch: string; version: number; users: number; statements: number }
}

/**
 * Load order of the exported tables (= TABLES in @food-log/core; a test keeps them equal). Not imported from core on purpose:
 * core is TypeScript with extensionless imports that plain `node` cannot run, and this CLI runs with plain node.
 */
export const TABLES = ['stores', 'items', 'logs', 'weights', 'favorites', 'config'] as const

const NUTRIENTS = ['kcal', 'protein', 'fat', 'carb'] as const
const SUM_EPSILON = 1e-6

/** default location of the migrations, relative to this file: tools/ops/src -> workers/api/migrations */
export const DEFAULT_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'workers', 'api', 'migrations')

// ------------------------------------------------------------------ manifest

/** Read and vet `_ok.json`. Throws DrillRefusal when it is missing, unreadable, not `ok`, or not `consistent`. */
export function readManifest(dir: string): ExportManifest {
  const path = join(dir, '_ok.json')
  if (!existsSync(path)) throw new DrillRefusal(`refused: ${path} does not exist (the export is unfinished or the folder is wrong)`)
  let m: unknown
  try {
    m = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new DrillRefusal(`refused: _ok.json is not valid JSON (${(e as Error).message})`)
  }
  const o = m as Partial<ExportManifest> | null
  if (!o || typeof o !== 'object' || o.ok !== true || typeof o.tables !== 'object' || o.tables === null) {
    throw new DrillRefusal('refused: _ok.json does not look like an export manifest (ok / tables missing)')
  }
  if (o.consistent !== true) {
    throw new DrillRefusal(
      `refused: _ok.json says consistent=${String(o.consistent)} (the data kept changing while the export ran, versionAtStart=${String(o.versionAtStart)} versionAtEnd=${String(o.versionAtEnd)}); use another day's export`,
    )
  }
  return o as ExportManifest
}

// ------------------------------------------------------------------ database

/** `NNNN_*.sql` files of `migrationsDir`, in numeric (= name) order. */
export function listMigrations(migrationsDir: string): string[] {
  if (!existsSync(migrationsDir)) throw new DrillRefusal(`refused: migrations folder not found: ${migrationsDir}`)
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort()
  if (files.length === 0) throw new DrillRefusal(`refused: no .sql files in ${migrationsDir}`)
  return files.map((f) => join(migrationsDir, f))
}

/**
 * Apply the migrations in order with `exec` (multi-statement). node:sqlite bundles SQLite >= 3.46, which supports everything
 * 0001/0002 use (STRICT, the ANY type, partial unique indexes, date()/strftime() in CHECK, json_valid), so no statement needs
 * a workaround. The one thing it does NOT do is wrangler's own `d1_migrations` bookkeeping table: not needed in a scratch DB.
 */
export function applyMigrations(db: DatabaseSync, files: string[]): void {
  for (const f of files) {
    try {
      db.exec(readFileSync(f, 'utf8'))
    } catch (e) {
      throw new Error(`migration ${basename(f)} failed in node:sqlite: ${(e as Error).message}`, { cause: e })
    }
  }
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
}

// ------------------------------------------------------------------ part files

function partPath(dir: string, p: PartInfo): string {
  return join(dir, basename(p.key))
}

/** Parse CSV text (RFC 4180 as written by csvCell: quotes only when needed, CRLF line ends, BOM on part 1) into records of cells. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let any = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
      continue
    }
    if (c === '"') {
      quoted = true
      any = true
    } else if (c === ',') {
      row.push(cell)
      cell = ''
      any = true
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++
      if (any || cell !== '') {
        row.push(cell)
        out.push(row)
      }
      row = []
      cell = ''
      any = false
    } else {
      cell += c
      any = true
    }
  }
  if (any || cell !== '') {
    row.push(cell)
    out.push(row)
  }
  return out
}

/** Read a table's JSON parts in manifest order. Pushes a problem for every missing / malformed / miscounted part. */
export function readTableRows(dir: string, table: string, tm: TableManifest, problems: string[]): Row[] {
  const rows: Row[] = []
  for (const p of tm.parts) {
    const path = partPath(dir, p)
    if (!existsSync(path)) {
      problems.push(`${table}: part file missing: ${basename(p.key)}`)
      continue
    }
    let arr: unknown
    try {
      arr = JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      problems.push(`${table}: ${basename(p.key)} is not valid JSON (${(e as Error).message})`)
      continue
    }
    if (!Array.isArray(arr)) {
      problems.push(`${table}: ${basename(p.key)} is not a JSON array`)
      continue
    }
    if (arr.length !== p.rows) problems.push(`${table}: ${basename(p.key)} has ${arr.length} rows, manifest says ${p.rows}`)
    const size = statSync(path).size
    if (size !== p.bytes) problems.push(`${table}: ${basename(p.key)} is ${size} bytes, manifest says ${p.bytes}`)
    for (const r of arr) rows.push(r as Row)
  }
  return rows
}

/** logs.csv parts: the header (part 1) and the records without it. */
function readCsv(dir: string, tm: TableManifest, problems: string[]): { header: string[]; records: string[][] } {
  let header: string[] = []
  const records: string[][] = []
  for (const [i, p] of tm.parts.entries()) {
    const path = partPath(dir, p)
    if (!existsSync(path)) {
      problems.push(`logs.csv: part file missing: ${basename(p.key)}`)
      continue
    }
    const size = statSync(path).size
    if (size !== p.bytes) problems.push(`logs.csv: ${basename(p.key)} is ${size} bytes, manifest says ${p.bytes}`)
    const recs = parseCsv(readFileSync(path, 'utf8'))
    if (i === 0) header = recs.shift() ?? []
    if (recs.length !== p.rows) problems.push(`logs.csv: ${basename(p.key)} has ${recs.length} records, manifest says ${p.rows}`)
    records.push(...recs)
  }
  return { header, records }
}

// ------------------------------------------------------------------ load

/** Insert rows using their own keys as columns (unknown keys and constraint failures become problems). Returns rows inserted. */
export function loadRows(db: DatabaseSync, table: string, rows: Row[], problems: string[]): number {
  const known = columnsOf(db, table)
  let inserted = 0
  const stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  const unknownCols = new Set<string>()
  let unknownRows = 0
  db.exec('BEGIN')
  try {
    for (const [i, row] of rows.entries()) {
      const keys = Object.keys(row)
      const unknown = keys.filter((k) => !known.has(k))
      if (unknown.length > 0) {
        for (const k of unknown) unknownCols.add(k)
        unknownRows++
        continue
      }
      const sig = keys.join(',')
      let st = stmts.get(sig)
      if (!st) {
        st = db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
        stmts.set(sig, st)
      }
      // config.remind_meal_times is exported as an array and stored as JSON text
      const values = keys.map((k) => {
        const v = row[k]
        if (v !== null && typeof v === 'object') return JSON.stringify(v)
        return v === undefined ? null : v
      })
      try {
        st.run(...(values as (string | number | null)[]))
        inserted++
      } catch (e) {
        problems.push(`${table}: row ${i + 1} (${String(row.id ?? row.item_id ?? row.user_id)}) rejected by the schema: ${(e as Error).message}`)
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  // one problem per table, not one per row
  if (unknownRows > 0) problems.push(`${table}: ${unknownRows} row(s) have unknown column(s): ${[...unknownCols].join(', ')}`)
  return inserted
}

// ------------------------------------------------------------------ sums

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))

/** Per-day sums of the LIVE logs, from raw rows (JSON rows, or CSV records turned into rows). */
export function sumLogsByDay(rows: Row[]): Map<string, Nutrition> {
  const m = new Map<string, Nutrition>()
  for (const r of rows) {
    if (r.deleted_at !== null && r.deleted_at !== undefined && r.deleted_at !== '') continue
    const day = String(r.day)
    const a = m.get(day) ?? { rows: 0, kcal: 0, protein: 0, fat: 0, carb: 0 }
    a.rows++
    for (const k of NUTRIENTS) a[k] += num(r[k])
    m.set(day, a)
  }
  return m
}

function csvToRows(csv: { header: string[]; records: string[][] }): Row[] {
  return csv.records.map((rec) => Object.fromEntries(csv.header.map((h, i) => [h, rec[i] ?? ''])))
}

function dbDaySums(db: DatabaseSync): Map<string, Nutrition> {
  const rs = db
    .prepare(`SELECT day, COUNT(*) AS rows, SUM(kcal) AS kcal, SUM(protein) AS protein, SUM(fat) AS fat, SUM(carb) AS carb FROM logs WHERE deleted_at IS NULL GROUP BY day ORDER BY day`)
    .all() as unknown as ({ day: string } & Nutrition)[]
  return new Map(rs.map((r) => [r.day, { rows: Number(r.rows), kcal: r.kcal, protein: r.protein, fat: r.fat, carb: r.carb }]))
}

function compareSums(label: string, a: Map<string, Nutrition>, aName: string, b: Map<string, Nutrition>, bName: string, problems: string[]): void {
  for (const day of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(day)
    const y = b.get(day)
    if (!x || !y) {
      problems.push(`${label} ${day}: present in ${x ? aName : bName} only`)
      continue
    }
    if (x.rows !== y.rows) problems.push(`${label} ${day}: ${x.rows} live logs in ${aName} vs ${y.rows} in ${bName}`)
    for (const k of NUTRIENTS) {
      if (Math.abs(x[k] - y[k]) > SUM_EPSILON) problems.push(`${label} ${day}: ${k} ${x[k]} in ${aName} vs ${y[k]} in ${bName}`)
    }
  }
}

// ------------------------------------------------------------------ drill

export type DrillOptions = {
  /** local folder with the downloaded export */
  dir: string
  /** SQLite file to create; omitted = in memory */
  dbPath?: string
  migrationsDir?: string
  now?: () => number
  /**
   * Write a SQL file that restores the export into D1 (see restore-sql.ts). Only written when the drill result is OK;
   * refused up front when the file already exists.
   */
  emitSqlPath?: string
  /** with emitSqlPath: rewrite every row's user_id to this id (disaster recovery into a fresh D1 whose owner row got a new id) */
  emitUserId?: string
  /** with emitSqlPath: the new epoch (default: random) */
  emitEpoch?: string
}

/**
 * Version invariant: every row's `version` is a non-negative integer <= versionAtEnd (the head version when the export
 * finished). It is deliberately NOT checked for uniqueness: one mutation stamps every row it writes (several rows, even in
 * several tables) with the same version (d1-store.ts rowsAtVersion; the (user_id, version) indexes are not unique), and pull
 * pages by (version, table order, primary key), so a repeated version is normal.
 */
function checkVersions(table: string, rows: Row[], versionAtEnd: number, problems: string[]): void {
  let bad = 0
  let above = 0
  let maxSeen = 0
  for (const r of rows) {
    const v = r.version
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) bad++
    else {
      if (v > versionAtEnd) above++
      if (v > maxSeen) maxSeen = v
    }
  }
  if (bad > 0) problems.push(`${table}: ${bad} row(s) with a missing or non-integer version`)
  if (above > 0) problems.push(`${table}: ${above} row(s) have a version above versionAtEnd=${versionAtEnd} (highest ${maxSeen}); the export is not a consistent snapshot`)
}

const countRows = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { c: number }).c)

/**
 * Restore the export into a fresh database and compare. Throws DrillRefusal when the export must not be used at all
 * (no _ok.json / consistent:false / missing migrations / DB file already exists); every other discrepancy ends up in
 * `report.problems` with `report.ok = false`.
 */
export function runDrill(opts: DrillOptions): DrillReport {
  const now = opts.now ?? Date.now
  const t0 = now()
  const manifest = readManifest(opts.dir)
  const migrations = listMigrations(opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR)
  if (opts.dbPath && opts.dbPath !== ':memory:' && existsSync(opts.dbPath)) {
    throw new DrillRefusal(`refused: ${opts.dbPath} already exists (the drill needs a fresh database; delete it or pick another --db)`)
  }

  if (opts.emitSqlPath && existsSync(opts.emitSqlPath)) throw new DrillRefusal(`refused: ${opts.emitSqlPath} already exists (delete it or pick another --emit-sql file)`)
  if (opts.emitUserId && !opts.emitSqlPath) throw new DrillRefusal('refused: --user-id only makes sense together with --emit-sql')

  const db = new DatabaseSync(opts.dbPath ?? ':memory:')
  try {
    applyMigrations(db, migrations)
    const problems: string[] = []
    const tables: TableReport[] = []
    let logRows: Row[] = []
    const rowsByTable: Record<string, Row[]> = {}

    for (const t of TABLES) {
      const tm = manifest.tables[t]
      if (!tm) problems.push(`${t}: no entry in _ok.json`)
      const rows = tm ? readTableRows(opts.dir, t, tm, problems) : []
      if (t === 'logs') logRows = rows
      rowsByTable[t] = rows
      checkVersions(t, rows, manifest.versionAtEnd, problems)
      if (tm && rows.length !== tm.rows) problems.push(`${t}: part files hold ${rows.length} rows, manifest says ${tm.rows}`)
      loadRows(db, t, rows, problems)
      const live = countRows(db, `SELECT COUNT(*) AS c FROM ${t} WHERE deleted_at IS NULL`)
      const deleted = countRows(db, `SELECT COUNT(*) AS c FROM ${t} WHERE deleted_at IS NOT NULL`)
      if (tm && live + deleted !== tm.rows) problems.push(`${t}: restored ${live + deleted} rows (${live} live + ${deleted} deleted), manifest says ${tm.rows}`)
      tables.push({ table: t, expected: tm?.rows, inParts: rows.length, live, deleted })
    }

    // per-day sums of live logs: part files vs restored DB, and the logs.csv twin vs restored DB
    const dbSums = dbDaySums(db)
    compareSums('logs day', sumLogsByDay(logRows), 'part files', dbSums, 'restored DB', problems)
    const csvTm = manifest.tables['logs.csv']
    if (csvTm) {
      const csv = readCsv(opts.dir, csvTm, problems)
      if (csv.records.length !== logRows.length) problems.push(`logs.csv: ${csv.records.length} records vs ${logRows.length} rows in the logs part files`)
      compareSums('logs day', sumLogsByDay(csvToRows(csv)), 'logs.csv', dbSums, 'restored DB', problems)
    } else {
      problems.push('logs.csv: no entry in _ok.json')
    }

    const weights = (db.prepare(`SELECT day, COUNT(*) AS count FROM weights WHERE deleted_at IS NULL GROUP BY day ORDER BY day`).all() as unknown as WeightDayReport[]).map((w) => ({ day: w.day, count: Number(w.count) }))
    for (const w of weights) if (w.count > 1) problems.push(`weights ${w.day}: ${w.count} live weights on one day`)

    const days: DayReport[] = [...dbSums.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, n]) => ({ day, ...n }))
    let emittedSql: DrillReport['emittedSql']
    if (opts.emitSqlPath && problems.length === 0) {
      const epoch = opts.emitEpoch ?? newEpoch()
      const out = buildRestoreSql({ rowsByTable, versionAtEnd: manifest.versionAtEnd, epoch, exportDay: manifest.day, userId: opts.emitUserId })
      writeFileSync(opts.emitSqlPath, out.sql, { flag: 'wx' })
      emittedSql = { path: opts.emitSqlPath, epoch, version: out.version, users: out.users, statements: out.statements }
    }
    return {
      ok: problems.length === 0,
      exportDay: manifest.day,
      version: { start: manifest.versionAtStart, end: manifest.versionAtEnd },
      epoch: manifest.epoch,
      tables,
      days,
      weights,
      problems,
      elapsedMs: now() - t0,
      ...(emittedSql ? { emittedSql } : {}),
    }
  } finally {
    db.close()
  }
}

// ------------------------------------------------------------------ output

const r1 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1)

export function formatReport(r: DrillReport): string {
  const out: string[] = []
  out.push(`export ${r.exportDay}  version ${r.version.start}..${r.version.end}  epoch ${r.epoch}`)
  out.push('', 'table      expected  in-parts  live  deleted')
  for (const t of r.tables) {
    out.push(`${t.table.padEnd(10)} ${String(t.expected ?? '-').padStart(8)}  ${String(t.inParts).padStart(8)}  ${String(t.live).padStart(4)}  ${String(t.deleted).padStart(7)}`)
  }
  out.push('', 'day          logs     kcal  protein     fat    carb')
  for (const d of r.days) out.push(`${d.day}  ${String(d.rows).padStart(5)}  ${r1(d.kcal).padStart(7)}  ${r1(d.protein).padStart(7)}  ${r1(d.fat).padStart(6)}  ${r1(d.carb).padStart(6)}`)
  out.push('', 'weights per day: ' + (r.weights.length === 0 ? '(none)' : r.weights.map((w) => `${w.day}=${w.count}`).join(' ')))
  out.push('')
  if (r.ok) out.push('RESULT: OK, every count and daily sum matches')
  else {
    out.push(`RESULT: MISMATCH (${r.problems.length})`)
    for (const p of r.problems) out.push(`  - ${p}`)
  }
  if (r.emittedSql) {
    const e = r.emittedSql
    out.push(``, `SQL written: ${e.path} (${e.statements} statements, ${e.users} user(s), version ${e.version}, new epoch ${e.epoch})`)
  }
  out.push(`elapsed: ${(r.elapsedMs / 1000).toFixed(2)} s`)
  return out.join('\n')
}
