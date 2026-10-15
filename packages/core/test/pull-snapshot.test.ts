// pull 的快速路徑（UserStore.pullSnapshot，選用）：結果必須和逐一讀取完全相同，而且讀取次數更少。
import { describe, expect, test } from 'vitest'
import type { PullQuery, PullResponse } from '../src/protocol/pull'
import { itemArgs, storeArgs, weightArgs } from '../src/testing'
import type { MemoryServer, ReadOp } from '../src/testing'
import { newServer } from './helpers'

/** 同一組資料建兩次：一個走逐一讀取，一個走 pullSnapshot。 */
async function scenario(snapshot: boolean, pageRows?: number): Promise<MemoryServer> {
  const s = newServer()
  s.snapshotPull = snapshot
  s.pageRows = pageRows
  await s.mutate('stores.upsert@1', storeArgs({ id: 's:1' }))
  await s.mutate('items.upsert@1', itemArgs({ id: 'u:a', store_id: 's:1' }))
  await s.mutate('items.upsert@1', itemArgs({ id: 'u:b', store_id: 's:1' }))
  await s.mutate('stores.delete@1', { id: 's:1' }) // 一個版本 3 列
  for (let i = 0; i < 6; i++) await s.mutate('weights.upsert@1', weightArgs({ id: `w${i}`, day: `2026-10-0${i + 1}`, ts: `2026-10-0${i + 1}T08:00:00+08:00`, kg: 70 + i }))
  await s.push({ clientId: 'c', mutations: [{ id: 50, name: 'logs.restore@1', args: { id: 'nope' }, clientTs: 0 }] }) // 業務錯誤
  return s
}

async function pullAll(s: MemoryServer, from: string, extra: Partial<PullQuery> = {}): Promise<PullResponse[]> {
  const pages: PullResponse[] = []
  let cookie = from
  for (let i = 0; i < 30; i++) {
    const p = await s.pull({ clientId: 'c', cookie, ...extra })
    pages.push(p)
    cookie = p.cookie
    if (!p.more) break
  }
  return pages
}

const COOKIES = ['', '0', 'garbage', 'e1:0', 'e1:3', 'e1:6', 'e1:10', 'e1:99', 'e2:2']

describe('pullSnapshot 和逐一讀取給出相同的回應', () => {
  for (const pageRows of [undefined, 3, 2, 1]) {
    test.each(COOKIES)(`pageRows=${pageRows ?? '預設'}，cookie=%j（含 reset、比伺服器新、epoch 不同）`, async (from) => {
      const a = await scenario(false, pageRows)
      const b = await scenario(true, pageRows)
      expect(await pullAll(b, from, { afterMutationId: 0 })).toEqual(await pullAll(a, from, { afterMutationId: 0 }))
      expect(await pullAll(b, from, { afterMutationId: 50 })).toEqual(await pullAll(a, from, { afterMutationId: 50 }))
    })
  }

  test('epoch 不同：reset，從頭送，之後的頁不再 reset', async () => {
    const s = await scenario(true, 3)
    s.db.epoch = 'e2'
    const pages = await pullAll(s, 'e1:4')
    expect(pages[0]!.reset).toBe(true)
    expect(pages.slice(1).every((p) => !p.reset)).toBe(true)
    expect(pages.flatMap((p) => p.changes.weights)).toHaveLength(6)
  })
})

describe('pullSnapshot 的讀取次數', () => {
  async function reads(s: MemoryServer, query: Partial<PullQuery> & { clientId: string }): Promise<ReadOp[]> {
    const ops: ReadOp[] = []
    s.afterRead = (op) => {
      ops.push(op)
    }
    await s.pull(query)
    s.afterRead = undefined
    return ops
  }

  test('一般 pull 只有一次 pullSnapshot；逐一讀取要 4 次', async () => {
    const fast = await scenario(true)
    expect(await reads(fast, { clientId: 'c', cookie: 'e1:2' })).toEqual(['pullSnapshot'])
    const slow = await scenario(false)
    expect(await reads(slow, { clientId: 'c', cookie: 'e1:2' })).toEqual(['getLastMutationId', 'listErrors', 'readMeta', 'rowsAfter'])
  })

  test('reset 才多一次 rowsAfter(0)', async () => {
    const s = await scenario(true)
    expect(await reads(s, { clientId: 'c', cookie: 'e1:99' })).toEqual(['pullSnapshot', 'rowsAfter'])
  })
})

describe('pullSnapshot 保留「cursor 先於列」的保證', () => {
  test('push 在快照之後提交：這一輪不宣稱它，下一輪就看到；之前提交：同一個回應宣稱也帶著列', async () => {
    const s = newServer()
    s.snapshotPull = true
    let fired = false
    s.afterRead = async (op) => {
      if (op !== 'pullSnapshot' || fired) return
      fired = true
      s.afterRead = undefined
      await s.push({ clientId: 'c1', mutations: [{ id: 1, name: 'weights.upsert@1', args: weightArgs({ id: 'wp' }), clientTs: 0 }] })
    }
    const p = await s.pull({ clientId: 'c1' })
    expect(fired).toBe(true)
    expect(p.lastMutationId).toBe(0)
    expect(p.changes.weights).toEqual([])
    const next = await s.pull({ clientId: 'c1', cookie: p.cookie })
    expect(next.lastMutationId).toBe(1)
    expect(next.changes.weights.map((w) => w.id)).toEqual(['wp'])
    await s.mutate('weights.upsert@1', weightArgs({ id: 'w2', day: '2026-10-05', ts: '2026-10-05T08:00:00+08:00' }))
    const both = await s.pull({ clientId: 'mem-app' })
    expect(both.lastMutationId).toBe(1)
    expect(both.changes.weights.map((w) => w.id).sort()).toEqual(['w2', 'wp'])
  })

  test('錯誤只回 <= lastMutationId 的', async () => {
    const s = newServer()
    s.snapshotPull = true
    await s.push({ clientId: 'c1', mutations: [{ id: 1, name: 'logs.restore@1', args: { id: 'nope' }, clientTs: 0 }] })
    const p = await s.pull({ clientId: 'c1' })
    expect(p.lastMutationId).toBe(1)
    expect(p.errors.map((e) => e.error)).toEqual(['not_found'])
  })
})
