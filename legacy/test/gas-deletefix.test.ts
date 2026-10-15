import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'

const ts = '2026-10-10T12:00:00+08:00'
const log = {
  id: 'l-del', ts, day: '2026-10-10', item_id: 'fm:1', name: '雞胸', src: '全家',
  qty: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}
const item = {
  id: 'u:del', ts, kind: '自建', base_id: '', src: '其他', name: '豆漿',
  serving: '1 份', serving_g: null, kcal: 100, protein: 10, fat: 1, carb: 10,
  fav: false, created_by: 'app', store: '',
}
const store = { id: 's:del', ts, name: '刪除店', created_by: 'app' }
const storeItem = {
  ...item, id: 'u:store-del', name: '店品', store: 's:del',
}

test('App softDelete 不存在的 Logs id 回 ok，不新增列，再刪一次仍 ok', () => {
  const env = readyGas()
  const before = env.call({ action: 'read' })
  const res = env.call({ action: 'softDelete', table: 'Logs', id: 'missing' })
  expect(res.ok).toBe(true)
  expect(res.error).toBeUndefined()
  const mid = env.call({ action: 'read' })
  expect(mid.logs).toHaveLength(before.logs.length)
  expect(mid.logs).toHaveLength(0)
  const again = env.call({ action: 'softDelete', table: 'Logs', id: 'missing' })
  expect(again.ok).toBe(true)
  expect(again.error).toBeUndefined()
})

test('已刪再刪不改 updated_at；店家第二次刪不改連帶品項', () => {
  const env = readyGas()
  expect(env.call({ action: 'append', table: 'Logs', record: log }).ok).toBe(true)
  expect(env.call({ action: 'softDelete', table: 'Logs', id: log.id }).ok).toBe(true)
  const afterLog = env.call({ action: 'read' }).logs.find((r: { id: string }) => r.id === log.id)
  const logUpdated = afterLog.updated_at
  expect(afterLog.deleted).toBe(true)
  expect(env.call({ action: 'softDelete', table: 'Logs', id: log.id }).ok).toBe(true)
  const log2 = env.call({ action: 'read' }).logs.find((r: { id: string }) => r.id === log.id)
  expect(log2.deleted).toBe(true)
  expect(log2.updated_at).toBe(logUpdated)

  expect(env.call({ action: 'upsertItem', record: item }).ok).toBe(true)
  expect(env.call({ action: 'softDelete', table: 'Items', id: item.id }).ok).toBe(true)
  const afterItem = env.call({ action: 'read' }).items.find((r: { id: string }) => r.id === item.id)
  const itemUpdated = afterItem.updated_at
  expect(afterItem.deleted).toBe(true)
  expect(env.call({ action: 'softDelete', table: 'Items', id: item.id }).ok).toBe(true)
  const item2 = env.call({ action: 'read' }).items.find((r: { id: string }) => r.id === item.id)
  expect(item2.deleted).toBe(true)
  expect(item2.updated_at).toBe(itemUpdated)

  expect(env.call({ action: 'upsertStore', record: store }).ok).toBe(true)
  expect(env.call({ action: 'upsertItem', record: storeItem }).ok).toBe(true)
  expect(env.call({ action: 'softDelete', table: 'Stores', id: store.id }).ok).toBe(true)
  const afterStore = env.call({ action: 'read' })
  const storeRow = afterStore.stores.find((r: { id: string }) => r.id === store.id)
  const linked = afterStore.items.find((r: { id: string }) => r.id === storeItem.id)
  expect(storeRow.deleted).toBe(true)
  expect(linked.deleted).toBe(true)
  const storeUpdated = storeRow.updated_at
  const linkedUpdated = linked.updated_at
  expect(env.call({ action: 'softDelete', table: 'Stores', id: store.id }).ok).toBe(true)
  const store2 = env.call({ action: 'read' })
  const storeRow2 = store2.stores.find((r: { id: string }) => r.id === store.id)
  const linked2 = store2.items.find((r: { id: string }) => r.id === storeItem.id)
  expect(storeRow2.deleted).toBe(true)
  expect(storeRow2.updated_at).toBe(storeUpdated)
  expect(linked2.deleted).toBe(true)
  expect(linked2.updated_at).toBe(linkedUpdated)
})

test('Kyujin 刪不到的 Logs 仍 forbidden；刪自己的 Log 成功', () => {
  const env = readyGas()
  const k = (body: object) => env.call({ client: 'kyujin', ...body })
  expect(k({ action: 'softDelete', table: 'Logs', id: 'missing' }).error).toBe('forbidden')
  env.call({ action: 'append', table: 'Logs', record: { ...log, id: 'l-app' } })
  expect(k({ action: 'softDelete', table: 'Logs', id: 'l-app' }).error).toBe('forbidden')
  expect(k({
    action: 'append', table: 'Logs', record: {
      id: 'l-kyu', ts, day: '2026-10-10', item_id: '', name: '估的', src: '其他',
      qty: 1, kcal: 1, protein: 1, fat: 1, carb: 1, source: 'kyujin',
    },
  }).ok).toBe(true)
  expect(k({ action: 'softDelete', table: 'Logs', id: 'l-kyu' }).ok).toBe(true)
})

test('softDelete 未知 table 仍是 bad_table', () => {
  const env = readyGas()
  expect(env.call({ action: 'softDelete', table: 'Nope', id: 'x' }).error).toBe('bad_table')
})
