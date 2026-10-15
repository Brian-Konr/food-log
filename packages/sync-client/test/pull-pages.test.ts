// 多頁 pull（計畫 §3.5）：中間頁只動 srv_*、存 cookie；畫面表和 pending 的重播留到最後一頁，整輪只做一次。
import { describe, expect, it, vi } from 'vitest'
import { NetworkError } from '../src/transport'
import type { PullQuery } from '@food-log/core'
import { checkViewInvariant } from '../src/testing'
import { newServer, logArgs, openDevice, restartDevice, sync, viewOf } from './helpers'

vi.mock('../src/local-tx', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/local-tx')>()
  return { ...m, runLocal: vi.fn(m.runLocal) }
})
const { runLocal } = await import('../src/local-tx')
const replays = vi.mocked(runLocal)

const ids = async (d: Awaited<ReturnType<typeof openDevice>>) => (await viewOf(d, 'logs')).map((l) => l.id).sort()

describe('多頁 pull', () => {
  it('3 頁 reset，待送的 logs.update 指向第 3 頁才到的列：畫面全程不空、不寫任何 failed、整輪只重播一次', async () => {
    const server = newServer()
    server.pageRows = 2
    const d = await openDevice({ server })
    for (let i = 0; i < 6; i++) await d.client.mutate('logs.add@1', { log: logArgs({ id: `l${i}`, qty: 1 }) })
    await sync(d)
    expect(await ids(d)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'l5'])
    await d.client.mutate('logs.update@1', { id: 'l5', patch: { qty: 3 } }) // 還沒送；l5 是版本最大的列 → reset 時在最後一頁
    // 從備份還原：換 epoch，l0 在還原後的伺服器上不存在
    server.db.tables.logs.delete('l0')
    server.meta.epoch = 'e2'

    let failedWritten = 0
    d.client.db.failed.hook('creating', () => {
      failedWritten++
    })
    const snapshots: { page: number; ids: string[]; failed: number; srv: number; l5qty: number | undefined }[] = []
    const realPull = d.transport.pull.bind(d.transport)
    let page = 0
    d.transport.pull = async (q: PullQuery) => {
      snapshots.push({
        page,
        ids: await ids(d),
        failed: await d.client.db.failed.count(),
        srv: await d.client.db.srv('logs').count(),
        l5qty: (await d.client.db.view('logs').get('l5'))?.qty,
      })
      page++
      return realPull(q)
    }
    replays.mockClear()
    await d.client.pullOnce()

    expect(page).toBe(3)
    // 第 1 頁之前：舊資料；第 2、3 頁之前（= 第 1、2 頁之後）：srv 只收了一部分，畫面還是舊的、沒有失敗
    expect(snapshots.map((s) => s.srv)).toEqual([6, 2, 4])
    for (const s of snapshots) {
      expect(s.ids, `第 ${s.page + 1} 頁之前畫面不能變`).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'l5'])
      expect(s.failed).toBe(0)
      expect(s.l5qty).toBe(3)
    }
    expect(failedWritten).toBe(0)
    expect(await d.client.db.failed.count()).toBe(0)
    // 整輪 pull 只重播一次（1 筆 pending），不是每頁一次
    expect(replays).toHaveBeenCalledTimes(1)
    // 最後：畫面 = srv（l0 沒了）+ pending（l5.qty=3）
    expect(await ids(d)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5'])
    expect((await d.client.db.view('logs').get('l5'))!.qty).toBe(3)
    expect((await d.client.db.srv('logs').get('l5'))!.qty).toBe(1)
    expect(await d.client.db.pending.count()).toBe(1)
    expect(await d.client.db.getMeta('pullRun', null)).toBeNull()
    expect(await d.client.db.getMeta('cookie', '')).toBe(`e2:${server.meta.version}`)
    expect(await checkViewInvariant(d.client.db)).toBeNull()

    // 之後 push 成功，伺服器收到更新，pending 清空
    await sync(d)
    expect(server.db.tables.logs.get('l5')!.qty).toBe(3)
    expect(await d.client.db.pending.count()).toBe(0)
    expect(await d.client.db.failed.count()).toBe(0)
  })

  it('單頁 pull 也只重播一次；沒有 pending 就不重播', async () => {
    const server = newServer()
    const d = await openDevice({ server })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'a' }) })
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'b' }) })
    replays.mockClear()
    await d.client.pullOnce() // 伺服器什麼都沒有，pending 兩筆（還沒 push）
    expect(replays).toHaveBeenCalledTimes(2)
    await sync(d)
    replays.mockClear()
    await d.client.pullOnce()
    expect(replays).toHaveBeenCalledTimes(0)
  })

  it('中途斷線、App 重啟：下一次 pull 從 cookie 接著拉，前面頁收到的列最後一定進畫面', async () => {
    const server = newServer()
    server.pageRows = 2
    const writer = await openDevice({ server })
    for (let i = 0; i < 5; i++) await writer.client.mutate('logs.add@1', { log: logArgs({ id: `l${i}` }) })
    await sync(writer)

    const d = await openDevice({ server })
    const realPull = d.transport.pull.bind(d.transport)
    let calls = 0
    d.transport.pull = async (q: PullQuery) => {
      if (++calls === 2) throw new NetworkError('dropped mid-pull')
      return realPull(q)
    }
    await expect(d.client.pullOnce()).rejects.toBeInstanceOf(NetworkError)
    // 第 1 頁已經進 srv、cookie 已存；畫面還沒動
    expect(await d.client.db.srv('logs').count()).toBe(2)
    expect(await ids(d)).toEqual([])
    expect(await d.client.db.getMeta('pullRun', null)).not.toBeNull()
    expect(await checkViewInvariant(d.client.db)).toBeNull() // pull 進行中不檢查

    const d2 = await restartDevice(d, { server })
    d2.transport.pull = realPull
    await d2.client.pullOnce()
    expect(d2.transport.pullCalls).toBeGreaterThan(0)
    expect(await ids(d2)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4'])
    expect(await d2.client.db.getMeta('pullRun', null)).toBeNull()
    expect(await checkViewInvariant(d2.client.db)).toBeNull()
  })

  it('pull 進行中又 mutate：畫面立刻有，最後一頁重建後仍是 srv + pending', async () => {
    const server = newServer()
    server.pageRows = 2
    const writer = await openDevice({ server })
    for (let i = 0; i < 5; i++) await writer.client.mutate('logs.add@1', { log: logArgs({ id: `l${i}` }) })
    await sync(writer)
    const d = await openDevice({ server })
    const realPull = d.transport.pull.bind(d.transport)
    let calls = 0
    d.transport.pull = async (q: PullQuery) => {
      if (++calls === 2) await d.client.mutate('logs.add@1', { log: logArgs({ id: 'mine' }) }) // 第 1 頁之後、第 2 頁之前
      return realPull(q)
    }
    await d.client.pullOnce()
    expect(await ids(d)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'mine'])
    expect(await d.client.db.pending.count()).toBe(1)
    expect(await d.client.db.failed.count()).toBe(0)
    expect(await checkViewInvariant(d.client.db)).toBeNull()
  })
})
