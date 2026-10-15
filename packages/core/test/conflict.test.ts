// 由 legacy/test/gas-conflict.test.ts 搬來：刪除後 update／items.upsert／stores.upsert 回 ignored:deleted 且列不變。
import { expect, test } from 'vitest'
import { itemArgs, logArgs, storeArgs } from '../src/testing'
import { expectErr, expectOk, newServer, row } from './helpers'

test('刪除後 logs.update／items.upsert／stores.upsert 回 ignored:deleted 且列不變', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '店' }))
  await s.mutate('items.upsert@1', itemArgs({ id: 'u:1', name: '麵', serving: '1 份', serving_g: null, kcal: 100, protein: 1, fat: 1, carb: 1 }))
  await s.mutate('logs.add@1', { log: logArgs({ id: 'l1', item_id: 'u:1', name: '麵', src: '其他', kcal: 100, protein: 1, fat: 1, carb: 1 }) })
  await s.mutate('logs.delete@1', { id: 'l1' })
  await s.mutate('items.delete@1', { id: 'u:1' })
  await s.mutate('stores.delete@1', { id: 's:1' })
  const before = {
    log: JSON.stringify(row(s, 'logs', 'l1')),
    item: JSON.stringify(row(s, 'items', 'u:1')),
    store: JSON.stringify(row(s, 'stores', 's:1')),
  }
  const version = s.db.version
  expect(expectOk(await s.mutate('logs.update@1', { id: 'l1', patch: { qty: 2, kcal: 200 } }))).toEqual({ ignored: 'deleted' })
  expect(expectOk(await s.mutate('items.upsert@1', itemArgs({ id: 'u:1', name: '改', kcal: 9, serving: '1 份', serving_g: null })))).toEqual({ ignored: 'deleted' })
  expect(expectOk(await s.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '改名' })))).toEqual({ ignored: 'deleted' })
  expect(JSON.stringify(row(s, 'logs', 'l1'))).toBe(before.log)
  expect(JSON.stringify(row(s, 'items', 'u:1'))).toBe(before.item)
  expect(JSON.stringify(row(s, 'stores', 's:1'))).toBe(before.store)
  expect(s.db.version).toBe(version) // ignored 不產生寫入
})

test('logs.update：找不到 → not_found；Kyujin 的檢查順序是 forbidden → not_found → ignored', async () => {
  const s = newServer()
  expectErr(await s.mutate('logs.update@1', { id: 'nope', patch: { qty: 1 } }), 'not_found')
  expectErr(await s.asKyujin('logs.update@1', { id: 'nope', patch: { qty: 1 } }), 'forbidden')
})
