// 由 legacy/test/gas-kyujin.test.ts 搬來（讀取類的 read／summary／trends／history 屬於 Bot API，這裡只測 mutation）。
// 差異：v2 的 created_by 依 actor 決定，不再是參數，所以「Kyujin 建店帶 created_by:'app'」這個案例不存在。
import { expect, test } from 'vitest'
import { itemArgs, logArgs, noonOf, quickLogArgs, storeArgs, TEST_YESTERDAY, weightArgs } from '../src/testing'
import { expectErr, expectOk, live, newServer, row } from './helpers'

const kitem = itemArgs({ id: 'u:kyu-1' })

test('Kyujin 寫 Logs（非 kyujin source）、ov:、官方 id、config.set、改 app 的 u: 全部 forbidden', async () => {
  const s = newServer()
  const k = s.asKyujin.bind(s)
  expectErr(await k('logs.add@1', { log: logArgs({ id: 'l' }) }), 'forbidden')
  expectErr(await k('logs.update@1', { id: 'l', patch: { qty: 2 } }), 'forbidden')
  expectErr(await k('logs.delete@1', { id: 'l' }), 'forbidden')
  expectErr(await k('items.upsert@1', itemArgs({ id: 'ov:fm:1', kind: '補填', base_id: 'fm:1' })), 'forbidden')
  expectErr(await k('items.upsert@1', itemArgs({ id: 'fm:1' })), 'forbidden')
  expectErr(await k('items.upsert@1', itemArgs({ id: '711:abc' })), 'forbidden')
  expectErr(await k('config.set@1', { key: 'tdee', value: '2000' }), 'forbidden')
  expectOk(await s.mutate('items.upsert@1', itemArgs({ id: 'u:app' })))
  expectErr(await k('items.upsert@1', itemArgs({ id: 'u:app', name: '被改' })), 'forbidden')
  expect(row(s, 'items', 'u:app').name).toBe('乳清')
})

test('Kyujin 寫 u: 成功且 created_by=kyujin，第二次 upsert 是更新、created_by 不變', async () => {
  const s = newServer()
  expectOk(await s.asKyujin('items.upsert@1', kitem))
  expectOk(await s.asKyujin('items.upsert@1', { ...kitem, name: '乳清蛋白' }))
  const items = live(s, 'items').filter((r) => r.id === 'u:kyu-1')
  expect(items).toHaveLength(1)
  expect(items[0]!.name).toBe('乳清蛋白')
  expect(items[0]!.created_by).toBe('kyujin')
  // owner 也可以改 Kyujin 建的品項，created_by 仍是 kyujin
  expectOk(await s.mutate('items.upsert@1', { ...kitem, name: 'owner 改名' }))
  expect(row(s, 'items', 'u:kyu-1').created_by).toBe('kyujin')
  expectOk(await s.asKyujin('weights.upsert@1', weightArgs({ id: 'w1', day: '2026-10-10', kg: 72.4, ts: noonOf('2026-10-10', '08:00') })))
})

