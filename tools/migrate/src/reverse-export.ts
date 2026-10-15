// reverse-export: the ROLLBACK tool (plan 6, PRD 11.4). Replays everything that changed in D1 since the cut-over version V_cut
// as Apps Script actions, so the Sheet is current again before v1 is switched back on.      ⛔ Brian runs it against the real /exec.
//
//   1) GAS Script Property READ_ONLY=0
//   2) npx -y pnpm@10 --filter @food-log/migrate reverse-export --dump out/d1-dump.json --since <V_cut> --user-id <id> --fetch-base --dry-run
//   3) the same command without --dry-run (needs GAS_URL / GAS_SECRET in the environment)
//
// Input: a D1 dump (dump.ts) and V_cut. Only rows with version > V_cut are looked at, and only their FINAL state is replayed:
//   stores    upsertStore            (+ restore / softDelete)
//   items     upsertItem (fav from the favorites table; also when only the favourite flag changed)
//   favorites official favourites -> setConfig fav_ids (the whole final set)
//   logs      append (new) / update (changed) / restore / softDelete
//   weights   upsertWeight / restore / softDelete
//   config    setConfig per key
// Order: stores, items, logs, weights, config, fav_ids; inside a table by version. (A strict global version order cannot be used:
// a store renamed at version 15 must exist before an item at version 10 that points at it, because the final state is replayed.)
//
// The plan is computed against a BASE: the Sheet as it is now (--fetch-base reads it with the read-only `read` / `history`
// actions; --base <sheet.json> uses a snapshot). With a base the plan contains only what actually differs, so re-running it
// after a partial failure, or twice, is a no-op for what already happened. Without a base the plan is conservative (every step
// is idempotent in Apps Script: append / upsert are keyed by id, restore / softDelete of a missing row is tolerated).
// Apps Script quirks it works around: upsertWeight with an existing id only returns `duplicate` (it never updates), and a
// new id on a day that already has a live weight overwrites that row's kg / ts: so a changed kg is written with a fresh id
// (`<id>~r<version>`), which overwrites. Rows can only be addressed by id, so Sheet weight rows without an id cannot be deleted.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Table } from '@food-log/core'
import { die, isMain, parseArgs } from './cli-util.ts'
import { readDump } from './dump.ts'
import { fetchSheet } from './fetch-sheet.ts'
import { gasClientFromEnv } from './gas-client.ts'
import type { GasClient } from './gas-client.ts'
import { canonicalTs, sheetDeleted } from './transform.ts'
import type { D1Dump, DumpRow, SheetRecord, SheetSnapshot } from './types.ts'

export interface GasStep {
  seq: number
  /** version of the D1 row that caused the step */
  version: number
  table: Table
  id: string
  label: string
  request: Record<string, unknown>
  /** GAS error codes that are fine for this step (e.g. restore of a row that is not there) */
  tolerate?: string[]
}

export interface Plan {
  userId: string
  since: number
  /** false: no Sheet snapshot was given, the plan is the conservative one */
  withBase: boolean
  steps: GasStep[]
  warnings: string[]
}

type Rec = Record<string, unknown>

const blank = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === ''
const sameText = (a: unknown, b: unknown): boolean => (blank(a) && blank(b)) || String(a) === String(b)
const sameNum = (a: unknown, b: unknown): boolean => {
  if (blank(a) || blank(b)) return blank(a) && blank(b)
  return Math.abs(Number(a) - Number(b)) < 1e-9
}
const sameTs = (a: unknown, b: unknown): boolean => (blank(a) && blank(b)) || (canonicalTs(a) ?? String(a)) === (canonicalTs(b) ?? String(b))

/** Config values are strings in the Sheet: equal text, or the same number written differently ("1800" / "1800.0"). */
const sameConfig = (a: string, b: string): boolean => a.trim() === b.trim() || (/^\d+(\.\d+)?$/.test(a.trim()) && /^\d+(\.\d+)?$/.test(b.trim()) && Number(a) === Number(b))

