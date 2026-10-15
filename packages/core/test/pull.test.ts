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

describe('讀取順序：cursor → meta → 列（回應不能宣稱一筆 mutation 已處理、卻沒帶它的列）', () => {
  // 在 pull 的每一個讀取之後，讓另一個 push 提交（weights.upsert，mutationId=1）。不論插在哪裡，
  // 只要回應的 lastMutationId 已經 >= 1，就必須帶著那一列；沒帶的話 lastMutationId 必須還是 0。
  const OPS = ['getLastMutationId', 'listErrors', 'readMeta', 'rowsAfter'] as const
  test.each(OPS)('push 在 %s 之後提交', async (op) => {
    const s = newServer()
    let fired = false
    s.afterRead = async (o) => {
      if (o !== op || fired) return
      fired = true
      s.afterRead = undefined // push 自己的讀取不要再觸發鉤子
      await s.push({ clientId: 'c1', mutations: [{ id: 1, name: 'weights.upsert@1', args: weightArgs({ id: 'wp' }), clientTs: 0 }] })
    }
    const p = await s.pull({ clientId: 'c1' })
    expect(fired).toBe(true)
    const hasRow = p.changes.weights.some((w) => w.id === 'wp')
    if (p.lastMutationId >= 1) expect(hasRow, '宣稱 mutation 1 已處理，就必須帶它的列').toBe(true)
    // 新的讀取順序下，cursor 比列先讀：push 在 cursor 之後才提交 → 這一輪還不宣稱它。
    expect(p.lastMutationId).toBe(0)
    // 下一次 pull 就會看到它（cookie 沒有跳過那一列）。
    const next = await s.pull({ clientId: 'c1', cookie: p.cookie })
    expect(next.lastMutationId).toBe(1)
    expect(hasRow || next.changes.weights.some((w) => w.id === 'wp')).toBe(true)
  })

  test('push 在 pull 開始前已提交：同一個回應宣稱它，也帶著列', async () => {
    const s = newServer()
    await s.mutate('weights.upsert@1', weightArgs({ id: 'wp' }))
    const p = await s.pull({ clientId: 'mem-app' })
    expect(p.lastMutationId).toBe(1)
    expect(p.changes.weights.map((w) => w.id)).toEqual(['wp'])
  })

  test('錯誤只回 <= lastMutationId 的（push 在讀 cursor 之後才提交的錯誤，等下一輪）', async () => {
    const s = newServer()
    let fired = false
    s.afterRead = async (o) => {
      if (o !== 'getLastMutationId' || fired) return
      fired = true
      s.afterRead = undefined
      await s.push({ clientId: 'c1', mutations: [{ id: 1, name: 'logs.restore@1', args: { id: 'nope' }, clientTs: 0 }] }) // not_found
    }
    const p = await s.pull({ clientId: 'c1' })
    expect(p.lastMutationId).toBe(0)
    expect(p.errors).toEqual([])
    const next = await s.pull({ clientId: 'c1' })
    expect(next.lastMutationId).toBe(1)
    expect(next.errors.map((e) => e.error)).toEqual(['not_found'])
  })
})

describe('使用者隔離（ServerStore.forUser）', () => {
  test('兩個使用者用相同的 id 與 clientId：pull、cursor、重送結果互不可見', async () => {
    const s = newServer()
    const mine = { clientId: 'phone', mutations: [{ id: 1, name: 'weights.upsert@1', args: weightArgs({ id: 'w1', kg: 72 }), clientTs: 0 }] }
    const theirs = { clientId: 'phone', mutations: [{ id: 1, name: 'weights.upsert@1', args: weightArgs({ id: 'w1', kg: 90 }), clientTs: 0 }] }
    expect((await s.push(mine, undefined, undefined, 'alice')).results[0]).toMatchObject({ ok: true, result: { rowId: 'w1', overwritten: false } })
    // bob 的 id=1 不是 alice 的重送：cursor 各自計算，同一天也不會「覆寫」alice 的列。
    expect((await s.push(theirs, undefined, undefined, 'bob')).results[0]).toMatchObject({ ok: true, result: { rowId: 'w1', overwritten: false, prevKg: null } })

    const a = await s.pull({ clientId: 'phone' }, 'alice')
    const b = await s.pull({ clientId: 'phone' }, 'bob')
    expect(a.changes.weights.map((w) => [w.user_id, w.id, w.kg])).toEqual([['alice', 'w1', 72]])
    expect(b.changes.weights.map((w) => [w.user_id, w.id, w.kg])).toEqual([['bob', 'w1', 90]])
    expect(a.lastMutationId).toBe(1)
    expect(b.lastMutationId).toBe(1)
    // 沒有資料的第三個使用者什麼都看不到。
    const c = await s.pull({ clientId: 'phone' }, 'carol')
    expect(c.changes.weights).toEqual([])
    expect(c.lastMutationId).toBe(0)
  })

  test('bob 的業務錯誤與重送結果不會出現在 alice 的 pull／重送；forUser 回傳的 userId 就是綁定的 userId', async () => {
    const s = newServer()
    await s.push({ clientId: 'phone', mutations: [{ id: 1, name: 'logs.restore@1', args: { id: 'nope' }, clientTs: 0 }] }, undefined, undefined, 'bob')
    expect((await s.pull({ clientId: 'phone' }, 'bob')).errors).toHaveLength(1)
    expect((await s.pull({ clientId: 'phone' }, 'alice')).errors).toEqual([])
    expect(await s.forUser('alice').getMutationOutcome('phone', 1)).toBeUndefined()
    expect(s.forUser('bob').userId).toBe('bob')
    expect(s.forUser('alice').userId).toBe('alice')
  })

  test('版本號是全域的、列是各自的：alice 的 cookie 不會因 bob 的寫入多出列', async () => {
    const s = newServer()
    await s.mutateAs('alice', 'weights.upsert@1', weightArgs({ id: 'a1' }))
    const first = await s.pull({ clientId: 'phone' }, 'alice')
    await s.mutateAs('bob', 'weights.upsert@1', weightArgs({ id: 'b1' }))
    const next = await s.pull({ clientId: 'phone', cookie: first.cookie }, 'alice')
    expect(next.changes.weights).toEqual([])
    expect(s.dbOf('bob').tables.weights.has('b1')).toBe(true)
    expect(s.dbOf('alice').tables.weights.has('b1')).toBe(false)
  })
})
