// verify: compare the Sheet snapshot with a D1 dump after an import (acceptance #12).      ⛔ real data: Brian runs it.
//
//   npx -y pnpm@10 --filter @food-log/migrate verify --sheet out/sheet-<stamp>.json --dump out/d1-dump.json --user-id <owner user.id>
//
// Checks (exit 1 on any mismatch):
//   * per table live / deleted counts and the set of ids (stores, items, logs, weights; favorites: count)
//   * per day: the sum of kcal / protein / fat / carb over live logs
//   * per day: kg of the live weight
//   * every Config value (typed)
//   * the favorites set
// The expectation is computed from the RAW Sheet rows with its own small code (it does not call transform's row builders), then
// corrected ONLY by the transform's anomalies[] (rows dropped, values fixed, ids assigned): "Sheet minus anomalies".
// So a bug in the transform that changes data silently (without recording it) shows up as a mismatch.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_CONFIG_VALUES } from '@food-log/core'
import type { Table } from '@food-log/core'
import { die, isMain, parseArgs } from './cli-util.ts'
import { readDump } from './dump.ts'
import { anomalySummary } from './emit-sql.ts'
import { transform } from './transform.ts'
import type { Anomaly, D1Dump, DumpRow, SheetRecord, SheetSnapshot } from './types.ts'

export interface Check {
  name: string
  ok: boolean
  expected?: unknown
  actual?: unknown
  /** the first few differences */
  diff?: string[]
}

export interface VerifyReport {
  ok: boolean
  checks: Check[]
  anomalies: Record<string, number>
  meta: { version: number; epoch: string }
  /** rows of the dump that belong to another user_id (ignored) */
  otherUsersRows: number
}

const EPS = 1e-6
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6
const NUT = ['kcal', 'protein', 'fat', 'carb'] as const

// ------------------------------------------------------------------ the expectation (from the raw Sheet)

interface Eff {
  id: string
  deleted: boolean
  day: string
  kg: number
  kcal: number
  protein: number
  fat: number
  carb: number
}

const rawDeleted = (r: SheetRecord): boolean => r.deleted === true || (typeof r.deleted === 'string' && r.deleted.trim().toUpperCase() === 'TRUE')
const rawNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : NaN
}

function effective(table: 'stores' | 'items' | 'logs' | 'weights', raws: SheetRecord[], anomalies: Anomaly[]): Eff[] {
  const mine = anomalies.filter((a) => a.table === table && a.index !== null)
  const out: Eff[] = []
  raws.forEach((raw, index) => {
    const own = mine.filter((a) => a.index === index)
    if (own.some((a) => a.kind === 'dropped')) return
    const e: Eff = {
      id: String(raw.id ?? '').trim(),
      deleted: rawDeleted(raw),
      day: String(raw.day ?? '').slice(0, 10),
      kg: rawNum(raw.kg),
      kcal: rawNum(raw.kcal),
      protein: rawNum(raw.protein),
      fat: rawNum(raw.fat),
      carb: rawNum(raw.carb),
    }
    for (const a of own) {
      for (const [field, ch] of Object.entries(a.changes ?? {})) {
        if (field === 'id') e.id = String(ch.to)
        else if (field === 'deleted') e.deleted = ch.to === true
        else if (field === 'day') e.day = String(ch.to)
        else if (field === 'kg' || field === 'kcal' || field === 'protein' || field === 'fat' || field === 'carb') e[field] = Number(ch.to)
      }
    }
    out.push(e)
  })
  return out
}