const live = (r: DumpRow): boolean => r.deleted_at === null || r.deleted_at === undefined
const ver = (r: DumpRow): number => Number(r.version)
const idOf = (r: DumpRow): string => String(r.id)

function indexById(rows: SheetRecord[]): Map<string, SheetRecord> {
  const m = new Map<string, SheetRecord>()
  for (const r of rows) {
    const id = String(r.id ?? '').trim()
    if (id) m.set(id, r)
  }
  return m
}

export function buildPlan(dump: D1Dump, opts: { userId: string; since: number; base?: SheetSnapshot | null }): Plan {
  const { userId, since } = opts
  const base = opts.base ?? null
  const mine = (t: Table): DumpRow[] => dump.tables[t].filter((r) => r.user_id === undefined || r.user_id === userId)
  const steps: GasStep[] = []
  const warnings: string[] = []
  const add = (version: number, table: Table, id: string, label: string, request: Rec, tolerate?: string[]): void => {
    steps.push({ seq: steps.length + 1, version, table, id, label, request, ...(tolerate ? { tolerate } : {}) })
  }

  const bStores = base ? indexById(base.stores) : null
  const bItems = base ? indexById(base.items) : null
  const bLogs = base ? indexById(base.logs) : null
  const bWeightsById = new Map<string, SheetRecord>()
  const bWeightLiveByDay = new Map<string, SheetRecord>()
  if (base) {
    for (const w of base.weights) {
      const day = String(w.day ?? '').slice(0, 10)
      bWeightsById.set(String(w.id ?? '').trim() || `w:${day}`, w)
      if (!sheetDeleted(w)) bWeightLiveByDay.set(day, w)
    }
  }

  // ---- stores ----
  for (const row of mine('stores').filter((r) => ver(r) > since).sort((a, b) => ver(a) - ver(b))) {
    const id = idOf(row)
    const b = bStores?.get(id)
    const rec: Rec = { id, ts: row.ts, name: row.name, created_by: row.created_by, last_eaten_at: row.last_eaten_at ?? '' }
    const up = (): void => add(ver(row), 'stores', id, 'upsertStore', { action: 'upsertStore', record: rec, ...(row.created_by === 'kyujin' ? { client: 'kyujin' } : {}) })
    if (live(row)) {
      if (!bStores) {
        add(ver(row), 'stores', id, 'restore', { action: 'restore', table: 'Stores', id }, ['not_found'])
        up()
      } else {
        if (b && sheetDeleted(b)) add(ver(row), 'stores', id, 'restore', { action: 'restore', table: 'Stores', id })
        if (!b || sheetDeleted(b) || !sameText(b.name, row.name) || !sameTs(b.last_eaten_at, row.last_eaten_at)) up()
      }
    } else if (!bStores) {
      add(ver(row), 'stores', id, 'softDelete', { action: 'softDelete', table: 'Stores', id }) // absent in the Sheet: nothing to delete
    } else if (b && !sheetDeleted(b)) add(ver(row), 'stores', id, 'softDelete', { action: 'softDelete', table: 'Stores', id })
  }

  // ---- favorites -> items.fav (u:) and Config.fav_ids (official) ----
  const favRows = mine('favorites')
  const favLive = new Set(favRows.filter(live).map((r) => String(r.item_id)))
  const favVersion = new Map(favRows.map((r) => [String(r.item_id), ver(r)]))

  // ---- items ----
  const items = mine('items')
  const itemVersion = (r: DumpRow): number => Math.max(ver(r), favVersion.get(idOf(r)) ?? 0)
  for (const row of items.filter((r) => itemVersion(r) > since).sort((a, b) => itemVersion(a) - itemVersion(b))) {
    const id = idOf(row)
    const v = itemVersion(row)
    const b = bItems?.get(id)
    const fav = id.startsWith('u:') && favLive.has(id)
    const rec: Rec = {
      id,
      ts: row.ts,
      kind: row.kind,
      base_id: row.base_id ?? '',
      src: row.src,
      name: row.name,
      serving: row.serving,
      serving_g: row.serving_g ?? null,
      kcal: row.kcal,
      protein: row.protein,
      fat: row.fat,
      carb: row.carb,
      fav,
      created_by: row.created_by,
      store: row.store_id ?? '',
    }
    const differs = (s: SheetRecord): boolean =>
      !sameText(s.kind, row.kind) ||
      !sameText(s.base_id, row.base_id) ||
      !sameText(s.src, row.src) ||
      !sameText(s.name, row.name) ||
      !sameText(s.serving, row.serving) ||
      !sameNum(s.serving_g, row.serving_g) ||
      !sameNum(s.kcal, row.kcal) ||
      !sameNum(s.protein, row.protein) ||
      !sameNum(s.fat, row.fat) ||
      !sameNum(s.carb, row.carb) ||
      !sameText(s.store, row.store_id) ||
      (id.startsWith('u:') && (s.fav === true) !== fav)
    const up = (): void => add(v, 'items', id, 'upsertItem', { action: 'upsertItem', record: rec })
    if (live(row)) {
      if (!bItems) {
        add(v, 'items', id, 'restore', { action: 'restore', table: 'Items', id }, ['not_found'])
        up()
      } else {
        if (b && sheetDeleted(b)) add(v, 'items', id, 'restore', { action: 'restore', table: 'Items', id })
        if (!b || sheetDeleted(b) || differs(b)) up()
      }
    } else if (!bItems) {
      add(v, 'items', id, 'softDelete', { action: 'softDelete', table: 'Items', id })
    } else if (b && !sheetDeleted(b)) add(v, 'items', id, 'softDelete', { action: 'softDelete', table: 'Items', id })
  }

  // ---- logs ----
  const PATCH = ['qty', 'grams', 'kcal', 'protein', 'fat', 'carb', 'ts', 'day', 'name'] as const
  for (const row of mine('logs').filter((r) => ver(r) > since).sort((a, b) => ver(a) - ver(b))) {
    const id = idOf(row)
    const b = bLogs?.get(id)
    const rec: Rec = {
      id,
      ts: row.ts,
      day: row.day,
      item_id: row.item_id ?? '',
      name: row.name,
      src: row.src,
      qty: row.qty,
      grams: row.grams ?? null,
      kcal: row.kcal,
      protein: row.protein,
      fat: row.fat,
      carb: row.carb,
      source: row.source,
      store: row.store_id ?? '',
    }
    const client = row.source === 'kyujin' ? { client: 'kyujin' } : {}
    const append = (): void => add(ver(row), 'logs', id, 'append', { action: 'append', table: 'Logs', record: rec, ...client })
    const patchOf = (s: SheetRecord | undefined): Rec => {
      const patch: Rec = {}
      for (const f of PATCH) {
        const same = f === 'ts' ? sameTs(s?.[f], row[f]) : f === 'day' || f === 'name' ? sameText(s?.[f], row[f]) : sameNum(s?.[f], row[f])
        if (!s || !same) patch[f] = f === 'grams' ? (row.grams ?? null) : row[f]
      }
      return patch
    }
    const update = (s: SheetRecord | undefined): void => {
      const patch = patchOf(s)
      if (Object.keys(patch).length) add(ver(row), 'logs', id, 'update', { action: 'update', table: 'Logs', id, patch })
    }
    if (live(row)) {
      if (!bLogs) {
        add(ver(row), 'logs', id, 'restore', { action: 'restore', table: 'Logs', id }, ['not_found'])
        append()
        update(undefined)
      } else if (!b) append()
      else {
        if (sheetDeleted(b)) add(ver(row), 'logs', id, 'restore', { action: 'restore', table: 'Logs', id })
        update(b)
      }
    } else if (!bLogs) {
      add(ver(row), 'logs', id, 'softDelete', { action: 'softDelete', table: 'Logs', id })
    } else if (b && !sheetDeleted(b)) add(ver(row), 'logs', id, 'softDelete', { action: 'softDelete', table: 'Logs', id })
  }

  // ---- weights ----
  for (const row of mine('weights').filter((r) => ver(r) > since).sort((a, b) => ver(a) - ver(b))) {
    const id = idOf(row)
    const day = String(row.day)
    const v = ver(row)
    const rec = (wid: string): Rec => ({ id: wid, ts: row.ts, day, kg: row.kg })
    const overwriteId = `${id}~r${v}`
    const upsert = (wid: string): void => add(v, 'weights', id, 'upsertWeight', { action: 'upsertWeight', record: rec(wid) })
    if (live(row)) {
      if (!base) {
        add(v, 'weights', id, 'restore', { action: 'restore', table: 'Weights', id }, ['not_found', 'bad_record'])
        upsert(id)
        upsert(overwriteId)
      } else {
        const onDay = bWeightLiveByDay.get(day)
        const bx = bWeightsById.get(id)
        if (onDay) {
          if (!sameNum(onDay.kg, row.kg)) upsert(overwriteId)
        } else if (bx) {
          add(v, 'weights', id, 'restore', { action: 'restore', table: 'Weights', id })
          if (!sameNum(bx.kg, row.kg)) upsert(overwriteId)
        } else upsert(id)
      }
    } else if (!base) {
      add(v, 'weights', id, 'softDelete', { action: 'softDelete', table: 'Weights', id })
    } else {
      const bx = bWeightsById.get(id)
      if (bx && !sheetDeleted(bx)) {
        if (String(bx.id ?? '').trim() === '') warnings.push(`weights ${day}: the Sheet row has no id, softDelete cannot address it; delete it by hand`)
        else add(v, 'weights', id, 'softDelete', { action: 'softDelete', table: 'Weights', id })
      }
    }
  }

  // ---- config ----
  const cfgRow = mine('config').find((r) => ver(r) > since)
  if (cfgRow) {
    const want: Record<string, string> = {
      target_kcal: String(cfgRow.target_kcal),
      target_protein: String(cfgRow.target_protein),
      target_fat: String(cfgRow.target_fat),
      target_carb: String(cfgRow.target_carb),
      tdee: cfgRow.tdee === null || cfgRow.tdee === undefined ? '' : String(cfgRow.tdee),
      remind_meal_times: Array.isArray(cfgRow.remind_meal_times) ? (cfgRow.remind_meal_times as string[]).join(',') : String(cfgRow.remind_meal_times ?? ''),
      remind_weight_time: cfgRow.remind_weight_time === null || cfgRow.remind_weight_time === undefined ? '' : String(cfgRow.remind_weight_time),
    }
    for (const [key, value] of Object.entries(want)) {
      const have = base?.config[key]
      if (base && have !== undefined && sameConfig(have, value)) continue
      add(ver(cfgRow), 'config', key, 'setConfig', { action: 'setConfig', key, value })
    }
  }

  // ---- official favourites: the whole final set ----
  const officialChanged = favRows.some((r) => ver(r) > since && !String(r.item_id).startsWith('u:') && !String(r.item_id).startsWith('ov:'))
  if (officialChanged) {
    const ids = [...favLive].filter((i) => !i.startsWith('u:') && !i.startsWith('ov:')).sort()
    const value = ids.join(',')
    const have = base ? String(base.config.fav_ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).sort().join(',') : null
    if (have !== value) add(Math.max(...favRows.map(ver)), 'favorites', 'fav_ids', 'setConfig', { action: 'setConfig', key: 'fav_ids', value })
  }

  return { userId, since, withBase: base !== null, steps, warnings }
}

