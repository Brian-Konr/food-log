import { describe, expect, test } from 'vitest'
import { formatCookie, parseCookie } from '../src/protocol/pull'
import type { PullResponse } from '../src/protocol/pull'
import { addDays } from '../src/time'
import { itemArgs, logArgs, noonOf, storeArgs, TEST_TODAY, weightArgs } from '../src/testing'
import type { MemoryServer } from '../src/testing'
import { newServer } from './helpers'

/** 每天一筆體重：每筆 mutation 一個版本號、一列。 */
async function seedWeights(s: MemoryServer, n: number) {
  for (let i = 0; i < n; i++) {
    const day = addDays(TEST_TODAY, -(i + 1))
    await s.mutate('weights.upsert@1', weightArgs({ id: `w${i}`, day, ts: noonOf(day, '08:00'), kg: 70 + i / 10 }))
  }
}

async function pullAll(s: MemoryServer, from = '', clientId = 'c') {
  const pages: PullResponse[] = []
  let cookie = from
  for (let guard = 0; guard < 50; guard++) {
    const p = await s.pull({ clientId, cookie })
    pages.push(p)
    cookie = p.cookie
    if (!p.more) break
  }
  return pages
}

describe('cookie', () => {
  test('parseCookie／formatCookie；空字串、0、壞掉的都是從頭開始', () => {
    expect(parseCookie('e1:42')).toEqual({ epoch: 'e1', version: 42 })
    expect(parseCookie('a:b:7')).toEqual({ epoch: 'a:b', version: 7 })
    for (const bad of ['', '0', undefined, null, 'garbage', ':5', 'e1:x', 'e1:-1', 'e1:1.5']) expect(parseCookie(bad)).toEqual({ epoch: null, version: 0 })
    expect(formatCookie('e1', 9)).toBe('e1:9')
  })
})

describe('分頁', () => {
  test('每頁不超過 pageRows，頁只在版本號之間切，所有列剛好出現一次、依版本順序', async () => {
    const s = newServer()
    s.pageRows = 3
    await seedWeights(s, 10)
    const pages = await pullAll(s)
    expect(pages.length).toBeGreaterThan(1)
    const seen: string[] = []
    let lastVersion = 0
    for (const [i, p] of pages.entries()) {
      expect(p.more).toBe(i < pages.length - 1)
      expect(p.changes.weights.length).toBeLessThanOrEqual(3)
      for (const w of p.changes.weights) {
        expect(w.version).toBeGreaterThan(lastVersion)
        lastVersion = w.version
        seen.push(w.id)
      }
    }
    expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => `w${i}`))
    expect(pages.at(-1)!.cookie).toBe(formatCookie('e1', 10))
  })

  test('同一個版本的列不會被切開：多列的版本（刪店連帶刪品項）整個放同一頁', async () => {
    const s = newServer()
    await s.mutate('stores.upsert@1', storeArgs({ id: 's:1' })) // v1：1 列
    await s.mutate('items.upsert@1', itemArgs({ id: 'u:a', store_id: 's:1' })) // v2
    await s.mutate('items.upsert@1', itemArgs({ id: 'u:b', store_id: 's:1' })) // v3
    await s.mutate('stores.delete@1', { id: 's:1' }) // v4：3 列（店 + 2 品項）
    await s.mutate('weights.upsert@1', weightArgs({ id: 'w1' })) // v5
    s.pageRows = 4
    const pages = await pullAll(s)
    // 伺服器只留每一列的最新狀態：s:1、u:a、u:b 都是 v4（一個版本 3 列），w1 是 v5
    const all = pages.flatMap((p) => [...p.changes.stores, ...p.changes.items, ...p.changes.weights])
    expect(all).toHaveLength(4)
    for (const p of pages) {
      const versions = new Set([...p.changes.stores, ...p.changes.items, ...p.changes.weights].map((r) => r.version))
      for (const v of versions) {
        // 該版本的所有列都在這一頁
        const inPage = [...p.changes.stores, ...p.changes.items, ...p.changes.weights].filter((r) => r.version === v).length
        const total = [...s.db.all('stores'), ...s.db.all('items'), ...s.db.all('weights')].filter((r) => r.version === v).length
        expect(inPage).toBe(total)
      }
    }
  })

  test('單一版本的列比一頁還多：整個版本放一頁，不卡住', async () => {
    const s = newServer()
    await s.mutate('stores.upsert@1', storeArgs({ id: 's:1' }))
    for (let i = 0; i < 4; i++) await s.mutate('items.upsert@1', itemArgs({ id: `u:${i}`, store_id: 's:1' }))
    await s.mutate('stores.delete@1', { id: 's:1' }) // 一個版本 5 列
    await s.mutate('weights.upsert@1', weightArgs({ id: 'w1' }))
    s.pageRows = 2
    const pages = await pullAll(s)
    expect(pages[0]!.changes.stores.length + pages[0]!.changes.items.length).toBe(5)
    expect(pages[0]!.more).toBe(true)
    const ids = pages.flatMap((p) => [...p.changes.stores, ...p.changes.items, ...p.changes.weights].map((r) => ('id' in r ? r.id : '')))
    expect(ids.sort()).toEqual(['s:1', 'u:0', 'u:1', 'u:2', 'u:3', 'w1'])
    expect(pages.at(-1)!.more).toBe(false)
  })

  test('預設一頁 2,000 列', async () => {
    const s = newServer()
    await seedWeights(s, 5)
    const p = await s.pull({ clientId: 'c' })
    expect(p.more).toBe(false)
    expect(p.changes.weights).toHaveLength(5)
  })
})

