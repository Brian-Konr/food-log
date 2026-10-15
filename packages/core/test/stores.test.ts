// 由 legacy/test/gas-stores.test.ts 搬來。連帶刪除／復原改用 items.cascade_of（取代相同 updated_at 的比對）。
import { expect, test } from 'vitest'
import { itemArgs, logArgs, noonOf, storeArgs, TEST_YESTERDAY } from '../src/testing'
import { errorOf, expectErr, expectOk, live, newServer, row } from './helpers'

const store = storeArgs({ id: 's:1', name: '阿財牛肉麵' })
const beefItem = itemArgs({ id: 'u:beef', name: '牛肉麵', serving: '1 份', serving_g: null, kcal: 520, protein: 28, fat: 18, carb: 62, store_id: 's:1' })

test('重複店名（含標點／空白）回 duplicate_name 並附 existingId、existingName；已刪除的名字可以再用', async () => {
  const s = newServer()
  expectOk(await s.mutate('stores.upsert@1', store))
  const dup = errorOf(await s.mutate('stores.upsert@1', storeArgs({ id: 's:2', name: ' 阿財・牛肉麵 ' })))
  expect(dup.error).toBe('duplicate_name')
  expect(dup.details).toEqual({ existingId: 's:1', existingName: '阿財牛肉麵' })
  expectOk(await s.mutate('stores.delete@1', { id: 's:1' }))
  expectOk(await s.mutate('stores.upsert@1', storeArgs({ id: 's:3', name: '阿財牛肉麵' })))
  expect(row(s, 'stores', 's:3').name_norm).toBe('阿財牛肉麵')
})

test('自己改名不算重複；存 name_norm、name 去頭尾空白', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', store)
  expectOk(await s.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '  阿財・牛肉麵 ' })))
  const r = row(s, 'stores', 's:1')
  expect(r.name).toBe('阿財・牛肉麵')
  expect(r.name_norm).toBe('阿財牛肉麵')
})

test('id 必須是 s: 開頭、店名不能空白', async () => {
  const s = newServer()
  expectErr(await s.mutate('stores.upsert@1', storeArgs({ id: 'x:1' })), 'bad_record')
  expectErr(await s.mutate('stores.upsert@1', storeArgs({ name: '   ' })), 'bad_record')
  expectErr(await s.mutate('stores.upsert@1', storeArgs({ id: '' })), 'bad_record')
})

test('軟刪店家連帶品項（標 cascade_of）；restore 只還原 cascade_of 相同的品項；Logs 不動', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', store)
  await s.mutate('items.upsert@1', beefItem)
  await s.mutate('items.upsert@1', { ...beefItem, id: 'u:old', name: '早刪的' })
  await s.mutate('items.delete@1', { id: 'u:old' })
  await s.mutate('logs.add@1', { log: logArgs({ id: 'l1', item_id: 'u:beef', name: '牛肉麵', src: '其他', kcal: 520, protein: 28, fat: 18, carb: 62, store_id: 's:1' }) })
  const logBefore = structuredClone(row(s, 'logs', 'l1'))

  expectOk(await s.mutate('stores.delete@1', { id: 's:1' }))
  expect(row(s, 'stores', 's:1').deleted_at).not.toBeNull()
  expect(row(s, 'items', 'u:beef').deleted_at).not.toBeNull()
  expect(row(s, 'items', 'u:beef').cascade_of).toBe('s:1')
  expect(row(s, 'items', 'u:old').deleted_at).not.toBeNull()
  expect(row(s, 'items', 'u:old').cascade_of).toBeNull() // 早就刪掉的不標記
  expect(row(s, 'logs', 'l1')).toEqual(logBefore)

  expectOk(await s.mutate('stores.restore@1', { id: 's:1' }))
  expect(row(s, 'stores', 's:1').deleted_at).toBeNull()
  expect(row(s, 'items', 'u:beef').deleted_at).toBeNull()
  expect(row(s, 'items', 'u:beef').cascade_of).toBeNull()
  expect(row(s, 'items', 'u:old').deleted_at).not.toBeNull()
  expect(row(s, 'logs', 'l1').kcal).toBe(520)
})

