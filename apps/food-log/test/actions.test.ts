// 每個使用者動作（計畫 §3.6）送出的 mutation 與 undo。用真的 SyncClient（帳號模式，離線）：
// 動作只寫本機並排進 pending，所以直接讀 pending 就是「會送給伺服器的東西」；undo 也是一個新的 mutation。
import { beforeEach, expect, test } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { MutationError } from '@food-log/core'
import { SyncClient } from '@food-log/sync-client'
import { MemoryTransport } from '@food-log/sync-client/testing'
import { createActions, duplicateStoreOf } from '@/data/actions'
import type { Actions } from '@/data/actions'
import { merged } from './helpers'
import { NOW, TODAY, newServer } from './harness'

let client: SyncClient
let actions: Actions
let ids = 0

beforeEach(async () => {
  ids = 0
  const server = newServer()
  const transport = new MemoryTransport({ server })
  transport.online = false // 不送：pending 就是結果
  client = await SyncClient.open({ userId: 'user-1', transport, now: () => NOW, dexie: { indexedDB: new IDBFactory(), IDBKeyRange }, newId: () => 'client-actions' })
  actions = createActions({ client, now: () => NOW, newId: () => `id${++ids}` })
})

const pendingNames = async () => (await client.db.pending.toArray()).map((p) => ({ name: p.name, args: p.args as Record<string, unknown> }))
const last = async () => (await pendingNames()).at(-1)!
const live = async <T extends 'logs' | 'items' | 'stores' | 'weights' | 'favorites'>(t: T) =>
  (await client.db.view(t).toArray()).filter((r) => (r as { deleted_at: string | null }).deleted_at === null)

const chicken = merged({ id: 'fm:1', name: '雞胸', servingG: 100, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3 })
const pasta = merged({ id: '711:x', src: '711', name: '義大利麵', sheetSrc: '7-11', servingG: null, kcal: 586, protein: 0, fat: 0, carb: 0, needsFill: true })

test('記一筆：logs.add，份量換算；undo = logs.delete（補填保留）', async () => {
  const r = await actions.recordLog({ item: chicken, qty: 1.5, grams: null })
  const p = await last()
  expect(p.name).toBe('logs.add@1')
  expect(p.args).toMatchObject({ log: { id: 'id1', item_id: 'fm:1', day: TODAY, source: 'app', qty: 1.5, kcal: 159, src: '全家' } })
  expect((p.args as { item?: unknown }).item).toBeUndefined()
  expect(await live('logs')).toHaveLength(1)
  await r.undo()
  expect((await last()).name).toBe('logs.delete@1')
  expect((await last()).args).toEqual({ id: 'id1' })
  expect(await live('logs')).toHaveLength(0)
})

test('記一筆（克數）：qty = 克數 / 每份克數', async () => {
  await actions.recordLog({ item: chicken, qty: 1, grams: 150 })
  expect((await last()).args).toMatchObject({ log: { qty: 1.5, grams: 150, kcal: 159 } })
})

test('記一筆 + 補填官方品項：同一個 logs.add 帶 ov: 品項；undo 只刪紀錄，補填保留', async () => {
  const r = await actions.recordLog({ item: pasta, qty: 1, grams: null, fill: { protein: 20, fat: 10, carb: 50 } })
  const all = await pendingNames()
  expect(all).toHaveLength(1)
  expect(all[0]!.args).toMatchObject({
    item: { id: 'ov:711:x', kind: '補填', base_id: '711:x', protein: 20, fat: 10, carb: 50, kcal: 586 },
    log: { item_id: '711:x', kcal: 586, protein: 20 },
  })
  await r.undo()
  expect((await last()).name).toBe('logs.delete@1')
  expect((await live('items')).map((i) => i.id)).toEqual(['ov:711:x'])
  expect(await live('logs')).toHaveLength(0)
})

test('記一筆 + 店家品項改營養素：logs.add 帶 u: 品項（新營養素）', async () => {
  const { id: storeId } = await actions.createStore('阿財')
  const beef = merged({ id: 'u:beef', src: 'custom', name: '牛肉麵', sheetSrc: '其他', storeId, servingG: null, kcal: 500, protein: 20 })
  await actions.recordLog({ item: beef, qty: 1, grams: null, nutrition: { kcal: 520, protein: 28, fat: 18, carb: 62 } })
  expect((await last()).args).toMatchObject({
    item: { id: 'u:beef', kind: '自建', store_id: storeId, src: '其他', kcal: 520, protein: 28 },
    log: { item_id: 'u:beef', store_id: storeId, kcal: 520 },
  })
})

