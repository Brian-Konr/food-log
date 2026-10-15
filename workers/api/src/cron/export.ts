// Daily export (PRD 10): every business table, ALL users (each row carries user_id), written to R2 as part files under
// exports/YYYY-MM-DD/<table>.part-N.json (+ logs.part-N.csv), then `_ok.json` LAST with the part list and a consistency flag.
// Better Auth tables, sessions, API keys and login codes are NOT exported: they hold secrets / hashes and are recreated
// with the bootstrap scripts.
//
// Resumable, bounded work (free plan CPU limits): one STEP reads at most EXPORT_CHUNK_ROWS rows (one table, rowid order)
// and writes one part. An invocation keeps stepping only while its row / time budget allows, and persists progress in the
// single-row D1 table `export_progress` (day, table, rowid cursor, part number, finished tables, attempt, version at start).
//   cron "0 20 * * *"      04:00 Taipei: start the day's export
//   cron "*/5 20 * * *"    04:05..04:55 Taipei: resume it if unfinished (a no-op when `_ok.json` exists)
// An invocation owns the export through a lease (a crashed one simply expires), so two invocations never interleave.
//
// Consistency: the head `version` is recorded at the start. If it moved (or the epoch changed) by the time the last part
// is written, the export restarts ONCE with fresh progress; if it moves again, `_ok.json` is written with
// `consistent: false` so the restore drill can reject it.
import { TABLES, taipeiDay, taipeiIso } from '@food-log/core'
import type { LogRow, Table } from '@food-log/core'
import { fromDb, selectList } from '../db/tables.ts'
import type { Env } from '../env.ts'

export const EXPORT_CHUNK_ROWS = 1000
/** Rows one cron invocation may export before it stops and leaves the rest to the next resume tick. */
export const EXPORT_ROW_BUDGET = 3000
/** Wall-clock budget per invocation (ms), checked between steps. */
export const EXPORT_TIME_BUDGET_MS = 15_000
export const EXPORT_LEASE_MS = 120_000
export const EXPORT_CRON = '0 20 * * *'
export const EXPORT_RESUME_CRON = '*/5 20 * * *'
export const MAX_EXPORT_ATTEMPTS = 2

export type PartInfo = { key: string; rows: number; bytes: number }
export type TableManifest = { rows: number; bytes: number; parts: PartInfo[] }

export type ExportManifest = {
  ok: true
  day: string
  finishedAt: string
  versionAtStart: number
  versionAtEnd: number
  epoch: string
  /** false: the data kept changing while the export ran (twice); the restore drill must reject it */
  consistent: boolean
  attempts: number
  /** one entry per table plus 'logs.csv'; concatenate the parts in order (CSV: only part 1 has the BOM and header) */
  tables: Record<string, TableManifest>
}

export type ExportResult =
  | { status: 'done'; rowsThisRun: number; manifest: ExportManifest }
  | { status: 'partial'; rowsThisRun: number; table: string; part: number }
  | { status: 'busy' | 'skipped'; rowsThisRun: 0 }

export type ExportOptions = {
  rowBudget?: number
  timeBudgetMs?: number
  now?: () => number
  /** ignore an existing _ok.json and any progress, and export the day from scratch */
  force?: boolean
}

type Bindings = Pick<Env, 'DB' | 'EXPORTS'>

const CSV_COLUMNS = ['id', 'day', 'ts', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb', 'source', 'store_id', 'deleted_at', 'updated_at', 'user_id'] as const

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
}

export function csvLine(row: LogRow): string {
  const rec = row as unknown as Record<string, unknown>
  return CSV_COLUMNS.map((c) => csvCell(rec[c])).join(',')
}