interface Expected {
  counts: Record<'stores' | 'items' | 'logs' | 'weights', { live: number; deleted: number }>
  ids: Record<'stores' | 'items' | 'logs' | 'weights', Set<string>>
  logSums: Map<string, { kcal: number; protein: number; fat: number; carb: number }>
  kg: Map<string, number>
  favorites: Set<string>
  config: Record<string, unknown>
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function expectedConfig(cfg: Record<string, string>, anomalies: Anomaly[]): Record<string, unknown> {
  const s = (k: string): string => (cfg[k] === undefined || cfg[k] === null ? '' : String(cfg[k]).trim())
  const d = DEFAULT_CONFIG_VALUES
  const c: Record<string, unknown> = {
    target_kcal: /^\d+$/.test(s('target_kcal')) ? Number(s('target_kcal')) : d.target_kcal,
    target_protein: s('target_protein') !== '' && Number.isFinite(Number(s('target_protein'))) && Number(s('target_protein')) >= 0 ? Number(s('target_protein')) : d.target_protein,
    target_fat: s('target_fat') !== '' && Number.isFinite(Number(s('target_fat'))) && Number(s('target_fat')) >= 0 ? Number(s('target_fat')) : d.target_fat,
    target_carb: s('target_carb') !== '' && Number.isFinite(Number(s('target_carb'))) && Number(s('target_carb')) >= 0 ? Number(s('target_carb')) : d.target_carb,
    tdee: /^\d+$/.test(s('tdee')) ? Number(s('tdee')) : null,
    remind_meal_times: s('remind_meal_times').split(',').map((p) => p.trim()).filter((p) => HHMM.test(p)),
    remind_weight_time: HHMM.test(s('remind_weight_time')) ? s('remind_weight_time') : null,
  }
  // fixes the transform reports for config (e.g. a value that was not readable) are the only allowed difference
  for (const a of anomalies) {
    if (a.table !== 'config' || a.kind !== 'fixed') continue
    for (const [k, ch] of Object.entries(a.changes ?? {})) {
      c[k] = k === 'remind_meal_times' ? String(ch.to).split(',').filter(Boolean) : ch.to
    }
  }
  return c
}

export function expectation(snapshot: SheetSnapshot, anomalies: Anomaly[]): Expected {
  const eff = {
    stores: effective('stores', snapshot.stores, anomalies),
    items: effective('items', snapshot.items, anomalies),
    logs: effective('logs', snapshot.logs, anomalies),
    weights: effective('weights', snapshot.weights, anomalies),
  }
  const counts = {} as Expected['counts']
  const ids = {} as Expected['ids']
  for (const t of ['stores', 'items', 'logs', 'weights'] as const) {
    counts[t] = { live: eff[t].filter((e) => !e.deleted).length, deleted: eff[t].filter((e) => e.deleted).length }
    ids[t] = new Set(eff[t].map((e) => e.id))
  }
  const logSums = new Map<string, { kcal: number; protein: number; fat: number; carb: number }>()
  for (const l of eff.logs) {
    if (l.deleted) continue
    const s = logSums.get(l.day) ?? { kcal: 0, protein: 0, fat: 0, carb: 0 }
    for (const f of NUT) s[f] += l[f]
    logSums.set(l.day, s)
  }
  const kg = new Map<string, number>()
  for (const w of eff.weights) if (!w.deleted) kg.set(w.day, w.kg)

  // favorites: u: items with fav = true (not dropped), official ids from Config.fav_ids
  const favorites = new Set<string>()
  const dropped = new Set(anomalies.filter((a) => a.table === 'items' && a.kind === 'dropped').map((a) => a.index))
  snapshot.items.forEach((raw, i) => {
    const id = String(raw.id ?? '').trim()
    if (!dropped.has(i) && id.startsWith('u:') && raw.fav === true) favorites.add(id)
  })
  for (const p of String(snapshot.config.fav_ids ?? '').split(',')) {
    const id = p.trim()
    if (id.startsWith('fm:') || id.startsWith('711:')) favorites.add(id)
  }
  return { counts, ids, logSums, kg, favorites, config: expectedConfig(snapshot.config, anomalies) }
}

// ------------------------------------------------------------------ the D1 side

const ownRows = (dump: D1Dump, t: Table, userId: string): DumpRow[] => dump.tables[t].filter((r) => r.user_id === undefined || r.user_id === userId)

function sameSet(a: Set<string>, b: Set<string>): { ok: boolean; diff: string[] } {
  const missing = [...a].filter((x) => !b.has(x)).sort()
  const extra = [...b].filter((x) => !a.has(x)).sort()
  const diff = [...missing.slice(0, 8).map((x) => `missing in D1: ${x}`), ...extra.slice(0, 8).map((x) => `extra in D1: ${x}`)]
  if (missing.length > 8) diff.push(`... ${missing.length - 8} more missing`)
  if (extra.length > 8) diff.push(`... ${extra.length - 8} more extra`)
  return { ok: missing.length === 0 && extra.length === 0, diff }
}

export function verifySnapshot(snapshot: SheetSnapshot, dump: D1Dump, opts: { userId: string }): VerifyReport {
  const { anomalies } = transform(snapshot, { userId: opts.userId })
  const exp = expectation(snapshot, anomalies)
  const checks: Check[] = []
  let otherUsersRows = 0
  for (const t of Object.keys(dump.tables) as Table[]) otherUsersRows += dump.tables[t].filter((r) => r.user_id !== undefined && r.user_id !== opts.userId).length

  // counts and ids
  for (const t of ['stores', 'items', 'logs', 'weights'] as const) {
    const rows = ownRows(dump, t, opts.userId)
    const live = rows.filter((r) => r.deleted_at === null || r.deleted_at === undefined).length
    const deleted = rows.length - live
    checks.push({ name: `${t}: live rows`, ok: live === exp.counts[t].live, expected: exp.counts[t].live, actual: live })
    checks.push({ name: `${t}: deleted rows`, ok: deleted === exp.counts[t].deleted, expected: exp.counts[t].deleted, actual: deleted })
    const s = sameSet(exp.ids[t], new Set(rows.map((r) => String(r.id))))
    checks.push({ name: `${t}: ids`, ok: s.ok, ...(s.ok ? {} : { diff: s.diff }) })
  }

  // per-day log sums (live logs)
  const logs = ownRows(dump, 'logs', opts.userId).filter((r) => r.deleted_at === null || r.deleted_at === undefined)
  const actualSums = new Map<string, { kcal: number; protein: number; fat: number; carb: number }>()
  for (const l of logs) {
    const day = String(l.day)
    const s = actualSums.get(day) ?? { kcal: 0, protein: 0, fat: 0, carb: 0 }
    for (const f of NUT) s[f] += Number(l[f])
    actualSums.set(day, s)
  }
  const sumDiff: string[] = []
  for (const day of new Set([...exp.logSums.keys(), ...actualSums.keys()])) {
    const e = exp.logSums.get(day) ?? { kcal: 0, protein: 0, fat: 0, carb: 0 }
    const a = actualSums.get(day) ?? { kcal: 0, protein: 0, fat: 0, carb: 0 }
    for (const f of NUT) {
      if (Math.abs(e[f] - a[f]) > EPS) sumDiff.push(`${day} ${f}: sheet ${r6(e[f])} vs D1 ${r6(a[f])}`)
    }
  }
  checks.push({
    name: `logs: per-day kcal/protein/fat/carb sums (${exp.logSums.size} days)`,
    ok: sumDiff.length === 0,
    ...(sumDiff.length ? { diff: [...sumDiff.slice(0, 20), ...(sumDiff.length > 20 ? [`... ${sumDiff.length - 20} more`] : [])] } : {}),
  })

  // kg per day
  const kgActual = new Map<string, number>()
  for (const w of ownRows(dump, 'weights', opts.userId)) if (w.deleted_at === null || w.deleted_at === undefined) kgActual.set(String(w.day), Number(w.kg))
  const kgDiff: string[] = []
  for (const day of new Set([...exp.kg.keys(), ...kgActual.keys()])) {
    const e = exp.kg.get(day)
    const a = kgActual.get(day)
    if (e === undefined || a === undefined || Math.abs(e - a) > EPS) kgDiff.push(`${day}: sheet ${e ?? '(none)'} vs D1 ${a ?? '(none)'}`)
  }
  checks.push({ name: `weights: kg per day (${exp.kg.size} days)`, ok: kgDiff.length === 0, ...(kgDiff.length ? { diff: kgDiff.slice(0, 20) } : {}) })

  // config
  const cfgRows = ownRows(dump, 'config', opts.userId)
  const cfg = cfgRows[0]
  if (!cfg) checks.push({ name: 'config: row', ok: false, expected: 'one row', actual: 'none' })
  for (const [k, e] of Object.entries(exp.config)) {
    if (!cfg) break
    let a = cfg[k]
    if (a === undefined) a = null
    const ok = JSON.stringify(a) === JSON.stringify(e)
    checks.push({ name: `config: ${k}`, ok, expected: e, actual: a })
  }
  if (cfgRows.length > 1) checks.push({ name: 'config: rows', ok: false, expected: 1, actual: cfgRows.length })

  // favorites (live rows)
  const favActual = new Set(ownRows(dump, 'favorites', opts.userId).filter((r) => r.deleted_at === null || r.deleted_at === undefined).map((r) => String(r.item_id)))
  const fs = sameSet(exp.favorites, favActual)
  checks.push({ name: `favorites: set (${exp.favorites.size})`, ok: fs.ok, ...(fs.ok ? {} : { diff: fs.diff }) })

  return { ok: checks.every((c) => c.ok), checks, anomalies: anomalySummary(anomalies), meta: dump.meta, otherUsersRows }
}

export function formatReport(report: VerifyReport): string {
  const lines: string[] = []
  lines.push(`D1 meta: version ${report.meta.version}, epoch ${report.meta.epoch || '(unknown)'}`)
  if (report.otherUsersRows) lines.push(`note: ${report.otherUsersRows} dump rows belong to another user_id and were ignored`)
  const an = Object.entries(report.anomalies)
  lines.push(an.length ? `anomalies accounted for (${an.reduce((n, [, v]) => n + v, 0)}):` : 'anomalies accounted for: none')
  for (const [k, n] of an.sort()) lines.push(`  ${String(n).padStart(4)}  ${k}`)
  lines.push('')
  for (const c of report.checks) {
    lines.push(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok || c.expected === undefined ? '' : `: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`}`)
    for (const d of c.diff ?? []) lines.push(`        ${d}`)
  }
  const bad = report.checks.filter((c) => !c.ok).length
  lines.push('', bad === 0 ? `VERIFY OK (${report.checks.length} checks)` : `VERIFY FAILED: ${bad} of ${report.checks.length} checks differ`)
  return lines.join('\n')
}

function main(): void {
  const { opts } = parseArgs(process.argv.slice(2))
  if (!opts.sheet || !opts.dump || !opts['user-id']) die('usage: verify --sheet <sheet.json> --dump <d1-dump.json|.sql> --user-id <owner user.id>')
  const snapshot = JSON.parse(readFileSync(path.resolve(opts.sheet), 'utf8')) as SheetSnapshot
  const report = verifySnapshot(snapshot, readDump(path.resolve(opts.dump)), { userId: opts['user-id'] })
  console.log(formatReport(report))
  process.exit(report.ok ? 0 : 1)
}

if (isMain(import.meta.url)) main()
