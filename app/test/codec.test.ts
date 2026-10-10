import { expect, test } from 'vitest'
import { decodeItem, decodeLog, decodeSnapshot, decodeStore, encodeBool, itemToRow, logToRow, rowToLog, rowToStore, rowToWeight, storeToRow, weightToRow, ITEM_COLS, LOG_COLS, STORE_COLS, WEIGHT_COLS } from '@/data/codec'
import type { ItemRecord, LogRecord, StoreRecord, WeightRecord } from '@/types'

test('TRUE/FALSE 與空營養素', () => {
  expect(encodeBool(true)).toBe('TRUE')
  expect(encodeBool(false)).toBe('FALSE')
  const item = decodeItem({ id: 'u:1', deleted: 'FALSE', fav: 'TRUE', serving_g: '', kcal: 10, protein: 1, fat: 0, carb: 2, created_by: 'app', kind: '自建', src: '其他', name: 'x', serving: '1 份' })
  expect(item.deleted).toBe(false)
  expect(item.fav).toBe(true)
  expect(item.serving_g).toBeNull()
})

test('Weights 欄位順序 day, ts, deleted, updated_at, kg, id', () => {
  expect(WEIGHT_COLS).toEqual(['day', 'ts', 'deleted', 'updated_at', 'kg', 'id'])
  const w: WeightRecord = { day: '2026-10-10', ts: '2026-10-10T08:00:00+08:00', deleted: false, updated_at: '2026-10-10T08:00:00+08:00', kg: 72.4, id: 'w1' }
  expect(weightToRow(w)[0]).toBe('2026-10-10')
  expect(weightToRow(w)[5]).toBe('w1')
  expect(rowToWeight(weightToRow(w)).kg).toBe(72.4)
})

test('Logs round-trip', () => {
  expect(LOG_COLS[0]).toBe('id')
  const l: LogRecord = {
    id: 'l1', ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: 'x', day: '2026-10-10',
    item_id: 'fm:1', name: '雞胸', src: '全家', qty: 1.5, grams: null, kcal: 159, protein: 31.2, fat: 2.3, carb: 3.5,
    source: 'app', store: '',
  }
  expect(rowToLog(logToRow(l)).protein).toBe(31.2)
  expect(rowToLog(logToRow(l)).grams).toBeNull()
  expect(rowToLog(logToRow(l)).source).toBe('app')
})

test('Items 欄位順序固定', () => {
  expect(ITEM_COLS).toEqual(['id', 'ts', 'deleted', 'updated_at', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'fav', 'created_by', 'store'])
  const it: ItemRecord = {
    id: 'u:1', ts: '', deleted: false, updated_at: '', kind: '自建', base_id: '', src: '其他', name: '乳清', serving: '1 匙',
    serving_g: 30, kcal: 120, protein: 24, fat: 1, carb: 2, fav: false, created_by: 'kyujin', store: '',
  }
  expect(itemToRow(it)[15]).toBe('kyujin')
  expect(itemToRow(it)[16]).toBe('')
})

test('舊 Log 沒有 source 解成 app；沒有 store 解成空字串', () => {
  const l = decodeLog({ id: 'l1', ts: '2026-10-10T12:00:00+08:00', deleted: 'FALSE', day: '2026-10-10', item_id: 'fm:1', name: '雞胸', src: '全家', qty: 1, kcal: 100, protein: 1, fat: 1, carb: 1 })
  expect(l.source).toBe('app')
  expect(l.store).toBe('')
})

test('沒有 stores 的 snapshot 解成空陣列', () => {
  const s = decodeSnapshot({ version: 1, serverTime: 'x', config: {}, items: [], logs: [], weights: [] })
  expect(s.stores).toEqual([])
})

test('Stores 欄位往返', () => {
  expect(STORE_COLS).toEqual(['id', 'ts', 'deleted', 'updated_at', 'name', 'last_eaten_at', 'created_by'])
  const st: StoreRecord = { id: 's:1', ts: 't', deleted: false, updated_at: 'u', name: '阿財', last_eaten_at: 'x', created_by: 'app' }
  expect(rowToStore(storeToRow(st)).name).toBe('阿財')
  expect(decodeStore({ id: 's:1', name: 'x' }).created_by).toBe('app')
})
