// Test helpers. ALL data here is synthetic (made-up names and numbers); nothing comes from a real Sheet.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { addDays, taipeiToday } from '@food-log/core'
import { SNAPSHOT_FORMAT } from '../src/types.ts'
import type { SheetRecord, SheetSnapshot } from '../src/types.ts'
import { dumpQueries, emptyDump } from '../src/dump.ts'
import type { D1Dump } from '../src/types.ts'
import { TABLES } from '@food-log/core'
import type { Table } from '@food-log/core'
import { readyGas } from '../../../legacy/test/gas-fakes'
import type { GasClient } from '../src/gas-client.ts'

export const OWNER = 'user-test-owner'

/** A minimal snapshot; rows are given per table. */
export function snap(parts: Partial<Pick<SheetSnapshot, 'items' | 'stores' | 'logs' | 'weights' | 'config'>> = {}): SheetSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    fetchedAt: '2026-10-15T01:00:00.000Z',
    serverTime: '2026-10-15T09:00:00+08:00',
    apiVersion: 1,
    config: { target_kcal: '2000', target_protein: '150', target_fat: '60', target_carb: '200', tdee: '', remind_meal_times: '', remind_weight_time: '', fav_ids: '', schema_version: '2', ...parts.config },
    items: parts.items ?? [],
    stores: parts.stores ?? [],
    logs: parts.logs ?? [],
    weights: parts.weights ?? [],
    warnings: [],
    pages: { Logs: 0, Weights: 0 },
  }
}

export const T = (day: string, hhmm = '12:00'): string => `${day}T${hhmm}:00+08:00`

export function sheetLog(over: SheetRecord = {}): SheetRecord {
  return {
    id: 'l1', ts: T('2026-10-10'), deleted: false, updated_at: T('2026-10-10', '12:01'), day: '2026-10-10', item_id: 'u:soy', name: 'Soy milk', src: '其他',
    qty: 1, grams: '', kcal: 100, protein: 10, fat: 2, carb: 8, source: 'app', store: '', ...over,
  }
}
export function sheetItem(over: SheetRecord = {}): SheetRecord {
  return {
    id: 'u:soy', ts: T('2026-10-01'), deleted: false, updated_at: T('2026-10-01', '08:00'), kind: '自建', base_id: '', src: '其他', name: 'Soy milk', serving: '1 cup',
    serving_g: '', kcal: 100, protein: 10, fat: 2, carb: 8, fav: false, created_by: 'app', store: '', ...over,
  }
}
export function sheetStore(over: SheetRecord = {}): SheetRecord {
  return { id: 's:a', ts: T('2026-10-01'), deleted: false, updated_at: T('2026-10-01', '08:00'), name: 'Corner Shop', last_eaten_at: '', created_by: 'app', ...over }
}
export function sheetWeight(over: SheetRecord = {}): SheetRecord {
  return { day: '2026-10-10', ts: T('2026-10-10', '07:00'), deleted: false, updated_at: T('2026-10-10', '07:01'), kg: 70.5, id: 'w1', ...over }
}

// ------------------------------------------------------------------ node:sqlite as a stand-in for D1

/** A fresh in-memory SQLite with the real v2 migrations applied (STRICT, CHECKs, partial unique indexes, meta). */
export function d1Sqlite(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const dir = path.resolve(import.meta.dirname, '../../../workers/api/migrations')
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(path.join(dir, f), 'utf8'))
  return db
}

/** Run a SQL file the way `wrangler d1 execute --file` would (statement by statement; the first failure throws). */
export function runSql(db: DatabaseSync, sql: string): void {
  db.exec(sql)
}

/** Read the SQLite back as a D1Dump using the very queries `d1-dump-command` prints. */
export function dumpOf(db: DatabaseSync): D1Dump {
  const sets = dumpQueries().map((q) => ({ results: db.prepare(q).all() as Record<string, unknown>[], success: true }))
  const dump = emptyDump()
  // round-trip through the wrangler JSON shape (parser under test elsewhere; here only the shape matters)
  for (const set of sets) {
    for (const row of set.results) {
      const { _t, ...rest } = row
      if (_t === 'meta') {
        if (rest.key === 'version') dump.meta.version = Number(rest.value)
        if (rest.key === 'epoch') dump.meta.epoch = String(rest.value)
      } else {
        const r = { ...rest } as Record<string, unknown>
        if (_t === 'config') r.remind_meal_times = JSON.parse(String(r.remind_meal_times))
        dump.tables[_t as Table].push(r)
      }
    }
  }
  return dump
}