test('Kyujin 可以建店、改 App 店名、寫店家品項與 kyujin Logs；不能刪店或動 app/quick Logs', async () => {
  const s = newServer()
  const k = s.asKyujin.bind(s)
  expectOk(await k('stores.upsert@1', storeArgs({ id: 's:k', name: 'K店' })))
  expect(row(s, 'stores', 's:k').created_by).toBe('kyujin')
  await s.mutate('stores.upsert@1', storeArgs({ id: 's:app', name: '阿財' }))
  expectOk(await k('stores.upsert@1', storeArgs({ id: 's:app', name: '阿財麵' })))
  expect(row(s, 'stores', 's:app').created_by).toBe('app') // 改名保留原本的 created_by
  expect(row(s, 'stores', 's:app').name).toBe('阿財麵')
  expectErr(await k('stores.delete@1', { id: 's:app' }), 'forbidden')
  expectErr(await k('stores.restore@1', { id: 'nope' }), 'forbidden')

  await s.mutate('items.upsert@1', itemArgs({ id: 'u:app-store', name: '麵', serving: '1 份', serving_g: null, store_id: 's:app', kcal: 100, protein: 10 }))
  expectOk(await k('items.upsert@1', itemArgs({ id: 'u:app-store', name: '麵加大', serving: '1 份', serving_g: null, store_id: 's:app', kcal: 150, protein: 12 })))
  expect(row(s, 'items', 'u:app-store').name).toBe('麵加大')
  expect(row(s, 'items', 'u:app-store').created_by).toBe('app')

  expectOk(await k('logs.add@1', { log: logArgs({ id: 'lk', item_id: '', name: '估的', src: '其他', qty: 1, grams: null, kcal: 250, protein: 20, fat: 8, carb: 15, source: 'kyujin' }) }))
  expect(row(s, 'logs', 'lk').source).toBe('kyujin')
  expectErr(await k('logs.add@1', { log: logArgs({ id: 'lk2', item_id: '', name: 'x', src: '其他', kcal: 1, protein: 1, fat: 1, carb: 1 }) }), 'forbidden')
  expectErr(await k('logs.add@1', { log: logArgs({ id: 'lk3', item_id: '', name: 'x', src: '其他', kcal: 1, protein: 1, fat: 1, carb: 1, source: 'app' }) }), 'forbidden')

  await s.mutate('logs.add@1', { log: logArgs({ id: 'la', item_id: 'u:1', name: 'app', src: '其他', kcal: 10, protein: 1, fat: 1, carb: 1 }) })
  expectErr(await k('logs.update@1', { id: 'la', patch: { kcal: 99 } }), 'forbidden')
  expectErr(await k('logs.delete@1', { id: 'la' }), 'forbidden')
  expectErr(await k('logs.restore@1', { id: 'la' }), 'forbidden')
  expectOk(await k('logs.update@1', { id: 'lk', patch: { kcal: 260 } }))
  expectErr(await k('logs.update@1', { id: 'lk', patch: { source: 'app' } }), 'bad_record')
  expectOk(await k('logs.delete@1', { id: 'lk' }))
  expectOk(await k('logs.restore@1', { id: 'lk' }))
  expect(row(s, 'logs', 'lk').kcal).toBe(260)
})

test('Kyujin 不能動 quick 的 log；owner 的 quick log 對 Kyujin 也是 forbidden', async () => {
  const s = newServer()
  await s.mutate('logs.add@1', { log: quickLogArgs({ id: 'qq' }) })
  expectErr(await s.asKyujin('logs.update@1', { id: 'qq', patch: { kcal: 1 } }), 'forbidden')
  expectErr(await s.asKyujin('logs.delete@1', { id: 'qq' }), 'forbidden')
})

test('Kyujin 沒有店家的 u: 品項：新建 ok；店家品項不受限；既有 app 建的店家品項可以改', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', storeArgs({ id: 's:1' }))
  expectOk(await s.asKyujin('items.upsert@1', itemArgs({ id: 'u:k-store', store_id: 's:1' })))
  expect(row(s, 'items', 'u:k-store').store_id).toBe('s:1')
  // 之後即使參數沒帶 store_id，也沿用既有的店家（Code.gs 的 storeId || existStore）
  expectOk(await s.asKyujin('items.upsert@1', itemArgs({ id: 'u:k-store', name: '改名', store_id: null })))
  expect(row(s, 'items', 'u:k-store').store_id).toBe('s:1')
  expect(row(s, 'items', 'u:k-store').name).toBe('改名')
})

test('Kyujin 的 log 寫入昨天、不能寫未來；fixture 日期常數', async () => {
  const s = newServer()
  const day = TEST_YESTERDAY
  expectOk(await s.asKyujin('logs.add@1', { log: logArgs({ id: 'k1', item_id: '', name: 'x', src: '其他', day, ts: noonOf(day), source: 'kyujin' }) }))
  expectErr(await s.asKyujin('logs.add@1', { log: logArgs({ id: 'k2', item_id: '', name: 'x', src: '其他', day: '2026-10-13', ts: noonOf('2026-10-13'), source: 'kyujin' }) }), 'bad_record')
})
