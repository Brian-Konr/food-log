import { expect, test } from 'vitest'
import { itemArgs, logArgs, storeArgs } from '../src/testing'
import { expectErr, expectOk, newServer, row } from './helpers'

const ov = (over: object = {}) =>
  itemArgs({ id: 'ov:fm:1', kind: '補填', base_id: 'fm:1', src: '全家', name: '雞胸', serving: '1 包', serving_g: 100, ...over })

test('官方 id（fm:／711:）→ forbidden，owner 也一樣', async () => {
  const s = newServer()
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: 'fm:1' })), 'forbidden')
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: '711:x' })), 'forbidden')
})

test('id 前綴不對、缺 id → bad_record', async () => {
  const s = newServer()
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: 'x:1' })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: '' })), 'bad_record')
})

test('ov:：owner 可以，kind 必須是補填、base_id 必須等於 id.slice(3)，created_by 是 app', async () => {
  const s = newServer()
  expectOk(await s.mutate('items.upsert@1', ov()))
  expect(row(s, 'items', 'ov:fm:1').created_by).toBe('app')
  expect(row(s, 'items', 'ov:fm:1').base_id).toBe('fm:1')
  expectErr(await s.mutate('items.upsert@1', ov({ id: 'ov:fm:2', kind: '自建', base_id: 'fm:2' })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', ov({ id: 'ov:fm:3', base_id: 'fm:other' })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', ov({ id: 'ov:fm:4', base_id: null })), 'bad_record')
})

test('u:：kind 必須是自建、base_id 必須空白', async () => {
  const s = newServer()
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: 'u:1', kind: '補填' })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: 'u:2', base_id: 'fm:1' })), 'bad_record')
  expectOk(await s.mutate('items.upsert@1', itemArgs({ id: 'u:3', base_id: '' })))
  expect(row(s, 'items', 'u:3').base_id).toBeNull()
})

test('店家品項：src 必須是其他、店家必須存在且沒被刪', async () => {
  const s = newServer()
  await s.mutate('stores.upsert@1', storeArgs({ id: 's:1' }))
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: 'u:1', store_id: 's:1', src: '全家' })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: 'u:2', store_id: 's:none' })), 'bad_record')
  expectOk(await s.mutate('items.upsert@1', itemArgs({ id: 'u:3', store_id: 's:1' })))
  await s.mutate('stores.delete@1', { id: 's:1' })
  expectErr(await s.mutate('items.upsert@1', itemArgs({ id: 'u:4', store_id: 's:1' })), 'bad_record')
})