export interface ApplyReport {
  applied: number
  tolerated: number
  failed: { seq: number; label: string; id: string; error: string; message: string }[]
}

/** Run the steps in order against Apps Script. A failing step is recorded and the run goes on (the plan is idempotent: fix, re-run). */
export async function applyPlan(client: GasClient, plan: Plan, onStep?: (s: GasStep, outcome: 'ok' | 'tolerated' | 'failed') => void): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, tolerated: 0, failed: [] }
  for (const step of plan.steps) {
    let outcome: 'ok' | 'tolerated' | 'failed' = 'ok'
    try {
      const res = await client.call(step.request)
      if (res.ok === false) {
        const code = String(res.error ?? 'error')
        if (step.tolerate?.includes(code)) {
          outcome = 'tolerated'
          report.tolerated++
        } else {
          outcome = 'failed'
          report.failed.push({ seq: step.seq, label: step.label, id: step.id, error: code, message: String(res.message ?? '') })
        }
      } else report.applied++
    } catch (e) {
      outcome = 'failed'
      report.failed.push({ seq: step.seq, label: step.label, id: step.id, error: 'exception', message: String((e as Error).message ?? e) })
    }
    onStep?.(step, outcome)
  }
  return report
}

export function formatPlan(plan: Plan): string {
  const lines = [
    `reverse-export plan: user ${plan.userId}, since version ${plan.since}, ${plan.withBase ? 'diffed against the current Sheet' : 'NO BASE (conservative plan: every step is idempotent)'}: ${plan.steps.length} step(s)`,
  ]
  for (const s of plan.steps) {
    const r = s.request
    const body = r.record ?? r.patch ?? (r.key !== undefined ? { key: r.key, value: r.value } : undefined)
    lines.push(`  ${String(s.seq).padStart(4)}  v${s.version}  ${s.table}/${s.id}  ${s.label}${r.client ? ` (client ${String(r.client)})` : ''}${s.tolerate ? ` [tolerates ${s.tolerate.join(',')}]` : ''}${body ? '  ' + JSON.stringify(body) : ''}`)
  }
  for (const w of plan.warnings) lines.push(`  warning: ${w}`)
  return lines.join('\n')
}