test('快速記錄：logs.add（qty 1、沒有品項、source quick）；undo = logs.delete', async () => {
  const r = await actions.quickLog({ name: ' 豆漿 ', kcal: 100, protein: 10, fat: 1, carb: 10 })
  expect((await last()).args).toMatchObject({ log: { item_id: null, name: '豆漿', qty: 1, grams: null, src: '其他', source: 'quick', store_id: null } })
  await r.undo()
  expect((await last()).name).toBe('logs.delete@1')
  expect(await live('logs')).toHaveLength(0)
})

test('收藏：favorites.set；undo = 反向的 favorites.set（官方品項也一樣）', async () => {
  const r = await actions.setFavorite('fm:1', true)
  expect((await last())).toEqual({ name: 'favorites.set@1', args: { item_id: 'fm:1', fav: true } })
  expect((await live('favorites')).map((f) => f.item_id)).toEqual(['fm:1'])
  await r.undo()
  expect((await last())).toEqual({ name: 'favorites.set@1', args: { item_id: 'fm:1', fav: false } })
  expect(await live('favorites')).toHaveLength(0)
})

test('刪除品項：items.delete；undo = items.restore', async () => {
  const { id } = await actions.saveItem({ name: '乳清', src: '其他', serving: '1 匙', servingG: 30, kcal: 120, protein: 24, fat: 1, carb: 2 })
  expect((await last()).args).toMatchObject({ id, kind: '自建', base_id: null, store_id: null, serving_g: 30 })
  const r = await actions.deleteItem(id)
  expect(await last()).toEqual({ name: 'items.delete@1', args: { id } })
  expect(await live('items')).toHaveLength(0)
  await r.undo()
  expect(await last()).toEqual({ name: 'items.restore@1', args: { id } })
  expect(await live('items')).toHaveLength(1)
})

test('店家：新增、改名、刪除（連帶品項）；undo = stores.restore 還原連帶刪除的品項', async () => {
  const { id } = await actions.createStore('阿財牛肉麵')
  expect(id).toMatch(/^s:/)
  expect((await last()).name).toBe('stores.upsert@1')
  const store = (await live('stores'))[0]!
  const item = await actions.saveStoreItem({ storeId: id, name: '牛肉麵', kcal: 520, protein: 28, fat: 18, carb: 62 })
  expect((await last()).args).toMatchObject({ id: item.id, store_id: id, src: '其他', serving: '1 份' })
  await actions.renameStore(store, '阿財麵店')
  expect((await last()).args).toMatchObject({ id, name: '阿財麵店', ts: store.ts })
  const r = await actions.deleteStore(id)
  expect(await last()).toEqual({ name: 'stores.delete@1', args: { id } })
  expect(await live('stores')).toHaveLength(0)
  expect(await live('items')).toHaveLength(0)
  await r.undo()
  expect(await last()).toEqual({ name: 'stores.restore@1', args: { id } })
  expect(await live('stores')).toHaveLength(1)
  expect(await live('items')).toHaveLength(1)
})

test('店名重複：本機驗證當場丟 duplicate_name，什麼都沒寫；duplicateStoreOf 取出已有的店', async () => {
  const { id } = await actions.createStore('阿財')
  const before = (await pendingNames()).length
  const err = await actions.createStore(' 阿財 ').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(MutationError)
  expect(duplicateStoreOf(err)).toEqual({ id, name: '阿財' })
  expect(duplicateStoreOf(new Error('x'))).toBeNull()
  expect((await pendingNames()).length).toBe(before)
})

test('只存營養素：自建品項 items.upsert（同一個 id）；官方品項存成 ov:', async () => {
  const beef = merged({ id: 'u:beef', src: 'custom', name: '牛肉麵', sheetSrc: '其他', storeId: '', kcal: 500 })
  await actions.saveNutrition(beef, { kcal: 520, protein: 28, fat: 18, carb: 62 }).catch(() => undefined)
  expect((await last()).name).toBe('items.upsert@1')
  expect((await last()).args).toMatchObject({ id: 'u:beef', kcal: 520, kind: '自建' })
})

