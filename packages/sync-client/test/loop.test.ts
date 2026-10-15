import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACKOFF_MS, FOREGROUND_INTERVAL_MS, SyncLoop } from '../src/loop'
import { StatusStore } from '../src/status'
import { HttpError, NetworkError } from '../src/transport'
import { FakeLoopEnv, logArgs, newServer, openDevice, serverRows } from './helpers'
import type { Device } from './helpers'

// 只假造計時器；fake-indexeddb 用 setImmediate 排程，不能假造。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
})

async function setup() {
  const server = newServer()
  const env = new FakeLoopEnv()
  const d = await openDevice({ server, loopEnv: env })
  return { server, env, d }
}

const settle = (d: Device) => d.client.whenIdle()

describe('loop 觸發時機', () => {
  it('start：立刻 push + pull 一次', async () => {
    const { d, server } = await setup()
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) }) // 還沒 start：不會自動 push
    expect(d.transport.pushCalls).toBe(0)
    d.client.start()
    await settle(d)
    expect(d.transport.pushCalls).toBe(1)
    expect(d.transport.pullCalls).toBe(1)
    expect(serverRows(server, 'logs')).toHaveLength(1)
    expect(d.client.getStatus().phase).toBe('idle')
    d.client.stop()
  })

  it('每次 mutate 之後 push', async () => {
    const { d, server } = await setup()
    d.client.start()
    await settle(d)
    const before = d.transport.pushCalls
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    await settle(d)
    expect(d.transport.pushCalls).toBe(before + 1)
    expect(serverRows(server, 'logs')).toHaveLength(1)
    d.client.stop()
  })

  it('visibilitychange 變 visible、online 都觸發同步', async () => {
    const { d, env } = await setup()
    d.client.start()
    await settle(d)
    const p0 = d.transport.pullCalls
    env.fireVisible()
    await settle(d)
    expect(d.transport.pullCalls).toBe(p0 + 1)
    env.fireOnline()
    await settle(d)
    expect(d.transport.pullCalls).toBe(p0 + 2)
    d.client.stop()
  })

  it('前景時每 60 秒一次；背景（不可見）時不跑', async () => {
    const { d, env } = await setup()
    d.client.start()
    await settle(d)
    const p0 = d.transport.pullCalls
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS - 1)
    await settle(d)
    expect(d.transport.pullCalls).toBe(p0)
    await vi.advanceTimersByTimeAsync(1)
    await settle(d)
    expect(d.transport.pullCalls).toBe(p0 + 1)
    env.visible = false
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 3)
    await settle(d)
    expect(d.transport.pullCalls).toBe(p0 + 1)
    env.visible = true
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS)
    await settle(d)
    expect(d.transport.pullCalls).toBe(p0 + 2)
    d.client.stop()
  })

  it('stop：解除所有監聽與計時器', async () => {
    const { d, env } = await setup()
    d.client.start()
    await settle(d)
    expect(env.listeners()).toBe(2)
    d.client.stop()
    expect(env.listeners()).toBe(0)
    const p0 = d.transport.pullCalls
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 2)
    env.fireOnline()
    await settle(d)
    expect(d.transport.pullCalls).toBe(p0)
  })

  it('同步中又被觸發：不會平行跑兩個循環', async () => {
    const { d } = await setup()
    let inFlight = 0
    let maxInFlight = 0
    const realPush = d.transport.push.bind(d.transport)
    d.transport.push = async (req) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      try {
        return await realPush(req)
      } finally {
        inFlight--
      }
    }
    d.client.start()
    await Promise.all(Array.from({ length: 5 }, (_, i) => d.client.mutate('logs.add@1', { log: logArgs({ id: `l${i}` }) })))
    await settle(d)
    expect(maxInFlight).toBe(1)
    expect(await d.client.db.pending.count()).toBe(0)
    d.client.stop()
  })
})

