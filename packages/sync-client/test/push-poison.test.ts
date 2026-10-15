// 毒藥 mutation：/sync/push 對某一筆永遠回 4xx（非 401／409）時，不能卡死整個佇列。
// 二分：一筆一筆重送，還是 4xx 的那筆移到 failed（bad_request）並從 pending 移除，其餘繼續。
import type { PushMutation } from '@food-log/core'
import { describe, expect, it } from 'vitest'
import { checkViewInvariant } from '../src/testing'
import { newServer, logArgs, openDevice, serverRows, sync, viewOf } from './helpers'

const logId = (m: PushMutation): string | undefined => (m.args as { log?: { id?: string }; id?: string } | undefined)?.log?.id ?? (m.args as { id?: string } | undefined)?.id
const rejectLog = (bad: string, status = 400, message = '壞掉的請求') => (m: PushMutation) => (logId(m) === bad ? { status, message } : null)

describe('push：毒藥 mutation（4xx）', () => {
  it('一批 5 筆，第 3 筆被 400 拒絕：其餘 4 筆生效，毒藥進 failed、離開 pending，畫面退回，佇列不卡', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    for (const id of ['a', 'b', 'bad', 'd', 'e']) await d.client.mutate('logs.add@1', { log: logArgs({ id }) })
    d.transport.rejectMutation = rejectLog('bad')

    await d.client.pushOnce() // 不丟錯

    // 整批被拒 1 次，之後一筆一筆送（毒藥那筆也被拒一次）
    expect(d.transport.rejectedIds).toEqual([[1, 2, 3, 4, 5], [3]])
    expect(d.transport.pushedIds).toEqual([[1], [2], [4], [5]])
    expect(serverRows(server, 'logs').map((l) => l.id).sort()).toEqual(['a', 'b', 'd', 'e'])

    const failed = await d.client.failedRows()
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ mutationId: 3, name: 'logs.add@1', error: 'bad_request', message: '壞掉的請求', source: 'server' })
    expect((failed[0]!.args as { log: { id: string } }).log.id).toBe('bad')
    expect((await d.client.db.pending.toArray()).map((p) => p.mutationId)).toEqual([1, 2, 4, 5]) // 毒藥離開了；其餘等 pull 確認
    expect((await viewOf(d, 'logs')).map((l) => l.id).sort()).toEqual(['a', 'b', 'd', 'e']) // 毒藥寫的列退回
    expect(await checkViewInvariant(d.client.db)).toBeNull()
    expect(d.client.getStatus()).toMatchObject({ pendingCount: 4, failed: 1 })

    // 之後不會再送毒藥；pull 確認後佇列清空
    const rejected = d.transport.rejectedIds.length
    await sync(d)
    expect(d.transport.rejectedIds.length).toBe(rejected)
    expect(await d.client.db.pending.count()).toBe(0)
    expect(await d.client.db.failed.count()).toBe(1)
    expect(await checkViewInvariant(d.client.db)).toBeNull()
  })

  it('單獨一筆就是毒藥：不用再重送，直接進 failed；後面的批次照常', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'bad' }) })
    d.transport.rejectMutation = rejectLog('bad', 422, 'nope')
    await d.client.pushOnce()
    expect(d.transport.rejectedIds).toEqual([[1]])
    expect(await d.client.db.pending.count()).toBe(0)
    expect((await d.client.failedRows())[0]).toMatchObject({ mutationId: 1, error: 'bad_request', message: 'nope', details: { status: 422 } })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'ok' }) })
    await sync(d)
    expect(serverRows(server, 'logs').map((l) => l.id)).toEqual(['ok'])
    expect(await checkViewInvariant(d.client.db)).toBeNull()
  })

  it('毒藥之後依賴它的 mutation：照常送，伺服器自己回業務錯誤（沒有卡死）', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'bad' }) })
    await d.client.mutate('logs.update@1', { id: 'bad', patch: { qty: 2 } })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'ok' }) })
    d.transport.rejectMutation = (m) => (m.name === 'logs.add@1' && logId(m) === 'bad' ? { status: 400, message: 'bad' } : null)
    await sync(d)
    expect(serverRows(server, 'logs').map((l) => l.id)).toEqual(['ok'])
    const failed = await d.client.failedRows()
    expect(failed.map((f) => [f.mutationId, f.error, f.source])).toEqual([
      [1, 'bad_request', 'server'],
      [2, 'not_found', 'server'],
    ])
    expect(await d.client.db.pending.count()).toBe(0)
    expect((await viewOf(d, 'logs')).map((l) => l.id)).toEqual(['ok'])
    expect(await checkViewInvariant(d.client.db)).toBeNull()
  })

  it('自動同步循環：毒藥不會讓狀態卡在 error，也不重試', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    for (const id of ['a', 'bad', 'c']) await d.client.mutate('logs.add@1', { log: logArgs({ id }) })
    d.transport.rejectMutation = rejectLog('bad')
    await d.client.syncNow()
    expect(d.client.getStatus()).toMatchObject({ phase: 'idle', pendingCount: 0, failed: 1 })
    expect(serverRows(server, 'logs').map((l) => l.id).sort()).toEqual(['a', 'c'])
  })

  it('401／409／429／5xx 不是毒藥：不二分、不丟 pending', async () => {
    for (const status of [429, 408, 409, 500, 503]) {
      const server = newServer()
      const d = await openDevice({ server })
      for (const id of ['a', 'bad']) await d.client.mutate('logs.add@1', { log: logArgs({ id }) })
      d.transport.rejectMutation = rejectLog('bad', status)
      await expect(d.client.pushOnce()).rejects.toMatchObject({ name: 'HttpError', status })
      expect(d.transport.rejectedIds, `status ${status}`).toEqual([[1, 2]])
      expect(await d.client.db.pending.count()).toBe(2)
      expect(await d.client.db.failed.count()).toBe(0)
    }
    const server = newServer()
    const d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'a' }) })
    d.transport.signedIn = false
    await expect(d.client.pushOnce()).rejects.toMatchObject({ name: 'AuthError' })
    expect(await d.client.db.pending.count()).toBe(1)
  })

  it('二分中途斷網：已處理的不重送，剩下的下次繼續', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    for (const id of ['a', 'b', 'bad', 'd']) await d.client.mutate('logs.add@1', { log: logArgs({ id }) })
    let calls = 0
    d.transport.rejectMutation = (m) => {
      if (logId(m) === 'bad') return { status: 400, message: 'bad' }
      return null
    }
    const realPush = d.transport.push.bind(d.transport)
    d.transport.push = async (req) => {
      if (++calls === 4) d.transport.online = false // 整批(1) a(2) b(3) → bad(4) 時斷網
      return realPush(req)
    }
    await expect(d.client.pushOnce()).rejects.toMatchObject({ name: 'NetworkError' })
    d.transport.online = true
    d.transport.push = realPush
    await d.client.pushOnce()
    await d.client.pullOnce()
    expect(serverRows(server, 'logs').map((l) => l.id).sort()).toEqual(['a', 'b', 'd'])
    expect((await d.client.failedRows()).map((f) => f.mutationId)).toEqual([3])
    expect(await d.client.db.pending.count()).toBe(0)
    expect(await checkViewInvariant(d.client.db)).toBeNull()
  })
})
