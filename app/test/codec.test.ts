import { expect, test } from 'vitest'
import { decodeItem, decodeLog, decodeWeight, encodeBool, itemToRow, logToRow, rowToLog, rowToWeight, weightToRow, ITEM_COLS, LOG_COLS, WEIGHT_COLS } from '@/data/codec'
import type { ItemRecord, LogRecord, WeightRecord } from '@/types'

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
  }
  expect(rowToLog(logToRow(l)).protein).toBe(31.2)
  expect(rowToLog(logToRow(l)).grams).toBeNull()
})

test('Items 欄位順序固定', () => {
  expect(ITEM_COLS).toEqual(['id', 'ts', 'deleted', 'updated_at', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'fav', 'created_by'])
  const it: ItemRecord = {
    id: 'u:1', ts: '', deleted: false, updated_at: '', kind: '自建', base_id: '', src: '其他', name: '乳清', serving: '1 匙',
    serving_g: 30, kcal: 120, protein: 24, fat: 1, carb: 2, fav: false, created_by: 'kyujin',
  }
  expect(itemToRow(it)[15]).toBe('kyujin')
})