describe('loop 退避', () => {
  it('網路失敗：2、5、15 秒各重試一次，之後不再排程；下一個觸發時機重新開始一輪', async () => {
    expect(BACKOFF_MS).toEqual([2000, 5000, 15000])
    const { d, env, server } = await setup()
    d.transport.online = false
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    d.client.start()
    await settle(d)
    expect(d.transport.pushCalls).toBe(1)
    expect(d.client.getStatus()).toMatchObject({ phase: 'offline', error: 'NET-0', pendingCount: 1 })

    await vi.advanceTimersByTimeAsync(1999)
    expect(d.transport.pushCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle(d)
    expect(d.transport.pushCalls).toBe(2)

    await vi.advanceTimersByTimeAsync(4999)
    expect(d.transport.pushCalls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await settle(d)
    expect(d.transport.pushCalls).toBe(3)

    await vi.advanceTimersByTimeAsync(14999)
    expect(d.transport.pushCalls).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    await settle(d)
    expect(d.transport.pushCalls).toBe(4)

    // 三次都失敗：不再排程，等下一個觸發時機（這裡 59 秒內不會有任何請求；60 秒的 interval 才會）
    await vi.advanceTimersByTimeAsync(30_000)
    await settle(d)
    expect(d.transport.pushCalls).toBe(4)

    // 恢復連線：online 事件觸發
    d.transport.online = true
    env.fireOnline()
    await settle(d)
    expect(d.client.getStatus()).toMatchObject({ phase: 'idle', error: null, pendingCount: 0 })
    expect(serverRows(server, 'logs')).toHaveLength(1)
    d.client.stop()
  })

  it('放棄之後被觸發：失敗次數歸零，重新走 2、5、15', async () => {
    const { d, env } = await setup()
    d.transport.online = false
    d.client.start()
    await settle(d)
    for (const ms of BACKOFF_MS) {
      await vi.advanceTimersByTimeAsync(ms) // 每次重試的下一個計時器要等這次循環（真實的 IDB）跑完才會排
      await settle(d)
    }
    const calls = d.transport.pullCalls + d.transport.pushCalls
    env.fireOnline() // 新的一輪
    await settle(d)
    const afterTrigger = d.transport.pullCalls + d.transport.pushCalls
    expect(afterTrigger).toBeGreaterThan(calls)
    await vi.advanceTimersByTimeAsync(2000)
    await settle(d)
    expect(d.transport.pullCalls + d.transport.pushCalls).toBeGreaterThan(afterTrigger) // 2 秒後又重試
    d.client.stop()
  })

  it('5xx 也退避重試（phase=error，API-503）；重試成功就回到 idle', async () => {
    const { d, server } = await setup()
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    let failNext = 2
    const realPush = d.transport.push.bind(d.transport)
    d.transport.push = async (req) => {
      if (failNext-- > 0) throw new HttpError(503)
      return realPush(req)
    }
    d.client.start()
    await settle(d)
    expect(d.client.getStatus()).toMatchObject({ phase: 'error', error: 'API-503' })
    await vi.advanceTimersByTimeAsync(2000)
    await settle(d)
    expect(d.client.getStatus()).toMatchObject({ phase: 'error', error: 'API-503' })
    await vi.advanceTimersByTimeAsync(5000)
    await settle(d)
    expect(d.client.getStatus()).toMatchObject({ phase: 'idle', error: null, pendingCount: 0 })
    expect(serverRows(server, 'logs')).toHaveLength(1)
    d.client.stop()
  })

  it('4xx（非 401／409）不重試', async () => {
    const { d } = await setup()
    d.transport.pull = async () => {
      throw new HttpError(400)
    }
    d.client.start()
    await settle(d)
    expect(d.client.getStatus()).toMatchObject({ phase: 'error', error: 'API-400' })
    const calls = d.transport.pushCalls
    await vi.advanceTimersByTimeAsync(30_000)
    await settle(d)
    expect(d.transport.pushCalls).toBe(calls)
    d.client.stop()
  })

  it('401：進入 auth 狀態、pending 保留、之後的自動觸發都不再打 API，直到 resume', async () => {
    const { d, env, server } = await setup()
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l1' }) })
    d.transport.signedIn = false
    d.client.start()
    await settle(d)
    expect(d.client.getStatus()).toMatchObject({ phase: 'auth', error: 'unauthorized', pendingCount: 1 })
    const calls = d.transport.pushCalls
    await vi.advanceTimersByTimeAsync(FOREGROUND_INTERVAL_MS * 2)
    env.fireOnline()
    env.fireVisible()
    await d.client.mutate('logs.add@1', { log: logArgs({ id: 'l2' }) })
    await settle(d)
    expect(d.transport.pushCalls).toBe(calls)
    expect(await d.client.db.pending.count()).toBe(2)
    expect(serverRows(server, 'logs')).toHaveLength(0)

    d.transport.signedIn = true
    d.client.resume()
    await settle(d)
    expect(d.client.getStatus()).toMatchObject({ phase: 'idle', pendingCount: 0 })
    expect(serverRows(server, 'logs')).toHaveLength(2)
    d.client.stop()
  })
})

describe('SyncLoop 單元（不經過 Dexie）', () => {
  it('未知錯誤也走退避；NetworkError → offline', async () => {
    const status = new StatusStore()
    let n = 0
    const loop = new SyncLoop({
      status,
      env: new FakeLoopEnv(),
      cycle: async () => {
        n++
        if (n === 1) throw new NetworkError()
        if (n === 2) throw new Error('boom')
      },
    })
    loop.start()
    await loop.whenIdle()
    expect(status.getSnapshot()).toMatchObject({ phase: 'offline', error: 'NET-0' })
    await vi.advanceTimersByTimeAsync(2000)
    await loop.whenIdle()
    expect(status.getSnapshot()).toMatchObject({ phase: 'error', error: 'boom' })
    await vi.advanceTimersByTimeAsync(5000)
    await loop.whenIdle()
    expect(status.getSnapshot()).toMatchObject({ phase: 'idle', error: null })
    expect(n).toBe(3)
    loop.stop()
  })
})
