import { expect, test } from 'vitest'
import { loadGas, readyGas } from './gas-fakes'

const OLD_ITEMS = ['id', 'ts', 'deleted', 'updated_at', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'fav', 'created_by']
const OLD_LOGS = ['id', 'ts', 'deleted', 'updated_at', 'day', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb']
const OLD_WEIGHTS = ['day', 'ts', 'deleted', 'updated_at', 'kg', 'id']
const OLD_CONFIG = ['key', 'value', 'updated_at']

function configValue(env: ReturnType<typeof loadGas>, key: string) {
  const rows = env.sheets.get('Config')?.data.slice(1) ?? []
  const hit = rows.find((r) => String(r[0]) === key)
  return hit == null ? undefined : String(hit[1])
}

function seedOld(env: ReturnType<typeof loadGas>) {
  const ss = env.g.SpreadsheetApp.getActiveSpreadsheet()
  const items = ss.insertSheet('Items')
  items.getRange(1, 1, 1, OLD_ITEMS.length).setValues([OLD_ITEMS])
  items.appendRow(['u:1', '2026-10-09T12:00:00+08:00', false, 't', '自建', '', '其他', '乳清', '1 匙', 30, 120, 24, 1, 2, false, 'app'])
  const logs = ss.insertSheet('Logs')
  logs.getRange(1, 1, 1, OLD_LOGS.length).setValues([OLD_LOGS])
  logs.appendRow(['l1', '2026-10-09T12:00:00+08:00', false, 't', '2026-10-09', 'u:1', '乳清', '其他', 1, '', 120, 24, 1, 2])
  const weights = ss.insertSheet('Weights')
  weights.getRange(1, 1, 1, OLD_WEIGHTS.length).setValues([OLD_WEIGHTS])
  weights.appendRow(['2026-10-09', '2026-10-09T08:00:00+08:00', false, 't', 72.4, 'w1'])
  const cfg = ss.insertSheet('Config')
  cfg.getRange(1, 1, 1, OLD_CONFIG.length).setValues([OLD_CONFIG])
  cfg.appendRow(['target_kcal', '1800', 't'])
  return { items, logs }
}

test('migrateFoodLog 補 Stores 與新欄，舊儲存格不動；再跑一次是空陣列', () => {
  const env = loadGas()
  const { items, logs } = seedOld(env)
  const beforeItems = items.getDataRange().getValues()
  const beforeLogs = logs.getDataRange().getValues()
  const report = env.g.migrateFoodLog()
  expect(report.created).toContain('Stores')
  expect(report.addedColumns.Items).toEqual(['store'])
  expect(report.addedColumns.Logs).toEqual(['source', 'store'])
  const afterItems = items.getDataRange().getValues()
  const afterLogs = logs.getDataRange().getValues()
  expect(afterItems[0].slice(0, OLD_ITEMS.length)).toEqual(OLD_ITEMS)
  expect(afterItems[1].slice(0, OLD_ITEMS.length)).toEqual(beforeItems[1])
  expect(afterLogs[0].slice(0, OLD_LOGS.length)).toEqual(OLD_LOGS)
  expect(afterLogs[1].slice(0, OLD_LOGS.length)).toEqual(beforeLogs[1])
  const again = env.g.migrateFoodLog()
  expect(again.created).toEqual([])
  expect(again.addedColumns.Items).toEqual([])
  expect(again.addedColumns.Logs).toEqual([])
  expect(again.addedColumns.Stores).toEqual([])
  expect(items.getDataRange().getValues()[1].slice(0, OLD_ITEMS.length)).toEqual(beforeItems[1])
  expect(configValue(env, 'schema_version')).toBe(String(env.g.SCHEMA_VERSION))
})

test('readyGas 新裝：Stores 存在，Items 最後一欄 store，Logs 最後兩欄 source、store', () => {
  const env = readyGas()
  expect(env.sheets.has('Stores')).toBe(true)
  const ih = env.sheets.get('Items')!.data[0]
  const lh = env.sheets.get('Logs')!.data[0]
  expect(ih[ih.length - 1]).toBe('store')
  expect(lh.slice(-2)).toEqual(['source', 'store'])
})

test('舊 schema 直接 read 會自動 migrate 並成功；第二次請求不重跑；密鑰錯仍是 unauthorized', () => {
  const env = loadGas()
  env.props.set('SHARED_SECRET', 's')
  const { items } = seedOld(env)
  const beforeItems = items.getDataRange().getValues()
  expect(env.post({ secret: 'wrong', action: 'read' }).error).toBe('unauthorized')
  expect(env.sheets.has('Stores')).toBe(false)
  const r = env.post({ secret: 's', action: 'read' })
  expect(r.ok).toBe(true)
  expect(r.error).toBeUndefined()
  expect(r.stores ?? []).toEqual([])
  expect(env.sheets.has('Stores')).toBe(true)
  expect(configValue(env, 'schema_version')).toBe(String(env.g.SCHEMA_VERSION))
  expect(items.getDataRange().getValues()[0].slice(-1)).toEqual(['store'])
  expect(items.getDataRange().getValues()[1].slice(0, OLD_ITEMS.length)).toEqual(beforeItems[1])
  let calls = 0
  const orig = env.g.ensureFoodLogSheets_
  env.g.ensureFoodLogSheets_ = (ss: unknown) => { calls++; return orig(ss) }
  expect(env.post({ secret: 's', action: 'read' }).ok).toBe(true)
  expect(calls).toBe(0)
  expect(env.g.migrateFoodLog().created).toEqual([])
})

test('自動 migrate 拿不到鎖時回 busy，不會 schema_outdated', () => {
  const env = loadGas({ lockBusy: true })
  env.props.set('SHARED_SECRET', 's')
  seedOld(env)
  expect(env.post({ secret: 's', action: 'read' }).error).toBe('busy')
})