const jsonHeader = { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
const dirOf = (day: string): string => `exports/${day}/`
const okKey = (day: string): string => `${dirOf(day)}_ok.json`

interface ProgressRow {
  day: string
  attempt: number
  version_at_start: number
  epoch_at_start: string
  table_idx: number
  rowid_cursor: number
  part: number
  rows: number
  state: string
  lease_token: string
  lease_until: number
}

type ProgressState = {
  /** finished tables (and 'logs.csv') */
  done: Record<string, TableManifest>
  /** parts of the table being exported */
  cur: { json: PartInfo[]; csv: PartInfo[] }
}

const freshState = (): ProgressState => ({ done: {}, cur: { json: [], csv: [] } })

async function headOf(db: D1Database): Promise<{ version: number; epoch: string }> {
  const rs = await db.prepare(`SELECT key, value FROM meta WHERE key IN ('version', 'epoch')`).all<{ key: string; value: number | string }>()
  const m = new Map(rs.results.map((r) => [r.key, r.value]))
  return { version: Number(m.get('version') ?? 0), epoch: String(m.get('epoch') ?? '') }
}

/** Delete every object under exports/<day>/ (leftovers of an abandoned or restarted attempt). */
async function purge(r2: R2Bucket, day: string): Promise<void> {
  for (;;) {
    const list = await r2.list({ prefix: dirOf(day), limit: 1000 })
    if (list.objects.length === 0) return
    await r2.delete(list.objects.map((o) => o.key))
    if (!list.truncated) return
  }
}

class LostLease extends Error {}

/**
 * Advance the export for `day` by as many steps as the budget allows. Safe to call repeatedly and concurrently:
 * returns 'busy' when another invocation holds the lease, 'skipped' when the day already has its _ok.json.
 */
export async function exportSteps(env: Bindings, day: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const now = opts.now ?? Date.now
  const rowBudget = opts.rowBudget ?? EXPORT_ROW_BUDGET
  const timeBudget = opts.timeBudgetMs ?? EXPORT_TIME_BUDGET_MS
  const { DB: db, EXPORTS: r2 } = env
  const t0 = now()
  const token = crypto.randomUUID()
  const stamp = () => taipeiIso(now())

  if (opts.force) {
    await db.prepare(`DELETE FROM export_progress`).run()
    await r2.delete(okKey(day))
  } else if ((await r2.head(okKey(day))) !== null) {
    await db.prepare(`DELETE FROM export_progress WHERE day = ?`).bind(day).run() // _ok written but the row delete crashed
    return { status: 'skipped', rowsThisRun: 0 }
  }

  // ---- own the export: create the row if needed, take the lease ----
  const existing = await db.prepare(`SELECT day, lease_until FROM export_progress WHERE id = 1`).first<{ day: string; lease_until: number }>()
  if (existing && existing.day !== day) {
    // an unfinished export of an older day is abandoned: today's data is what matters now (its parts stay in R2 without _ok.json)
    const del = await db.prepare(`DELETE FROM export_progress WHERE id = 1 AND day <> ? AND lease_until < ?`).bind(day, now()).run()
    if (del.meta.changes === 0) return { status: 'busy', rowsThisRun: 0 }
  }
  let created = false
  if (!existing || existing.day !== day) {
    const head = await headOf(db)
    const ins = await db
      .prepare(
        `INSERT INTO export_progress (id, day, attempt, version_at_start, epoch_at_start, table_idx, rowid_cursor, part, rows, state, lease_token, lease_until, started_at, updated_at)
         VALUES (1, ?, 1, ?, ?, 0, 0, 1, 0, ?, '', 0, ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(day, head.version, head.epoch, JSON.stringify(freshState()), stamp(), stamp())
      .run()
    created = ins.meta.changes === 1
  }
  const lease = await db
    .prepare(`UPDATE export_progress SET lease_token = ?, lease_until = ? WHERE id = 1 AND day = ? AND lease_until < ?`)
    .bind(token, now() + EXPORT_LEASE_MS, day, now())
    .run()
  if (lease.meta.changes !== 1) return { status: 'busy', rowsThisRun: 0 }

  let rowsThisRun = 0
  try {
    if (created) await purge(r2, day) // only the creator purges, and only while holding the lease
    let p = (await db.prepare(`SELECT * FROM export_progress WHERE id = 1 AND lease_token = ?`).bind(token).first<ProgressRow>())!
    let state = JSON.parse(p.state) as ProgressState

    for (;;) {
      if (p.table_idx >= TABLES.length) {
        // ---- finalize: consistency check, then _ok.json LAST ----
        const head = await headOf(db)
        const changed = head.version !== p.version_at_start || head.epoch !== p.epoch_at_start
        if (changed && p.attempt < MAX_EXPORT_ATTEMPTS) {
          await purge(r2, day)
          state = freshState()
          p = { ...p, attempt: p.attempt + 1, version_at_start: head.version, epoch_at_start: head.epoch, table_idx: 0, rowid_cursor: 0, part: 1, rows: 0 }
          await save(db, token, p, state, now)
          continue
        }
        const manifest: ExportManifest = {
          ok: true,
          day,
          finishedAt: taipeiIso(now()),
          versionAtStart: p.version_at_start,
          versionAtEnd: head.version,
          epoch: head.epoch,
          consistent: !changed,
          attempts: p.attempt,
          tables: state.done,
        }
        await r2.put(okKey(day), JSON.stringify(manifest, null, 2) + '\n', jsonHeader)
        await db.prepare(`DELETE FROM export_progress WHERE id = 1 AND lease_token = ?`).bind(token).run()
        return { status: 'done', rowsThisRun, manifest }
      }
      if (rowsThisRun >= rowBudget || now() - t0 >= timeBudget) {
        return { status: 'partial', rowsThisRun, table: TABLES[p.table_idx]!, part: p.part }
      }

      // ---- one step: one chunk of one table -> one part ----
      const t: Table = TABLES[p.table_idx]!
      const rs = await db
        .prepare(`SELECT rowid AS _rowid, ${selectList(t)} FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .bind(p.rowid_cursor, EXPORT_CHUNK_ROWS)
        .all<Record<string, unknown>>()
      let last = p.rowid_cursor
      const rows = rs.results.map((r) => {
        last = Number(r._rowid)
        const { _rowid: _ignored, ...rest } = r
        return fromDb(t, rest)
      })
      let { part, rows: total } = p
      if (rows.length > 0 || part === 1) {
        // an empty table still gets one part ("[]") so the manifest always lists a file
        const body = new Blob([rows.length === 0 ? '[]\n' : '[\n' + rows.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n'])
        const key = `${dirOf(day)}${t}.part-${part}.json`
        await r2.put(key, body, jsonHeader)
        state.cur.json.push({ key, rows: rows.length, bytes: body.size })
        if (t === 'logs') {
          const csv = (part === 1 ? '﻿' + CSV_COLUMNS.join(',') + '\r\n' : '') + rows.map((r) => csvLine(r as LogRow) + '\r\n').join('')
          const csvKey = `${dirOf(day)}logs.part-${part}.csv`
          await r2.put(csvKey, csv, { httpMetadata: { contentType: 'text/csv; charset=utf-8' } })
          state.cur.csv.push({ key: csvKey, rows: rows.length, bytes: new TextEncoder().encode(csv).length })
        }
        part++
        total += rows.length
        rowsThisRun += rows.length
      }
      let nextIdx = p.table_idx
      let cursor = last
      if (rows.length < EXPORT_CHUNK_ROWS) {
        // table finished
        state.done[t] = { rows: total, bytes: sum(state.cur.json), parts: state.cur.json }
        if (t === 'logs') state.done['logs.csv'] = { rows: total, bytes: sum(state.cur.csv), parts: state.cur.csv }
        state.cur = { json: [], csv: [] }
        nextIdx++
        cursor = 0
        part = 1
        total = 0
      }
      p = { ...p, table_idx: nextIdx, rowid_cursor: cursor, part, rows: total }
      await save(db, token, p, state, now)
    }
  } finally {
    // release the lease so the next tick can continue at once (a crash that skips this just lets the lease expire)
    await db.prepare(`UPDATE export_progress SET lease_until = 0 WHERE id = 1 AND lease_token = ?`).bind(token).run().catch(() => undefined)
  }
}

const sum = (parts: PartInfo[]): number => parts.reduce((n, x) => n + x.bytes, 0)

async function save(db: D1Database, token: string, p: ProgressRow, state: ProgressState, now: () => number): Promise<void> {
  const r = await db
    .prepare(
      `UPDATE export_progress SET attempt = ?, version_at_start = ?, epoch_at_start = ?, table_idx = ?, rowid_cursor = ?, part = ?, rows = ?, state = ?, lease_until = ?, updated_at = ?
       WHERE id = 1 AND lease_token = ?`,
    )
    .bind(p.attempt, p.version_at_start, p.epoch_at_start, p.table_idx, p.rowid_cursor, p.part, p.rows, JSON.stringify(state), now() + EXPORT_LEASE_MS, taipeiIso(now()), token)
    .run()
  if (r.meta.changes !== 1) throw new LostLease('export lease lost')
}

/** Run one complete export for `day` (Taipei date) in this call, from scratch, with no budget. Ops / tests. */
export async function runExport(env: Bindings, day: string, now: () => number = Date.now): Promise<ExportManifest> {
  const r = await exportSteps(env, day, { rowBudget: Infinity, timeBudgetMs: Infinity, now, force: true })
  if (r.status !== 'done') throw new Error('export did not finish: ' + r.status)
  return r.manifest
}

/**
 * The scheduled() handler body. The export is dated by the Taipei day of the scheduled time (20:00..20:55 UTC = 04:00..04:55
 * Taipei of the next UTC day, all the same Taipei day). Both crons call it: the start cron and the resume cron.
 */
export async function scheduledExport(event: { scheduledTime: number; cron?: string }, env: Bindings & Pick<Env, 'EXPORT_ROW_BUDGET'>): Promise<ExportResult> {
  const at = new Date(event.scheduledTime)
  // "*/5 20 * * *" also fires at minute 0, together with the start cron: let the start cron take that one
  if (event.cron === EXPORT_RESUME_CRON && at.getUTCMinutes() === 0) return { status: 'skipped', rowsThisRun: 0 }
  const n = Number(env.EXPORT_ROW_BUDGET)
  const res = await exportSteps(env, taipeiDay(at), { rowBudget: Number.isInteger(n) && n > 0 ? n : EXPORT_ROW_BUDGET })
  console.log(JSON.stringify({ type: 'export', day: taipeiDay(at), cron: event.cron ?? null, status: res.status, rows: res.rowsThisRun }))
  return res
}