export { TABLES }

// ------------------------------------------------------------------ the in-memory Apps Script, seeded with realistic synthetic data

export const today = (): string => taipeiToday(Date.now())
export const dayBack = (n: number): string => addDays(today(), -n)

export function fakeGasClient(env: { call: (b: Record<string, unknown>) => unknown }): GasClient {
  return { call: async (body) => structuredClone(env.call(body)) as never }
}

/**
 * A Sheet with: 3 stores (one deleted with its items), items of every kind (custom, override, store items, favourite, deleted),
 * Config with a legacy time cell, 130 days of logs (2 per day: more than one `history` page), 120 days of weights, and the quirks
 * real Sheets collect: a weight row without id, two live weights on one day, a log whose day does not match its ts,
 * a log with numbers stored as text, a 7-11 log (Sheet turns "7-11" into a date), Date objects in ts cells.
 */
export function seedFakeGas() {
  const env = readyGas()
  const call = (body: Record<string, unknown>) => {
    const r = env.call(body)
    if (r.ok === false) throw new Error(`seed ${String(body.action)} failed: ${r.error} ${r.message ?? ''}`)
    return r
  }
  const at = (d: string, hhmm = '12:00') => T(d, hhmm)

  for (const [k, v] of [['target_kcal', '1800'], ['target_protein', '120'], ['target_fat', '55'], ['target_carb', '210'], ['tdee', '2300'], ['remind_meal_times', '08:00,12:30,18:30'], ['remind_weight_time', '07:30'], ['fav_ids', 'fm:100,711:200']] as const) {
    call({ action: 'setConfig', key: k, value: v })
  }
  call({ action: 'upsertStore', record: { id: 's:aaa', ts: at(dayBack(60)), name: '全聯 Mart', created_by: 'app' } })
  call({ action: 'upsertStore', record: { id: 's:bbb', ts: at(dayBack(50)), name: 'Cafe  Mocha', created_by: 'app' } })
  call({ action: 'upsertStore', record: { id: 's:ccc', ts: at(dayBack(40)), name: 'Closed Diner', created_by: 'app' } })
  const item = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id, ts: at(dayBack(30)), kind: '自建', base_id: '', src: '其他', name, serving: '1 份', serving_g: null, kcal: 200, protein: 10, fat: 5, carb: 25, fav: false, created_by: 'app', store: '', ...over,
  })
  call({ action: 'upsertItem', record: item('u:soy', 'Soy milk', { fav: true, kcal: 100, protein: 8, fat: 4, carb: 6, serving_g: 250 }) })
  call({ action: 'upsertItem', record: item('u:salad', 'House salad', { store: 's:aaa', kcal: 150, protein: 5, fat: 7, carb: 12 }) })
  call({ action: 'upsertItem', record: item('u:bagel', 'Bagel', { src: '全家' }) })
  call({ action: 'upsertItem', record: item('u:diner', 'Diner burger', { store: 's:ccc', kcal: 700, protein: 30, fat: 40, carb: 50 }) })
  call({ action: 'upsertItem', record: item('ov:fm:100', 'Override rice', { kind: '補填', base_id: 'fm:100', src: '全家', kcal: 320, protein: 6, fat: 2, carb: 70, created_by: 'app' }) })
  env.call({ action: 'upsertItem', client: 'kyujin', record: item('u:kyu', 'Kyujin estimate', { created_by: 'kyujin', kcal: 450, protein: 25, fat: 15, carb: 50 }) })
  call({ action: 'softDelete', table: 'Stores', id: 's:ccc' }) // cascades u:diner

  for (let n = 0; n < 130; n++) {
    const d = dayBack(n)
    call({ action: 'append', table: 'Logs', record: { id: `l-${n}-a`, ts: at(d, '08:30'), day: d, item_id: 'u:soy', name: 'Soy milk', src: '其他', qty: 1 + (n % 3) * 0.5, kcal: 100 + n, protein: 8, fat: 4, carb: 6.5 } })
    call({ action: 'append', table: 'Logs', record: { id: `l-${n}-b`, ts: at(d, '19:15'), day: d, item_id: 'u:salad', name: 'House salad', src: '其他', qty: 1, grams: 180, kcal: 150, protein: 5.5, fat: 7, carb: 12.25, store: 's:aaa' } })
  }
  const d3 = dayBack(3)
  call({ action: 'append', table: 'Logs', record: { id: 'l-quick', ts: at(d3, '15:00'), day: d3, item_id: '', name: 'Quick snack', src: '其他', qty: 1, kcal: 240, protein: 4, fat: 12, carb: 30, source: 'quick' } })
  env.call({ action: 'append', client: 'kyujin', table: 'Logs', record: { id: 'l-kyu', ts: at(d3, '20:00'), day: d3, item_id: '', name: 'Kyujin dinner', src: '其他', qty: 1, kcal: 600, protein: 35, fat: 20, carb: 60, source: 'kyujin' } })
  call({ action: 'append', table: 'Logs', record: { id: 'l-711', ts: at(dayBack(2), '10:00'), day: dayBack(2), item_id: 'fm:100', name: 'Onigiri', src: '7-11', qty: 1, kcal: 180, protein: 4, fat: 3, carb: 36 } })
  call({ action: 'append', table: 'Logs', record: { id: 'l-gone', ts: at(dayBack(4), '12:00'), day: dayBack(4), item_id: 'u:bagel', name: 'Bagel', src: '全家', qty: 1, kcal: 260, protein: 9, fat: 2, carb: 50 } })
  call({ action: 'softDelete', table: 'Logs', id: 'l-gone' })

  for (let n = 0; n < 120; n++) {
    const d = dayBack(n)
    call({ action: 'upsertWeight', record: { id: `w-${n}`, ts: at(d, '07:00'), day: d, kg: Math.round((70 + Math.sin(n / 5) * 2) * 10) / 10 } })
  }
  call({ action: 'upsertWeight', record: { id: 'w-gone', ts: at(dayBack(130), '07:00'), day: dayBack(130), kg: 69.9 } })
  call({ action: 'softDelete', table: 'Weights', id: 'w-gone' })

  // ---- quirks written straight into the sheets (the API would refuse or normalise them) ----
  const sh = (n: string) => env.sheets.get(n)!
  const col = (n: string, c: string) => (sh(n).data[0] as string[]).indexOf(c)
  const rowOf = (n: string, id: string) => sh(n).data.findIndex((r, i) => i > 0 && String((r as unknown[])[col(n, 'id')]) === id)
  const setCell = (n: string, id: string, c: string, v: unknown) => { sh(n).data[rowOf(n, id)]![col(n, c)] = v }
  // a weight row without id (rows from before ids existed) 150 days back
  const oldDay = dayBack(150)
  const wcols = sh('Weights').data[0] as string[]
  const raw = (rec: Record<string, unknown>) => wcols.map((c) => (c in rec ? rec[c] : ''))
  sh('Weights').data.push(raw({ day: oldDay, ts: at(oldDay, '07:00'), deleted: false, updated_at: at(oldDay, '07:01'), kg: 71.2, id: '' }))
  // two live weights on one day (an old overwrite bug)
  const dupDay = dayBack(100)
  sh('Weights').data.push(raw({ day: dupDay, ts: at(dupDay, '21:00'), deleted: false, updated_at: at(dupDay, '21:01'), kg: 69.3, id: 'w-dup' }))
  // a log whose day column disagrees with ts
  setCell('Logs', 'l-5-a', 'day', dayBack(6))
  // numbers stored as text
  setCell('Logs', 'l-7-a', 'kcal', '123')
  setCell('Logs', 'l-7-a', 'protein', '9.5')
  // Date objects in ts / updated_at cells
  setCell('Logs', 'l-8-b', 'ts', new Date(Date.parse(at(dayBack(8), '19:15'))))
  setCell('Logs', 'l-8-b', 'updated_at', new Date(Date.parse(at(dayBack(8), '19:16'))))
  // the legacy "Sheet turned 07:30 into a time" cell
  const cfgSheet = sh('Config')
  const cfgRow = cfgSheet.data.findIndex((r, i) => i > 0 && String((r as unknown[])[0]) === 'remind_weight_time')
  cfgSheet.data[cfgRow]![1] = new Date('1899-12-30T07:30:00+08:00')

  return { env, client: fakeGasClient(env), call, today: today() }
}
