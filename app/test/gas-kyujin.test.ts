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
