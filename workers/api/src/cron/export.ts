// Daily export (PRD 10): one JSON file per business table plus logs.csv, written to R2 under exports/YYYY-MM-DD/.
// Rows are read from D1 in chunks (CHUNK rows per query, keyed on rowid) so no single query or response is large;
// `_ok.json` is written LAST, so a day without `_ok.json` is an incomplete export. Cron: "0 20 * * *" UTC = 04:00 Taipei.
//
// The six tables are exported across ALL users (each row carries user_id). Better Auth tables, sessions, API keys and
// login codes are NOT exported: they hold secrets / hashes and are recreated with the bootstrap scripts.
import { TABLES, taipeiDay, taipeiIso } from '@food-log/core'
import type { LogRow, Table } from '@food-log/core'
import { D1UserStore } from '../db/d1-store.ts'
import type { Env } from '../env.ts'

export const EXPORT_CHUNK_ROWS = 1000

export type ExportManifest = {
  ok: true
  day: string
  finishedAt: string
  versionAtStart: number
  versionAtEnd: number
  epoch: string
  tables: Record<string, { rows: number; bytes: number; key: string }>
}

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

async function userIds(db: D1Database, t: Table): Promise<string[]> {
  const rs = await db.prepare(`SELECT DISTINCT user_id FROM ${t} ORDER BY user_id`).all<{ user_id: string }>()
  return rs.results.map((r) => r.user_id)
}

/** Run one export for `day` (Taipei date). Returns the manifest that was written as _ok.json. */
export async function runExport(env: Pick<Env, 'DB' | 'EXPORTS'>, day: string, now: () => number = Date.now): Promise<ExportManifest> {
  const dir = `exports/${day}/`
  const headOf = async () => {
    const rs = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN ('version', 'epoch')`).all<{ key: string; value: number | string }>()
    const m = new Map(rs.results.map((r) => [r.key, r.value]))
    return { version: Number(m.get('version') ?? 0), epoch: String(m.get('epoch') ?? '') }
  }
  const start = await headOf()
  const tables: ExportManifest['tables'] = {}
  const enc = new TextEncoder()

  for (const t of TABLES) {
    const parts: string[] = []
    const csv: string[] | null = t === 'logs' ? [CSV_COLUMNS.join(',')] : null
    let rows = 0
    parts.push('[')
    for (const userId of await userIds(env.DB, t)) {
      const store = new D1UserStore(env.DB, userId, now)
      let after = 0
      for (;;) {
        const { rows: chunk, lastRowid } = await store.chunk(t, after, EXPORT_CHUNK_ROWS)
        if (chunk.length === 0) break
        for (const r of chunk) {
          parts.push((rows === 0 ? '\n' : ',\n') + JSON.stringify(r))
          if (csv) csv.push(csvLine(r as LogRow))
          rows++
        }
        after = lastRowid
        if (chunk.length < EXPORT_CHUNK_ROWS) break
      }
    }
    parts.push(rows === 0 ? ']\n' : '\n]\n')
    const body = new Blob(parts, { type: 'application/json' })
    const key = `${dir}${t}.json`
    await env.EXPORTS.put(key, body, { httpMetadata: { contentType: 'application/json; charset=utf-8' } })
    tables[t] = { rows, bytes: body.size, key }
    if (csv) {
      const csvBody = '﻿' + csv.join('\r\n') + '\r\n'
      const csvKey = `${dir}logs.csv`
      await env.EXPORTS.put(csvKey, csvBody, { httpMetadata: { contentType: 'text/csv; charset=utf-8' } })
      tables['logs.csv'] = { rows, bytes: enc.encode(csvBody).length, key: csvKey }
    }
  }

  const end = await headOf()
  const manifest: ExportManifest = {
    ok: true,
    day,
    finishedAt: taipeiIso(now()),
    versionAtStart: start.version,
    versionAtEnd: end.version,
    epoch: end.epoch,
    tables,
  }
  // written last: its presence means every file above is complete
  await env.EXPORTS.put(`${dir}_ok.json`, JSON.stringify(manifest, null, 2) + '\n', { httpMetadata: { contentType: 'application/json; charset=utf-8' } })
  return manifest
}

/** The scheduled() handler body: the export is dated by the Taipei day of the scheduled time. */
export async function scheduledExport(event: { scheduledTime: number }, env: Pick<Env, 'DB' | 'EXPORTS'>): Promise<ExportManifest> {
  return runExport(env, taipeiDay(new Date(event.scheduledTime)))
}
