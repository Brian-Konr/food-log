import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'

const item = {
  id: 'u:kyu-1', ts: '2026-10-10T12:00:00+08:00', kind: '自建', base_id: '', src: '其他', name: '乳清', serving: '1 匙',
  serving_g: 30, kcal: 120, protein: 24, fat: 1, carb: 2, fav: false, created_by: 'kyujin',
}

test('Kyujin 寫 Logs、ov:、官方 id、setConfig、改 app 的 u: 全部 forbidden', () => {
  const env = readyGas()
  const k = (body: object) => env.call({ client: 'kyujin', ...body })
  expect(k({ action: 'append', table: 'Logs', record: { id: 'l', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: 'x', name: 'x', src: '全家', qty: 1, kcal: 1, protein: 1, fat: 1, carb: 1 } }).error).toBe('forbidden')
  expect(k({ action: 'update', table: 'Logs', id: 'l', patch: { qty: 2 } }).error).toBe('forbidden')
  expect(k({ action: 'softDelete', table: 'Logs', id: 'l' }).error).toBe('forbidden')
  expect(k({ action: 'upsertItem', record: { ...item, id: 'ov:fm:1', kind: '補填', base_id: 'fm:1', created_by: 'app' } }).error).toBe('forbidden')
  expect(k({ action: 'upsertItem', record: { ...item, id: 'fm:1' } }).error).toBe('forbidden')
  expect(k({ action: 'upsertItem', record: { ...item, id: '711:abc' } }).error).toBe('forbidden')
  expect(k({ action: 'setConfig', key: 'tdee', value: '2000' }).error).toBe('forbidden')
  env.call({ action: 'upsertItem', record: { ...item, id: 'u:app', created_by: 'app' } })
  expect(k({ action: 'upsertItem', record: { ...item, id: 'u:app', created_by: 'kyujin' } }).error).toBe('forbidden')
})

test('Kyujin 寫 u: 成功，第二次 upsert 是更新；體重、read/summary/trends/history 成功', () => {
  const env = readyGas()
  const k = (body: object) => env.call({ client: 'kyujin', ...body })
  expect(k({ action: 'upsertItem', record: item }).ok).toBe(true)
  expect(k({ action: 'upsertItem', record: { ...item, name: '乳清蛋白' } }).ok).toBe(true)
  const items = env.call({ action: 'read' }).items.filter((r: { id: string }) => r.id === 'u:kyu-1')
  expect(items).toHaveLength(1)
  expect(items[0].name).toBe('乳清蛋白')
  expect(k({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.4, id: 'w1', ts: '2026-10-10T08:00:00+08:00' } }).ok).toBe(true)
  expect(k({ action: 'read' }).ok).toBe(true)
  expect(k({ action: 'summary', day: '2026-10-10' }).ok).toBe(true)
  expect(k({ action: 'trends', weekStart: '2026-10-05' }).ok).toBe(true)
  expect(k({ action: 'history', table: 'Logs', before: '2026-10-10' }).ok).toBe(true)
})

test('Kyujin 可以建店、改 App 店名、寫店家品項與 kyujin Logs；不能刪店或動 app/quick Logs', () => {
  const env = readyGas()
  const k = (body: object) => env.call({ client: 'kyujin', ...body })
  expect(k({ action: 'upsertStore', record: { id: 's:k', name: 'K店', ts: '2026-10-10T12:00:00+08:00', created_by: 'kyujin' } }).ok).toBe(true)
  expect(k({ action: 'upsertStore', record: { id: 's:k2', name: 'App店', ts: '2026-10-10T12:00:00+08:00', created_by: 'app' } }).error).toBe('forbidden')
  env.call({ action: 'upsertStore', record: { id: 's:app', name: '阿財', ts: '2026-10-10T12:00:00+08:00' } })
  expect(k({ action: 'upsertStore', record: { id: 's:app', name: '阿財麵', ts: '2026-10-10T12:00:00+08:00' } }).ok).toBe(true)
  expect(env.call({ action: 'read' }).stores.find((s: { id: string }) => s.id === 's:app').created_by).toBe('app')
  expect(k({ action: 'softDelete', table: 'Stores', id: 's:app' }).error).toBe('forbidden')
  expect(k({ action: 'restore', table: 'Stores', id: 'nope' }).error).toBe('forbidden')
  env.call({ action: 'upsertItem', record: {
    id: 'u:app-store', ts: '2026-10-10T12:00:00+08:00', kind: '自建', base_id: '', src: '其他', name: '麵', serving: '1 份',
    serving_g: null, kcal: 100, protein: 10, fat: 1, carb: 2, fav: false, created_by: 'app', store: 's:app',
  }})
  expect(k({ action: 'upsertItem', record: {
    id: 'u:app-store', ts: '2026-10-10T12:00:00+08:00', kind: '自建', base_id: '', src: '其他', name: '麵加大', serving: '1 份',
    serving_g: null, kcal: 150, protein: 12, fat: 2, carb: 3, fav: false, created_by: 'kyujin', store: 's:app',
  } }).ok).toBe(true)
  expect(k({ action: 'append', table: 'Logs', record: {
    id: 'lk', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: '', name: '估的', src: '其他',
    qty: 1, kcal: 250, protein: 20, fat: 8, carb: 15, source: 'kyujin',
  } }).ok).toBe(true)
  const sum = env.call({ action: 'summary', day: '2026-10-10' })
  expect(sum.totals.kcal).toBe(250)
  expect(k({ action: 'append', table: 'Logs', record: {
    id: 'lk2', ts: '2026-10-10T13:00:00+08:00', day: '2026-10-10', item_id: '', name: 'x', src: '其他',
    qty: 1, kcal: 1, protein: 1, fat: 1, carb: 1,
  } }).error).toBe('forbidden')
  expect(k({ action: 'append', table: 'Logs', record: {
    id: 'lk3', ts: '2026-10-10T13:00:00+08:00', day: '2026-10-10', item_id: '', name: 'x', src: '其他',
    qty: 1, kcal: 1, protein: 1, fat: 1, carb: 1, source: 'app',
  } }).error).toBe('forbidden')
  env.call({ action: 'append', table: 'Logs', record: {
    id: 'la', ts: '2026-10-10T14:00:00+08:00', day: '2026-10-10', item_id: 'u:1', name: 'app', src: '其他',
    qty: 1, kcal: 10, protein: 1, fat: 1, carb: 1,
  }})
  expect(k({ action: 'update', table: 'Logs', id: 'la', patch: { kcal: 99 } }).error).toBe('forbidden')
  expect(k({ action: 'softDelete', table: 'Logs', id: 'la' }).error).toBe('forbidden')
  expect(k({ action: 'update', table: 'Logs', id: 'lk', patch: { kcal: 260 } }).ok).toBe(true)
  expect(k({ action: 'update', table: 'Logs', id: 'lk', patch: { source: 'app' } }).error).toBe('bad_record')
  expect(k({ action: 'softDelete', table: 'Logs', id: 'lk' }).ok).toBe(true)
  expect(k({ action: 'restore', table: 'Logs', id: 'lk' }).ok).toBe(true)
})