test('記體重（當天沒有紀錄）：weights.upsert；undo = weights.delete(rowId)', async () => {
  const r = await actions.recordWeight({ day: TODAY, kg: 72.4, today: TODAY })
  expect(r).toMatchObject({ overwritten: false, prevKg: null })
  expect((await last())).toMatchObject({ name: 'weights.upsert@1', args: { day: TODAY, kg: 72.4, id: 'id1' } })
  expect((await last()).args.ts).toBe('2026-10-10T18:00:00+08:00')
  await r.undo()
  expect(await last()).toEqual({ name: 'weights.delete@1', args: { id: 'id1' } })
  expect(await live('weights')).toHaveLength(0)
})

test('補記過去的體重：ts 是當天中午', async () => {
  await actions.recordWeight({ day: '2026-10-08', kg: 73, today: TODAY })
  expect((await last()).args.ts).toBe('2026-10-08T12:00:00+08:00')
})

test('記體重（覆寫）：undo = weights.upsert(prevKg，新 id)，原本的列和 id 保留', async () => {
  await actions.recordWeight({ day: TODAY, kg: 72.4, today: TODAY })
  const r = await actions.recordWeight({ day: TODAY, kg: 71.9, today: TODAY })
  expect(r).toMatchObject({ overwritten: true, prevKg: 72.4 })
  expect((await live('weights')).map((w) => [w.id, w.kg])).toEqual([['id1', 71.9]])
  await r.undo()
  const p = await last()
  expect(p.name).toBe('weights.upsert@1')
  expect(p.args).toMatchObject({ day: TODAY, kg: 72.4 })
  expect(p.args.id).not.toBe('id1')
  expect((await live('weights')).map((w) => [w.id, w.kg])).toEqual([['id1', 72.4]])
})

test('編輯紀錄：logs.update；undo = logs.update（舊值）。刪除紀錄：logs.delete；undo = logs.restore', async () => {
  await actions.quickLog({ name: '豆漿', kcal: 100, protein: 10, fat: 1, carb: 10 })
  const row = (await live('logs'))[0]!
  const old = { id: row.id, ts: row.ts, day: row.day, item_id: '', name: row.name, src: row.src, qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 10, source: 'quick' as const, store: '', deleted: false, updated_at: '' }
  const u = await actions.updateLog(old, { kcal: 150, name: '豆漿大' })
  expect(await last()).toMatchObject({ name: 'logs.update@1', args: { id: row.id, patch: { kcal: 150, name: '豆漿大' } } })
  expect((await live('logs'))[0]!.kcal).toBe(150)
  await u.undo()
  expect((await last()).args).toMatchObject({ id: row.id, patch: { kcal: 100, name: '豆漿', qty: 1, grams: null, ts: row.ts, day: row.day } })
  expect((await live('logs'))[0]!.kcal).toBe(100)
  const d = await actions.deleteLog(row.id)
  expect(await last()).toEqual({ name: 'logs.delete@1', args: { id: row.id } })
  expect(await live('logs')).toHaveLength(0)
  await d.undo()
  expect(await last()).toEqual({ name: 'logs.restore@1', args: { id: row.id } })
  expect(await live('logs')).toHaveLength(1)
})

test('設定：config.set（字串進、有型別的欄位出）；不合法的值本機就丟 bad_record', async () => {
  await actions.setConfig('target_kcal', '1800')
  expect(await last()).toEqual({ name: 'config.set@1', args: { key: 'target_kcal', value: '1800' } })
  expect((await client.db.view('config').toArray())[0]).toMatchObject({ target_kcal: 1800 })
  await actions.setConfig('tdee', '')
  await expect(actions.setConfig('tdee', '100')).rejects.toMatchObject({ code: 'bad_record' })
})

test('失敗清單：重試 = 用新的 mutationId 再 mutate；捨棄 = 刪掉失敗列，undo 放回去', async () => {
  await client.db.failed.put({ mutationId: 7, name: 'favorites.set@1', args: { item_id: 'fm:1', fav: true }, error: 'bad_record', message: '壞', at: '', source: 'server' })
  const [row] = await client.db.failed.toArray()
  const d = await actions.discardFailed(row!)
  expect(await client.db.failed.count()).toBe(0)
  await d.undo()
  expect(await client.db.failed.count()).toBe(1)
  await actions.retryFailed(7)
  expect(await client.db.failed.count()).toBe(0)
  const p = await last()
  expect(p.name).toBe('favorites.set@1')
  const rows = await client.db.pending.toArray()
  expect(rows.at(-1)!.mutationId).toBeGreaterThan(0)
  expect(rows.at(-1)!.mutationId).not.toBe(7)
})
