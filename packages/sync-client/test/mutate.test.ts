import { MutationError } from '@food-log/core'
import { describe, expect, it } from 'vitest'
import { TEST_NOW, newServer, logArgs, openDevice, storeArgs, viewOf, weightArgs } from './helpers'

describe('mutate（本機優先）', () => {
  it('成功：寫畫面表、配 mutationId、寫進 pending（含 touched）、回傳 mutator 的結果', async () => {
    const d = await openDevice({ server: newServer() })
    const res = await d.client.mutate('logs.add@1', { log: logArgs({ id: 'a' }) })
    expect(res).toEqual({ rowId: 'a' })
    const logs = await viewOf(d, 'logs')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ id: 'a', user_id: 'user-1', version: 0, deleted_at: null })
    const pending = await d.client.db.pending.toArray()
    expect(pending).toEqual([{ mutationId: 1, name: 'logs.add@1', args: JSON.parse(JSON.stringify({ log: logArgs({ id: 'a' }) })), clientTs: TEST_NOW, touched: ['logs:a'] }])
    expect(await d.client.db.getMeta('nextMutationId', 0)).toBe(2)
    expect(d.client.getStatus().pendingCount).toBe(1)
    // 沒有 srv：伺服器還沒確認
    expect(await d.client.db.srv('logs').count()).toBe(0)
  })

  it('MutationError：什麼都不寫（連 mutationId 都不配），原樣丟出', async () => {
    const d = await openDevice({ server: newServer() })
    await expect(d.client.mutate('weights.upsert@1', weightArgs({ kg: 10 }))).rejects.toBeInstanceOf(MutationError)
    await expect(d.client.mutate('weights.upsert@1', weightArgs({ kg: 10 }))).rejects.toMatchObject({ code: 'bad_record' })
    expect(await viewOf(d, 'weights')).toEqual([])
    expect(await d.client.db.pending.count()).toBe(0)
    expect(await d.client.db.getMeta('nextMutationId', 0)).toBe(1)
  })

  it('本機就能擋：店名重複回 duplicate_name（取代 App.findDup）', async () => {
    const d = await openDevice({ server: newServer() })
    await d.client.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '阿財牛肉麵' }))
    const err = await d.client.mutate('stores.upsert@1', storeArgs({ id: 's:2', name: ' 阿財牛肉麵 ' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MutationError)
    expect(err).toMatchObject({ code: 'duplicate_name', details: { existingId: 's:1' } })
    expect(await d.client.db.pending.count()).toBe(1)
  })

  it('不認得的 mutation、參數形狀不對都是 bad_record，不進佇列', async () => {
    const d = await openDevice({ server: newServer() })
    await expect(d.client.mutate('nope.nope@1' as never, {} as never)).rejects.toMatchObject({ code: 'bad_record' })
    await expect(d.client.mutate('logs.delete@1', { id: 5 } as never)).rejects.toMatchObject({ code: 'bad_record' })
    expect(await d.client.db.pending.count()).toBe(0)
  })

  it('沒有寫入的 mutation（ignored）也進佇列：本機看到不存在，伺服器要自己再判斷', async () => {
    const d = await openDevice({ server: newServer() })
    expect(await d.client.mutate('logs.delete@1', { id: 'ghost' })).toEqual({ ignored: 'missing' })
    const p = await d.client.db.pending.toArray()
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ mutationId: 1, name: 'logs.delete@1', touched: [] })
  })

  it('同一天體重寫兩次：第二次在本機覆寫第一筆（和伺服器一致），touched 只有被寫的那列', async () => {
    const d = await openDevice({ server: newServer() })
    await d.client.mutate('weights.upsert@1', weightArgs({ id: 'w1', kg: 70 }))
    const r = await d.client.mutate('weights.upsert@1', weightArgs({ id: 'w2', kg: 69.5 }))
    expect(r).toMatchObject({ overwritten: true, prevKg: 70, rowId: 'w1' })
    expect((await viewOf(d, 'weights')).map((w) => [w.id, w.kg])).toEqual([['w1', 69.5]])
    expect((await d.client.db.pending.toArray()).map((p) => p.touched)).toEqual([['weights:w1'], ['weights:w1']])
  })

  it('config 是外部主鍵的單列表；config.set 會建立預設列再覆蓋', async () => {
    const d = await openDevice({ server: newServer() })
    await d.client.mutate('config.set@1', { key: 'target_kcal', value: 1800 })
    const rows = await viewOf(d, 'config')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ target_kcal: 1800, target_protein: 150 })
    expect((await d.client.db.pending.toArray())[0]!.touched).toEqual(['config:config'])
  })

  it('寫入內容是 JSON 化之後的參數（undefined 欄位消失），本機與伺服器看到同一份', async () => {
    const d = await openDevice({ server: newServer() })
    await d.client.mutate('logs.delete@1', { id: 'x', extra: undefined } as never)
    expect((await d.client.db.pending.toArray())[0]!.args).toEqual({ id: 'x' })
  })
})
