import { MAX_PUSH_MUTATIONS } from '@food-log/core'
import type { PullResponse } from '@food-log/core'
import { describe, expect, it } from 'vitest'
import { applyPullPage } from '../src/rebase'
import { checkViewInvariant } from '../src/testing'
import { USER, newServer, liveServerRows, liveViewOf, logArgs, noonOf, openDevice, restartDevice, serverRows, storeArgs, sync, viewOf, weightArgs } from './helpers'

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`

async function expectConsistent(...ds: Awaited<ReturnType<typeof openDevice>>[]) {
  for (const d of ds) expect(await checkViewInvariant(d.client.db)).toBeNull()
}

describe('離線 → 上線', () => {
  it('離線 3 筆：畫面立刻有，上線後伺服器剛好 3 筆，佇列清空', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    d.transport.online = false
    await d.client.mutate('weights.upsert@1', weightArgs({ id: 'a', day: day(8), ts: noonOf(day(8)), kg: 70 }))
    await d.client.mutate('weights.upsert@1', weightArgs({ id: 'b', day: day(9), ts: noonOf(day(9)), kg: 71 }))
    await d.client.mutate('weights.upsert@1', weightArgs({ id: 'c', day: day(10), ts: noonOf(day(10)), kg: 72 }))
    await expect(sync(d)).rejects.toMatchObject({ name: 'NetworkError' })
    expect(await d.client.db.pending.count()).toBe(3)
    expect((await liveViewOf(d, 'weights')).map((w) => w.kg).sort()).toEqual([70, 71, 72])
    expect(serverRows(server, 'weights')).toHaveLength(0)

    d.transport.online = true
    await sync(d)
    expect(await d.client.db.pending.count()).toBe(0)
    expect(liveServerRows(server, 'weights').map((w) => w.kg).sort()).toEqual([70, 71, 72])
    expect(server.meta.version).toBe(3)
    expect((await liveViewOf(d, 'weights')).map((w) => w.kg).sort()).toEqual([70, 71, 72])
    expect(await d.client.db.getMeta('cookie', '')).toBe('e1:3')
    expect(await d.client.db.getMeta('lastMutationId', 0)).toBe(3)
    expect(d.client.getStatus()).toMatchObject({ pendingCount: 0, failed: 0, hasServerData: true })
    // 畫面列已經換成伺服器的版本號
    expect((await viewOf(d, 'weights')).every((w) => w.version > 0)).toBe(true)
    await expectConsistent(d)
  })

  it('超過一批（MAX_PUSH_MUTATIONS）就分批送，每批不超過上限', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    const n = MAX_PUSH_MUTATIONS * 2 + 3
    for (let i = 0; i < n; i++) await d.client.mutate('logs.add@1', { log: logArgs({ id: `l${i}` }) })
    await sync(d)
    expect(d.transport.pushedIds.map((b) => b.length)).toEqual([MAX_PUSH_MUTATIONS, MAX_PUSH_MUTATIONS, 3])
    expect(serverRows(server, 'logs')).toHaveLength(n)
    expect(await d.client.db.pending.count()).toBe(0)
  })
})

describe('回應遺失 / 重複送', () => {
  it('回應掉了 → 重送 → 伺服器只生效一次', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    await d.client.mutate('weights.upsert@1', weightArgs({ id: 'a', day: day(9), ts: noonOf(day(9)) }))
    d.transport.nextPushFault = 'dropResponse'
    await expect(d.client.pushOnce()).rejects.toMatchObject({ name: 'NetworkError' })
    expect(serverRows(server, 'weights')).toHaveLength(1) // 伺服器收到了
    expect(await d.client.db.pending.count()).toBe(1) // 用戶端不知道
    await sync(d)
    expect(d.transport.pushedIds).toEqual([[1], [1]]) // 同一個 mutationId 送了兩次
    expect(serverRows(server, 'weights')).toHaveLength(1)
    expect(server.meta.version).toBe(1)
    expect(await d.client.db.pending.count()).toBe(0)
    await expectConsistent(d)
  })

  it('請求掉了：重送；請求重複投遞：只生效一次', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    d.transport.nextPushFault = 'dropRequest'
    await expect(d.client.pushOnce()).rejects.toMatchObject({ name: 'NetworkError' })
    expect(serverRows(server, 'logs')).toHaveLength(0)
    d.transport.nextPushFault = 'duplicate'
    await d.client.pushOnce()
    await d.client.pullOnce()
    expect(serverRows(server, 'logs')).toHaveLength(1)
    expect(server.meta.version).toBe(1)
    expect(await d.client.db.pending.count()).toBe(0)
  })

  it('重啟 App：pending 還在，重啟後重送，伺服器只生效一次', async () => {
    const server = newServer()
    let d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l2' }) })
    d.transport.nextPushFault = 'dropResponse'
    await expect(d.client.pushOnce()).rejects.toThrow()
    d = await restartDevice(d, { server })
    expect(await d.client.db.pending.count()).toBe(2)
    expect(d.client.getStatus().pendingCount).toBe(2)
    expect(await liveViewOf(d, 'logs')).toHaveLength(2)
    await sync(d)
    expect(serverRows(server, 'logs')).toHaveLength(2)
    expect(server.meta.version).toBe(2)
    expect(await d.client.db.pending.count()).toBe(0)
    // 重啟之後 mutationId 接著用，不會重複
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l3' }) })
    expect((await d.client.db.pending.toArray()).map((p) => p.mutationId)).toEqual([3])
  })
})

describe('兩台裝置', () => {
  it('交錯寫入後收斂到相同的內容', async () => {
    const server = newServer()
    const a = await openDevice({ server })
    const b = await openDevice({ server })
    await a.client.mutate('stores.upsert@1', storeArgs({ id: 's:a', name: 'A 店' }))
    await b.client.mutate('stores.upsert@1', storeArgs({ id: 's:b', name: 'B 店' }))
    await a.client.mutate('logs.add@1', { log: logArgs({ id: 'la', item_id: 'u:1', name: '甲', store_id: 's:a' }) })
    await b.client.mutate('weights.upsert@1', weightArgs({ id: 'wb', day: day(10), ts: noonOf(day(10)) }))
    await sync(a)
    await b.client.mutate('logs.add@1', { log: logArgs({ id: 'lb', item_id: 'u:2', name: '乙', store_id: 's:b' }) })
    await sync(b)
    await a.client.mutate('stores.delete@1', { id: 's:b' })
    await sync(a)
    await sync(b)
    await sync(a)
    for (const d of [a, b]) {
      expect((await liveViewOf(d, 'stores')).map((s) => s.id)).toEqual(['s:a'])
      expect((await liveViewOf(d, 'logs')).map((l) => l.id).sort()).toEqual(['la', 'lb'])
      expect((await liveViewOf(d, 'weights')).map((w) => w.id)).toEqual(['wb'])
      expect(await d.client.db.pending.count()).toBe(0)
      await expectConsistent(d)
    }
    expect(await viewOf(a, 'stores')).toEqual(await viewOf(b, 'stores'))
    expect(await viewOf(a, 'logs')).toEqual(await viewOf(b, 'logs'))
  })

  it('同一天兩台各記一筆體重：伺服器依抵達順序合併成一筆，兩台的畫面都是那一筆（rebase 的髒鍵要含剛確認的 pending）', async () => {
    const server = newServer()
    const a = await openDevice({ server })
    const b = await openDevice({ server })
    await a.client.mutate('weights.upsert@1', weightArgs({ id: 'wa', day: day(10), ts: noonOf(day(10)), kg: 70 }))
    await b.client.mutate('weights.upsert@1', weightArgs({ id: 'wb', day: day(10), ts: noonOf(day(10)), kg: 68.5 }))
    await sync(a) // a 先到
    await sync(b) // b 蓋寫 wa
    await sync(a)
    expect(liveServerRows(server, 'weights')).toHaveLength(1)
    for (const d of [a, b]) {
      const w = await liveViewOf(d, 'weights')
      expect(w).toHaveLength(1)
      expect(w[0]).toMatchObject({ id: 'wa', kg: 68.5 })
      expect((await viewOf(d, 'weights')).map((x) => x.id)).toEqual(['wa']) // wb 不能殘留在畫面表
      await expectConsistent(d)
    }
  })

  it('刪店的同時另一台新增店內品項：不會出現「未刪除的品項在已刪除的店」', async () => {
    const server = newServer()
    const a = await openDevice({ server })
    const b = await openDevice({ server })
    await a.client.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '店' }))
    await sync(a)
    await sync(b)
    await a.client.mutate('stores.delete@1', { id: 's:1' })
    const item = { id: 'u:i1', kind: '自建', src: '其他', name: '乳清', serving: '1 匙', kcal: 1, protein: 1, fat: 1, carb: 1, store_id: 's:1' } as const
    await b.client.mutate('items.upsert@1', item)
    await sync(a)
    await sync(b) // 伺服器上店已刪 → bad_record
    await sync(a)
    expect(b.client.getStatus().failed).toBe(1)
    const failed = await b.client.failedRows()
    expect(failed[0]).toMatchObject({ error: 'bad_record', name: 'items.upsert@1', source: 'server' })
    expect(await liveViewOf(b, 'items')).toEqual([])
    await expectConsistent(a, b)
  })
})

describe('業務錯誤與 failed', () => {
  it('另一台先建了同名店：本機重播時就失敗（source=local，pending 還在佇列），伺服器回答後變 source=server，畫面只剩對方的店', async () => {
    const server = newServer()
    const a = await openDevice({ server })
    const b = await openDevice({ server })
    await a.client.mutate('stores.upsert@1', storeArgs({ id: 's:a', name: '阿財牛肉麵' }))
    await b.client.mutate('stores.upsert@1', storeArgs({ id: 's:b', name: '阿財牛肉麵' })) // b 本機沒看到 a 的，通過
    await sync(a)
    await b.client.pullOnce() // b 收到 a 的店，重播 b 的 pending 時撞名
    let failed = await b.client.failedRows()
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ mutationId: 1, error: 'duplicate_name', source: 'local' })
    expect(await b.client.db.pending.count()).toBe(1) // 仍在佇列，等伺服器回答
    expect((await liveViewOf(b, 'stores')).map((s) => s.id)).toEqual(['s:a'])
    await expectConsistent(b)

    await sync(b) // 送出 → 伺服器回 duplicate_name
    failed = await b.client.failedRows()
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ mutationId: 1, error: 'duplicate_name', source: 'server', details: { existingId: 's:a' } })
    expect(await b.client.db.pending.count()).toBe(0)
    expect(b.client.getStatus().failed).toBe(1)
    expect((await viewOf(b, 'stores')).map((s) => s.id)).toEqual(['s:a'])
    await expectConsistent(b)
  })

  it('伺服器錯誤：畫面上的樂觀寫入退回伺服器的答案；retryFailed 用新的 mutationId 重送、discardFailed 捨棄', async () => {
    const server = newServer()
    const a = await openDevice({ server })
    const b = await openDevice({ server })
    // b 先本機寫入（還沒看到 a 的店名），再 push；a 先 push 的店佔了名字
    await b.client.mutate('stores.upsert@1', storeArgs({ id: 's:b', name: '阿財牛肉麵' }))
    await a.client.mutate('stores.upsert@1', storeArgs({ id: 's:a', name: '阿財牛肉麵' }))
    await sync(a)
    await b.client.pushOnce() // 伺服器回 duplicate_name；push 先記進 failed，pending 留到 pull 確認
    expect((await b.client.failedRows())[0]).toMatchObject({ error: 'duplicate_name', source: 'server', args: { id: 's:b' } })
    expect((await liveViewOf(b, 'stores')).map((s) => s.id)).toEqual(['s:b']) // pull 之前畫面不閃
    await b.client.pullOnce()
    expect((await liveViewOf(b, 'stores')).map((s) => s.id)).toEqual(['s:a'])

    // 改名後重試：新的 mutationId；重試的是「原本的參數」，這裡會再次撞名 → MutationError，failed 保留
    await expect(b.client.retryFailed(1)).rejects.toMatchObject({ code: 'duplicate_name' })
    expect(b.client.getStatus().failed).toBe(1)
    await b.client.discardFailed(1)
    expect(b.client.getStatus().failed).toBe(0)
    expect(await b.client.failedRows()).toEqual([])

    // 成功的重試：先刪掉 a 的店，再重試
    await b.client.mutate('stores.delete@1', { id: 's:a' })
    await sync(b)
    await b.client.mutate('stores.upsert@1', storeArgs({ id: 's:c', name: '阿財牛肉麵' }))
    await sync(b)
    expect((await liveViewOf(b, 'stores')).map((s) => s.id)).toEqual(['s:c'])
  })
})

describe('pull 分頁與 reset', () => {
  it('分頁：more=true 的頁只套資料列，不確認 pending；最後一頁才確認', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    await d.client.pushOnce()
    const base = {
      cookie: 'e1:1',
      reset: false,
      lastMutationId: 1,
      minClientVersion: 1,
      changes: { stores: [], items: [], logs: [], weights: [], favorites: [], config: [] },
      errors: [],
    }
    await applyPullPage(d.client.db, { ...base, more: true } satisfies PullResponse, 0)
    expect(await d.client.db.pending.count()).toBe(1) // lastMutationId 在中間頁不可信
    expect(await d.client.db.getMeta('lastMutationId', 0)).toBe(0)
    await applyPullPage(d.client.db, { ...base, more: false } satisfies PullResponse, 0)
    expect(await d.client.db.pending.count()).toBe(0)
    expect(await d.client.db.getMeta('lastMutationId', 0)).toBe(1)
  })

  it('真的分頁（pageRows=2）：全部收齊、和伺服器相同', async () => {
    const server = newServer()
    server.pageRows = 2
    const a = await openDevice({ server })
    for (let i = 0; i < 7; i++) await a.client.mutate('logs.add@1', { log: logArgs({ id: `l${i}` }) })
    await sync(a)
    const b = await openDevice({ server })
    await b.client.pullOnce()
    expect(b.transport.pullCalls).toBeGreaterThanOrEqual(4)
    expect((await viewOf(b, 'logs')).map((l) => l.id).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `l${i}`))
    expect(await b.client.db.getMeta('cookie', '')).toBe('e1:7')
  })

  it('reset（epoch 變了）：清掉 srv 重拉，pending 保留並重播；畫面等於伺服器 + pending', async () => {
    const server = newServer()
    const a = await openDevice({ server })
    await a.client.mutate('logs.add@1', { log: logArgs({ id: 'old' }) })
    await sync(a)
    await a.client.mutate('logs.add@1', { log: logArgs({ id: 'pend' }) }) // 還沒送
    // 模擬從備份還原：伺服器換 epoch，並且少了一筆資料（還原到更早的狀態）
    server.db.tables.logs.delete('old')
    server.meta.epoch = 'e2'
    await a.client.pullOnce()
    expect(await a.client.db.getMeta('cookie', '')).toMatch(/^e2:/)
    expect((await viewOf(a, 'logs')).map((l) => l.id)).toEqual(['pend'])
    expect(await a.client.db.srv('logs').count()).toBe(0)
    expect(await a.client.db.pending.count()).toBe(1)
    await expectConsistent(a)
  })
})

describe('試用模式', () => {
  it('mutate 同時寫 srv 和畫面表，不進 pending、不配 mutationId、永遠不 push', async () => {
    const server = newServer()
    const t = await openDevice({ server, userId: null })
    expect(t.client.mode).toBe('trial')
    expect(t.client.db.name).toBe('food-log-local')
    expect(t.client.getStatus().phase).toBe('local')
    await t.client.mutate('logs.add@1', { log: logArgs({ id: 'trial-1' }) })
    expect(await t.client.db.srv('logs').count()).toBe(1)
    expect(await t.client.db.view('logs').count()).toBe(1)
    expect(await t.client.db.pending.count()).toBe(0)
    expect(await t.client.db.getMeta('nextMutationId', 0)).toBe(1)
    await t.client.syncNow()
    t.client.start()
    await expect(t.client.pushOnce()).rejects.toThrow(/試用/)
    expect(t.transport.pushCalls + t.transport.pullCalls).toBe(0)
    expect(serverRows(server, 'logs')).toHaveLength(0)
    expect(await checkViewInvariant(t.client.db)).toBeNull()
  })

  it('登入不會上傳試用資料：帳號資料庫是另一個，試用資料庫原封不動', async () => {
    const server = newServer()
    const t = await openDevice({ server, userId: null })
    await t.client.mutate('logs.add@1', { log: logArgs({ id: 'trial-1' }) })
    // 同一個瀏覽器（同一個 IDBFactory）登入
    const acct = await openDevice({ server, userId: USER, factory: t.factory })
    expect(acct.client.db.name).toBe(`food-log-${USER}`)
    await sync(acct)
    expect(serverRows(server, 'logs')).toHaveLength(0)
    expect(await viewOf(acct, 'logs')).toEqual([])
    expect(acct.transport.pushedIds).toEqual([])
    expect(await t.client.db.view('logs').count()).toBe(1)
  })
})

describe('狀態與傳輸錯誤', () => {
  it('401：pending 保留、畫面不變；sync 丟 AuthError；登入後可以繼續', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    d.transport.signedIn = false
    await d.client.syncNow()
    expect(d.client.getStatus()).toMatchObject({ phase: 'auth', error: 'unauthorized', pendingCount: 1 })
    expect(await d.client.db.pending.count()).toBe(1)
    expect(await liveViewOf(d, 'logs')).toHaveLength(1)
    expect(serverRows(server, 'logs')).toHaveLength(0)
    d.transport.signedIn = true
    d.client.resume()
    await d.client.whenIdle()
    expect(d.client.getStatus()).toMatchObject({ phase: 'idle', error: null, pendingCount: 0 })
    expect(serverRows(server, 'logs')).toHaveLength(1)
  })

  it('409 client_too_old：phase=too_old，pending 保留，resume 不會解除', async () => {
    const server = newServer()
    server.minClientVersion = 99
    const d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    await d.client.syncNow()
    expect(d.client.getStatus()).toMatchObject({ phase: 'too_old', error: 'client_too_old', pendingCount: 1 })
    d.client.resume()
    await d.client.whenIdle()
    expect(d.client.getStatus().phase).toBe('too_old')
  })

  it('status：pendingCount、hasServerData、lastPullAt', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    expect(d.client.getStatus()).toEqual({ phase: 'idle', pendingCount: 0, failed: 0, lastPullAt: null, error: null, hasServerData: false })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    expect(d.client.getStatus().pendingCount).toBe(1)
    await d.client.syncNow()
    expect(d.client.getStatus()).toMatchObject({ phase: 'idle', pendingCount: 0, hasServerData: true, lastPullAt: expect.any(Number) as number })
  })
})