async function main(): Promise<void> {
  const { flags, opts } = parseArgs(process.argv.slice(2))
  if (!opts.dump || !opts['user-id'] || opts.since === undefined) die('usage: reverse-export --dump <d1-dump> --since <V_cut> --user-id <owner user.id> [--fetch-base | --base <sheet.json>] [--dry-run] [--plan-out <file>]')
  const since = Number(opts.since)
  if (!Number.isInteger(since) || since < 0) die('--since must be a non-negative integer (the D1 meta.version at cut-over)')
  const dump = readDump(path.resolve(opts.dump))
  const dry = flags.has('dry-run')
  let client: GasClient | null = null
  if (!dry || flags.has('fetch-base')) {
    try {
      client = gasClientFromEnv()
    } catch (e) {
      return die((e as Error).message)
    }
  }
  let base: SheetSnapshot | null = null
  if (opts.base) base = JSON.parse(readFileSync(path.resolve(opts.base), 'utf8')) as SheetSnapshot
  else if (flags.has('fetch-base')) base = await fetchSheet(client!)
  const plan = buildPlan(dump, { userId: opts['user-id'], since, base })
  console.log(formatPlan(plan))
  if (opts['plan-out']) writeFileSync(path.resolve(opts['plan-out']), JSON.stringify(plan, null, 1) + '\n', { mode: 0o600 })
  if (dry) {
    console.log('\n--dry-run: nothing was sent to Apps Script')
    return
  }
  const report = await applyPlan(client!, plan, (s, o) => console.log(`  #${s.seq} ${s.table}/${s.id} ${s.label}: ${o}`))
  console.log(`\napplied ${report.applied}, tolerated ${report.tolerated}, failed ${report.failed.length}`)
  for (const f of report.failed) console.error(`FAILED #${f.seq} ${f.label} ${f.id}: ${f.error} ${f.message}`)
  console.log('re-run the same command (with --fetch-base) until it reports 0 steps: it only sends what still differs')
  process.exit(report.failed.length ? 1 : 0)
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  })
}