test('連帶還原不靠時間戳：同一毫秒刪除也不會誤還原早刪的品項', async () => {
  const s = newServer() // 固定時鐘：所有 updated_at 相同
  await s.mutate('stores.upsert@1', store)
  await s.mutate('items.upsert@1', { ...beefItem, id: 'u:a' })
  await s.mutate('items.upsert@1', { ...beefItem, id: 'u:b' })
  await s.mutate('items.delete@1', { id: 'u:b' })
  await s.mutate('stores.delete@1', { id: 's:1' })
  await s.mutate('stores.restore@1', { id: 's:1' })
  expect(row(s, 'items', 'u:a').deleted_at).toBeNull()
  expect(row(s, 'items', 'u:b').deleted_at).not.toBeNull()
})

test('復原店家若店名已被別家未刪除的店用掉 → duplicate_name（部分唯一索引的前置檢查）', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', store)
  await s.mutate('stores.delete@1', { id: 's:1' })
  await s.mutate('stores.upsert@1', storeArgs({ id: 's:2', name: '阿財牛肉麵' }))
  const res = errorOf(await s.mutate('stores.restore@1', { id: 's:1' }))
  expect(res.error).toBe('duplicate_name')
  expect(res.details).toEqual({ existingId: 's:2', existingName: '阿財牛肉麵' })
  expect(row(s, 'stores', 's:1').deleted_at).not.toBeNull()
})

test('last_eaten_at 取較新的 ts；往回補記不把時間撥回', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', store)
  const add = (id: string, hhmm: string) =>
    s.mutate('logs.add@1', { log: logArgs({ id, ts: noonOf('2026-10-10', hhmm), day: '2026-10-10', item_id: 'x', name: 'x', src: '其他', kcal: 1, protein: 1, fat: 1, carb: 1, store_id: 's:1' }) })
  await add('l1', '12:00')
  expect(row(s, 'stores', 's:1').last_eaten_at).toBe('2026-10-10T12:00:00+08:00')
  await add('l0', '08:00')
  expect(row(s, 'stores', 's:1').last_eaten_at).toBe('2026-10-10T12:00:00+08:00')
  await add('l2', '18:00')
  expect(row(s, 'stores', 's:1').last_eaten_at).toBe('2026-10-10T18:00:00+08:00')
})

test('改 items.upsert 的 kcal 之後，已記錄的 Logs 那一列逐欄相等（紀錄存的是當下的數字）', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', store)
  await s.mutate('items.upsert@1', beefItem)
  await s.mutate('logs.add@1', { log: logArgs({ id: 'l1', item_id: 'u:beef', name: '牛肉麵', src: '其他', kcal: 520, protein: 28, fat: 18, carb: 62, store_id: 's:1' }) })
  const before = JSON.stringify(row(s, 'logs', 'l1'))
  expectOk(await s.mutate('items.upsert@1', { ...beefItem, kcal: 600 }))
  expect(JSON.stringify(row(s, 'logs', 'l1'))).toBe(before)
  expect(row(s, 'items', 'u:beef').kcal).toBe(600)
})

test('last_eaten_at 不是 stores.upsert 的參數（傳了也被忽略）；改名保留 last_eaten_at', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', { ...store, last_eaten_at: '2099-01-01T00:00:00+08:00' } as never)
  expect(row(s, 'stores', 's:1').last_eaten_at).toBeNull()
  await s.mutate('logs.add@1', { log: logArgs({ id: 'l1', store_id: 's:1', ts: noonOf(TEST_YESTERDAY, '19:00') }) })
  await s.mutate('stores.upsert@1', { ...store, name: '阿財麵館' })
  expect(row(s, 'stores', 's:1').last_eaten_at).toBe(noonOf(TEST_YESTERDAY, '19:00'))
  expect(live(s, 'stores')).toHaveLength(1)
})