describe('增量、tombstone、reset', () => {
  test('帶 cookie 只拿到更新的列；軟刪除的 tombstone 也在；沒新東西時 cookie 不變', async () => {
    const s = newServer()
    await seedWeights(s, 3)
    const first = await s.pull({ clientId: 'c' })
    expect(first.changes.weights).toHaveLength(3)
    expect(first.reset).toBe(false)
    const idle = await s.pull({ clientId: 'c', cookie: first.cookie })
    expect(idle.changes.weights).toEqual([])
    expect(idle.cookie).toBe(first.cookie)
    await s.mutate('weights.delete@1', { id: 'w1' })
    const next = await s.pull({ clientId: 'c', cookie: first.cookie })
    expect(next.changes.weights).toHaveLength(1)
    expect(next.changes.weights[0]).toMatchObject({ id: 'w1' })
    expect(next.changes.weights[0]!.deleted_at).not.toBeNull()
    expect(next.cookie).toBe(formatCookie('e1', 4))
  })

  test('epoch 不同 → reset:true 並從頭送；接下來帶新 cookie 就不再 reset', async () => {
    const s = newServer()
    await seedWeights(s, 3)
    const first = await s.pull({ clientId: 'c' })
    s.db.epoch = 'e2' // 從備份還原或重新匯入
    const r = await s.pull({ clientId: 'c', cookie: first.cookie })
    expect(r.reset).toBe(true)
    expect(r.changes.weights).toHaveLength(3)
    expect(r.cookie).toBe(formatCookie('e2', 3))
    const after = await s.pull({ clientId: 'c', cookie: r.cookie })
    expect(after.reset).toBe(false)
    expect(after.changes.weights).toEqual([])
  })

  test('reset 且資料超過一頁：第一頁 reset:true，之後的頁帶新 epoch 的 cookie', async () => {
    const s = newServer()
    s.pageRows = 2
    await seedWeights(s, 5)
    s.db.epoch = 'e2'
    const pages = await pullAll(s, 'e1:2')
    expect(pages[0]!.reset).toBe(true)
    expect(pages.slice(1).every((p) => !p.reset)).toBe(true)
    expect(pages.flatMap((p) => p.changes.weights)).toHaveLength(5)
  })

  test('cookie 比伺服器還新（資料庫被還原到舊狀態但沒換 epoch）也 reset', async () => {
    const s = newServer()
    await seedWeights(s, 2)
    const r = await s.pull({ clientId: 'c', cookie: 'e1:99' })
    expect(r.reset).toBe(true)
    expect(r.changes.weights).toHaveLength(2)
  })

  test('回傳這台裝置的 lastMutationId 與 minClientVersion', async () => {
    const s = newServer()
    s.minClientVersion = 3
    await s.push({ clientId: 'c1', mutations: [{ id: 7, name: 'weights.upsert@1', args: weightArgs(), clientTs: 0 }] })
    const p = await s.pull({ clientId: 'c1' })
    expect(p.lastMutationId).toBe(7)
    expect(p.minClientVersion).toBe(3)
    expect((await s.pull({ clientId: 'new-device' })).lastMutationId).toBe(0)
  })
})

describe('兩台裝置', () => {
  test('A 寫、B pull 收斂到同一份；六張表都帶得走', async () => {
    const s = newServer()
    await s.mutate('stores.upsert@1', storeArgs({ id: 's:1' }))
    await s.mutate('items.upsert@1', itemArgs({ id: 'u:1', store_id: 's:1' }))
    await s.mutate('logs.add@1', { log: logArgs({ id: 'l1', item_id: 'u:1', src: '其他', store_id: 's:1' }) })
    await s.mutate('weights.upsert@1', weightArgs({ id: 'w1' }))
    await s.mutate('favorites.set@1', { item_id: 'u:1', fav: true })
    await s.mutate('config.set@1', { key: 'target_kcal', value: '1800' })
    const b = await s.pull({ clientId: 'B' })
    expect(b.changes.stores.map((r) => r.id)).toEqual(['s:1'])
    expect(b.changes.items.map((r) => r.id)).toEqual(['u:1'])
    expect(b.changes.logs.map((r) => r.id)).toEqual(['l1'])
    expect(b.changes.weights.map((r) => r.id)).toEqual(['w1'])
    expect(b.changes.favorites.map((r) => r.item_id)).toEqual(['u:1'])
    expect(b.changes.config[0]!.target_kcal).toBe(1800)
    expect(b.changes.stores[0]!.last_eaten_at).toBe(b.changes.logs[0]!.ts) // logs.add 更新了 last_eaten_at
  })
})
