import { expect, test } from 'vitest'
import { readyGas, loadGas } from './gas-fakes'

const LOG_COLS = ['id', 'ts', 'deleted', 'updated_at', 'day', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb', 'source', 'store']

function isDateCell(v: unknown) {
  return Object.prototype.toString.call(v) === '[object Date]'
}

function logRow(over: Record<string, unknown> = {}) {
  const rec: Record<string, unknown> = {
    id: 'l-old',
    ts: '2026-10-10T13:00:00+08:00',
    deleted: false,
    updated_at: '2026-10-10T13:00:00+08:00',
    day: '2026-10-10',
    item_id: 'u:1',
    name: '統一陽光無加糖',
    src: '7-11',
    qty: 1,
    grams: '',
    kcal: 53,
    protein: 10.4,
    fat: 0,
    carb: 10,
    source: 'app',
    store: '',
    ...over,
  }
  return LOG_COLS.map((c) => rec[c])
}

const rec711 = {
  id: 'l-711',
  ts: '2026-10-10T13:00:00+08:00',
  day: '2026-10-10',
  item_id: 'u:1',
  name: '統一陽光無加糖',
  src: '7-11',
  qty: 1,
  kcal: 53,
  protein: 10.4,
  fat: 0,
  carb: 10,
}

test('寫入格式：文字欄 @、數字欄仍是 number', () => {
  const env = readyGas()
  const r = env.call({ action: 'append', table: 'Logs', record: rec711 })
  expect(r.ok).toBe(true)
  const sh = env.sheets.get('Logs')!
  const row = sh.data[1]
  expect(row[7]).toBe('7-11')
  expect(isDateCell(row[7])).toBe(false)
  expect(sh.formats.get('2:8')).toBe('@')
  expect(row[4]).toBe('2026-10-10')
  expect(sh.formats.get('2:5')).toBe('@')
  expect(row[10]).toBe(53)
  expect(typeof row[10]).toBe('number')
  expect(sh.formats.get('2:11')).not.toBe('@')
  expect(sh.formats.get('2:1')).toBe('@')
  const read = env.call({ action: 'read' })
  expect(read.logs[0].src).toBe('7-11')
  expect(read.logs[0].day).toBe('2026-10-10')
})

test('舊資料防禦性讀取：Date 的 day／src 讀回文字；只 patch qty 可更新', () => {
  const env = readyGas()
  const sh = env.sheets.get('Logs')!
  sh.appendRow(logRow())
  const read = env.call({ action: 'read' })
  const hit = read.logs.find((l: { id: string }) => l.id === 'l-old')
  expect(hit.src).toBe('7-11')
  expect(hit.day).toBe('2026-10-10')
  expect(String(hit.day)).not.toContain('T08:00')
  const upd = env.call({ action: 'update', table: 'Logs', id: 'l-old', patch: { qty: 2 } })
  expect(upd.ok).toBe(true)
  expect(upd.record.day).toBe('2026-10-10')
  expect(upd.error).not.toBe('bad_record')
})

test('不是 7 月 11 日的 src Date 不要變成 7-11', () => {
  const env = readyGas()
  const sh = env.sheets.get('Logs')!
  sh.appendRow(logRow({ id: 'l-aug' }))
  const VmDate = env.g.Date as DateConstructor
  sh.set(2, 8, new VmDate(Date.UTC(2026, 7, 1)))
  const read = env.call({ action: 'read' })
  const hit = read.logs.find((l: { id: string }) => l.id === 'l-aug')
  expect(hit.src).not.toBe('7-11')
})

test('遷移冪等：Date 的 day／src 修好後第二次 textFixes 全 0', () => {
  const env = readyGas()
  const sh = env.sheets.get('Logs')!
  sh.appendRow(logRow())
  expect(isDateCell(sh.data[1][4])).toBe(true)
  expect(isDateCell(sh.data[1][7])).toBe(true)
  const report = env.g.migrateFoodLog()
  expect(report.textFixes.Logs).toBeGreaterThanOrEqual(1)
  expect(sh.data[1][4]).toBe('2026-10-10')
  expect(sh.data[1][7]).toBe('7-11')
  const again = env.g.migrateFoodLog()
  expect(again.textFixes).toEqual({ Items: 0, Logs: 0, Stores: 0, Weights: 0 })
  expect(sh.data[1][4]).toBe('2026-10-10')
  expect(sh.data[1][7]).toBe('7-11')
  expect(env.logs.some((s: string) => String(s).includes('migrateTextColumns_'))).toBe(true)
})

test('整欄格式含 getMaxRows 那一列', () => {
  const env = readyGas()
  const sh = env.sheets.get('Logs')!
  const max = sh.getMaxRows()
  expect(max).toBe(1000)
  expect(sh.formats.get(`${max}:8`)).toBe('@')
})

test('重複 id：同一筆 7-11 append 兩次只有一列', () => {
  const env = readyGas()
  expect(env.call({ action: 'append', table: 'Logs', record: rec711 }).ok).toBe(true)
  const again = env.call({ action: 'append', table: 'Logs', record: rec711 })
  expect(again.duplicate).toBe(true)
  const data = env.call({ action: 'read' })
  const rows = data.logs.filter((r: { id: string }) => r.id === 'l-711')
  expect(rows).toHaveLength(1)
  expect(rows[0].src).toBe('7-11')
})

test('Weights：day 是字串且 @，kg 是 number', () => {
  const env = readyGas()
  const r = env.call({
    action: 'upsertWeight',
    record: { id: 'w-1', day: '2026-10-10', ts: '2026-10-10T13:00:00+08:00', kg: 72.4 },
  })
  expect(r.ok).toBe(true)
  const sh = env.sheets.get('Weights')!
  const row = sh.data[1]
  expect(row[0]).toBe('2026-10-10')
  expect(typeof row[0]).toBe('string')
  expect(sh.formats.get('2:1')).toBe('@')
  expect(typeof row[4]).toBe('number')
  expect(row[4]).toBe(72.4)
})

test('health 第一次自動修正，第二次 textFixes=0', () => {
  const env = readyGas()
  env.sheets.get('Logs')!.appendRow(logRow())
  const first = env.get({})
  expect(first.ok).toBe(true)
  expect(first.migration.version).toBe('1')
  expect(first.migration.textFixes).toBeGreaterThanOrEqual(1)
  expect(env.sheets.get('Logs')!.data[1][7]).toBe('7-11')
  expect(env.sheets.get('Logs')!.data[1][4]).toBe('2026-10-10')
  const second = env.get({})
  expect(second.migration.textFixes).toBe(0)
  expect(second.migration.version).toBe('1')
})

test('並發兩請求不重複修正', () => {
  const env = readyGas()
  env.sheets.get('Logs')!.appendRow(logRow())
  let calls = 0
  const orig = env.g.migrateTextColumns_
  env.g.migrateTextColumns_ = (ss: unknown) => {
    calls += 1
    return orig(ss)
  }
  const a = env.get({})
  const b = env.get({})
  expect(calls).toBe(1)
  expect(a.migration.textFixes).toBeGreaterThanOrEqual(1)
  expect(b.migration.textFixes).toBe(0)
  expect(env.sheets.get('Logs')!.data[1][7]).toBe('7-11')
  const rows = env.sheets.get('Logs')!.data.filter((r) => r[0] === 'l-old')
  expect(rows).toHaveLength(1)
})

test('未 setup 的舊表第一次 POST 也會自動修文字欄', () => {
  const env = loadGas()
  env.props.set('SHARED_SECRET', 's')
  const ss = env.g.SpreadsheetApp.getActiveSpreadsheet()
  const logs = ss.insertSheet('Logs')
  logs.getRange(1, 1, 1, LOG_COLS.length).setValues([LOG_COLS])
  logs.appendRow(logRow())
  ss.insertSheet('Items').getRange(1, 1, 1, 17).setValues([[
    'id', 'ts', 'deleted', 'updated_at', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'fav', 'created_by', 'store',
  ]])
  ss.insertSheet('Stores').getRange(1, 1, 1, 7).setValues([['id', 'ts', 'deleted', 'updated_at', 'name', 'last_eaten_at', 'created_by']])
  ss.insertSheet('Weights').getRange(1, 1, 1, 6).setValues([['day', 'ts', 'deleted', 'updated_at', 'kg', 'id']])
  ss.insertSheet('Config').getRange(1, 1, 1, 3).setValues([['key', 'value', 'updated_at']])
  const r = env.post({ secret: 's', action: 'read' })
  expect(r.ok).toBe(true)
  const hit = r.logs.find((l: { id: string }) => l.id === 'l-old')
  expect(hit.src).toBe('7-11')
  expect(hit.day).toBe('2026-10-10')
  expect(env.sheets.get('Logs')!.data[1][7]).toBe('7-11')
})