test('欄位驗證：name／serving 不能空、serving_g > 0、營養素 ≥ 0 的數字', async () => {
  const s = newServer()
  expectErr(await s.mutate('items.upsert@1', itemArgs({ name: '' })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', itemArgs({ serving: '' })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', itemArgs({ serving_g: 0 })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', itemArgs({ kcal: -1 })), 'bad_record')
  expectErr(await s.mutate('items.upsert@1', itemArgs({ protein: null })), 'bad_record')
  expectOk(await s.mutate('items.upsert@1', itemArgs({ serving_g: null, protein: 0, fat: 0, carb: 0, kcal: 0 })))
})

test('created_by 建立後不變；v1 的 fav 欄位被忽略；ts 沒帶就用現在', async () => {
  const s = newServer()
  expectOk(await s.mutate('items.upsert@1', { ...itemArgs({ id: 'u:1', ts: undefined }), fav: true } as never))
  const first = row(s, 'items', 'u:1')
  expect(first.created_by).toBe('app')
  expect(first.ts).toBe('2026-10-12T12:00:00+08:00')
  expect('fav' in first).toBe(false)
  await s.asKyujin('items.upsert@1', itemArgs({ id: 'u:2' }))
  await s.mutate('items.upsert@1', itemArgs({ id: 'u:2', name: '改' }))
  expect(row(s, 'items', 'u:2').created_by).toBe('kyujin')
})

test('items.delete／restore：owner 可以；不存在 ignored:missing；重複 ignored；Kyujin forbidden', async () => {
  const s = newServer()
  await s.mutate('items.upsert@1', itemArgs({ id: 'u:1' }))
  const v0 = s.db.version
  expect(expectOk(await s.mutate('items.delete@1', { id: 'u:nope' }))).toEqual({ ignored: 'missing' })
  expect(s.db.version).toBe(v0)
  expectErr(await s.mutate('items.restore@1', { id: 'u:nope' }), 'not_found')
  expectOk(await s.mutate('items.delete@1', { id: 'u:1' }))
  expect(row(s, 'items', 'u:1').deleted_at).not.toBeNull()
  expect(expectOk(await s.mutate('items.delete@1', { id: 'u:1' }))).toEqual({ ignored: 'deleted' })
  expectErr(await s.asKyujin('items.restore@1', { id: 'u:1' }), 'forbidden')
  expectOk(await s.mutate('items.restore@1', { id: 'u:1' }))
  expect(row(s, 'items', 'u:1').deleted_at).toBeNull()
  expect(expectOk(await s.mutate('items.restore@1', { id: 'u:1' }))).toEqual({ ignored: 'not_deleted' })
  expectErr(await s.asKyujin('items.delete@1', { id: 'u:1' }), 'forbidden')
})

test('logs.add 帶 item：補填與自建在同一個交易裡先寫；log.item_id 是官方 id', async () => {
  const s = newServer()
  const res = await s.mutate('logs.add@1', { log: logArgs({ id: 'l1', item_id: 'fm:1' }), item: ov({ protein: 20.8, fat: 1.5, carb: 2.3 }) })
  expectOk(res)
  expect(row(s, 'items', 'ov:fm:1').kind).toBe('補填')
  expect(row(s, 'logs', 'l1').item_id).toBe('fm:1')
  // 同一版本號：一個交易
  expect(row(s, 'items', 'ov:fm:1').version).toBe(row(s, 'logs', 'l1').version)
  // 自建品項補營養素
  expectOk(await s.mutate('logs.add@1', { log: logArgs({ id: 'l2', item_id: 'u:c', src: '其他' }), item: itemArgs({ id: 'u:c' }) }))
  expect(row(s, 'items', 'u:c').version).toBe(row(s, 'logs', 'l2').version)
})

test('logs.add 帶 item：item 驗證失敗整筆不寫；item 和 log 對不上 → bad_record；品項已刪除不擋記錄', async () => {
  const s = newServer()
  expectErr(await s.mutate('logs.add@1', { log: logArgs({ id: 'l1', item_id: 'fm:1' }), item: ov({ kind: '自建' }) }), 'bad_record')
  expectErr(await s.mutate('logs.add@1', { log: logArgs({ id: 'l2', item_id: 'fm:9' }), item: ov() }), 'bad_record')
  expectErr(await s.mutate('logs.add@1', { log: logArgs({ id: 'l3', day: '2026-10-13' }), item: ov() }), 'bad_record')
  expect(s.db.all('logs')).toHaveLength(0)
  expect(s.db.all('items')).toHaveLength(0)
  expect(s.db.version).toBe(0)
  await s.mutate('items.upsert@1', itemArgs({ id: 'u:c' }))
  await s.mutate('items.delete@1', { id: 'u:c' })
  expectOk(await s.mutate('logs.add@1', { log: logArgs({ id: 'l4', item_id: 'u:c', src: '其他' }), item: itemArgs({ id: 'u:c' }) }))
  expect(row(s, 'logs', 'l4').item_id).toBe('u:c')
  expect(row(s, 'items', 'u:c').deleted_at).not.toBeNull()
})

test('logs.add 帶 item：重送（log id 已存在）什麼都不寫', async () => {
  const s = newServer()
  const args = { log: logArgs({ id: 'l1', item_id: 'u:c', src: '其他' }), item: itemArgs({ id: 'u:c' }) }
  expectOk(await s.mutate('logs.add@1', args))
  const v = s.db.version
  expect(expectOk(await s.mutate('logs.add@1', { ...args, item: { ...args.item, name: '被忽略' } }))).toEqual({ duplicate: true })
  expect(s.db.version).toBe(v)
  expect(row(s, 'items', 'u:c').name).toBe('乳清')
})
