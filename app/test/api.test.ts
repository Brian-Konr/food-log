import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createApi } from '@/api'
import { createMockAdapter } from '@/api/mock'
import { createGasAdapter } from '@/api/gas'
import { NetworkError } from '@/api/errors'
import type { Op } from '@/api/types'
import { memoryStorage } from './helpers'
import { taipeiDay, taipeiIso } from '@/lib/day'

afterEach(() => {
  vi.useRealTimers()
})

const NOW = Date.parse('2026-10-10T18:00:00+08:00')
const day = taipeiDay(new Date(NOW))
const ts = taipeiIso(NOW)

async function setup() {
  const storage = memoryStorage()
  const mock = createMockAdapter({ storage, now: () => NOW })
  const api = createApi({ adapter: mock, storage, now: () => NOW })
  await api.ready
  return { storage, mock, api }
}

const logFields = { ts, day, item_id: 'fm:1', name: '雞胸', src: '全家' as const, qty: 1, grams: null, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3, deleted: false, updated_at: ts, source: 'app' as const, store: '' }

test('本機試用起始是空資料', async () => {
  const { api } = await setup()
  const d = await api.load()
  assert.equal(d.logs.length, 0)
  assert.equal(d.weights.length, 0)
  assert.equal(d.config.target_kcal, '2000')
})

test('離線寫入留在 outbox、順序送出、樂觀列有待上傳標記', async () => {
  const { api, mock } = await setup()
  mock.setOffline(true)
  await api.appendLog({ id: 'l1', ...logFields })
  assert.equal(api.peek()!.logs.find((r) => r.id === 'l1')?.__pending, true)
  assert.equal(api.status().pending, 1)
  assert.equal(api.status().online, true)
  mock.setOffline(false)
  assert.equal(await api.flush(), 1)
  assert.equal(api.status().pending, 0)
  assert.ok(!api.peek()!.logs.find((r) => r.id === 'l1')?.__pending)
})

test('永久錯誤移出、busy 留下', async () => {
  const { api } = await setup()
  await api.updateLog('no-such', { qty: 2 })
  assert.equal(api.status().failed[0].error, 'not_found')
  assert.equal(api.status().pending, 0)

  const storage = memoryStorage()
  let busy = true
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = { kind: 'test', call: (op: never) => (busy && (op as { action: string }).action !== 'read' ? Promise.resolve({ ok: false as const, error: 'busy' }) : inner.call(op)) }
  const api2 = createApi({ adapter, storage, now: () => NOW })
  await api2.appendLog({ id: 'l2', ...logFields })
  assert.equal(api2.status().pending, 1)
  busy = false
  await api2.flush()
  assert.equal(api2.status().pending, 0)
})

test('重複 id 不複製列', async () => {
  const { mock } = await setup()
  const rec = { id: 'dup', ...logFields }
  await mock.call({ action: 'append', table: 'Logs', record: rec })
  const again = await mock.call({ action: 'append', table: 'Logs', record: rec })
  assert.equal((again as { duplicate?: boolean }).duplicate, true)
  const d = await mock.call({ action: 'read' }) as { logs: { id: string }[] }
  assert.equal(d.logs.filter((r) => r.id === 'dup').length, 1)
})

test('Apps Script 介面卡：text/plain、密鑰只在 body', async () => {
  let seen: { url: string; init: RequestInit } | undefined
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen = { url, init: init! }
    return { ok: true, json: async () => ({ ok: true }) } as Response
  }
  const a = createGasAdapter({ url: 'https://script.google.com/macros/s/ABC/exec', secret: 's3cret-value-123456', fetchImpl: fetchImpl as unknown as typeof fetch })
  await a.call({ action: 'read' })
  assert.equal(seen!.init.method, 'POST')
  assert.equal((seen!.init.headers as Record<string, string>)['Content-Type'], 'text/plain;charset=utf-8')
  assert.ok(!seen!.url.includes('s3cret'))
  assert.equal(JSON.parse(String(seen!.init.body)).secret, 's3cret-value-123456')
})

async function afterGap(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

test('一次寫入失敗下次成功：第一次不出橫幅，2 秒後送出，後面間隔不再送', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  let writes = 0
  const adapter = {
    kind: 'test',
    call: (op: Op) => {
      if (op.action !== 'read') {
        writes += 1
        if (writes === 1) return Promise.reject(new NetworkError())
      }
      return inner.call(op)
    },
  }
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  await api.appendLog({ id: 'l-retry-ok', ...logFields })
  assert.equal(api.status().online, true)
  assert.equal(api.status().pending, 1)
  const row = api.peek()!.logs.find((r) => r.id === 'l-retry-ok')
  assert.equal(row?.__pending, true)
  assert.notEqual(row?.__write, 'failed')
  assert.equal(row?.__syncing, true)
  await afterGap(2000)
  assert.equal(api.status().pending, 0)
  assert.equal(api.status().online, true)
  assert.ok(!api.peek()!.logs.find((r) => r.id === 'l-retry-ok')?.__pending)
  const sent = writes
  await afterGap(20000)
  assert.equal(api.status().pending, 0)
  assert.equal(writes, sent)
})

test('三次排程都 NetworkError 才 online = false，record.id 四次相同', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const ids: string[] = []
  const adapter = {
    kind: 'test',
    call: (op: Op) => {
      if (op.action === 'read') return inner.call(op)
      if (op.action === 'append') ids.push(op.record.id)
      return Promise.reject(new NetworkError())
    },
  }
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  await api.appendLog({ id: 'l-net', ...logFields })
  assert.equal(api.status().online, true)
  await afterGap(2000)
  assert.equal(api.status().online, true)
  assert.equal(api.status().pending, 1)
  await afterGap(5000)
  assert.equal(api.status().online, true)
  await afterGap(15000)
  assert.equal(api.status().online, false)
  assert.equal(api.status().pending, 1)
  assert.deepEqual(ids, ['l-net', 'l-net', 'l-net', 'l-net'])
})

test('逾時第一次不判斷線，三次重試都逾時才 online = false，id 不變', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const ids: string[] = []
  const adapter = {
    kind: 'test',
    call: (op: Op) => {
      if (op.action === 'read') return inner.call(op)
      if (op.action === 'append') ids.push(op.record.id)
      return Promise.reject(new NetworkError(undefined, 'timeout'))
    },
  }
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  await api.appendLog({ id: 'l-to', ...logFields })
  assert.equal(api.status().online, true)
  await afterGap(2000)
  assert.equal(api.status().online, true)
  await afterGap(5000)
  assert.equal(api.status().online, true)
  await afterGap(15000)
  assert.equal(api.status().online, false)
  assert.deepEqual(ids, ['l-to', 'l-to', 'l-to', 'l-to'])
})

test('有快取的讀取失敗不把 online 設成 false', async () => {
  const { api, mock } = await setup()
  await api.load()
  mock.setOffline(true)
  await assert.rejects(() => api.load())
  assert.equal(api.status().online, true)
})

test('busy 三次用盡後 online 仍為 true、列仍在 pending', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = {
    kind: 'test',
    call: (op: Op) => (op.action === 'read' ? inner.call(op) : Promise.resolve({ ok: false as const, error: 'busy' })),
  }
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  await api.appendLog({ id: 'l-busy', ...logFields })
  assert.equal(api.status().online, true)
  assert.equal(api.status().pending, 1)
  await afterGap(2000)
  await afterGap(5000)
  await afterGap(15000)
  assert.equal(api.status().online, true)
  assert.equal(api.status().pending, 1)
  assert.equal(api.peek()!.logs.find((r) => r.id === 'l-busy')?.__write, 'pending')
})

test('retryFailed 把 ISO src 收成 7-11 且沿用同一 id', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const seen: { id: string; src: string }[] = []
  const adapter = {
    kind: 'test',
    call: (op: Op) => {
      if (op.action === 'append') {
        const rec = op.record
        if (String(rec.src).includes('T08:00')) {
          return Promise.resolve({ ok: false as const, error: 'bad_record', message: 'src 只能是 7-11、全家或其他' })
        }
        seen.push({ id: rec.id, src: String(rec.src) })
      }
      return inner.call(op)
    },
  }
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  await api.appendLog({ id: 'same-id', ...logFields, src: '2026-07-11T08:00:00+08:00' as typeof logFields.src })
  assert.equal(api.status().failed.length, 1)
  const d0 = await inner.call({ action: 'read' }) as { logs: { id: string }[] }
  assert.equal(d0.logs.filter((r) => r.id === 'same-id').length, 0)
  await api.retryFailed()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].src, '7-11')
  assert.equal(seen[0].id, 'same-id')
  assert.equal(api.status().failed.length, 0)
  const d1 = await inner.call({ action: 'read' }) as { logs: { id: string }[] }
  assert.equal(d1.logs.filter((r) => r.id === 'same-id').length, 1)
})

test('P1：不能補記未來的體重日期（台北時間），今天可以', async () => {
  const storage = memoryStorage()
  const NOW = Date.parse('2026-10-10T23:30:00+08:00')
  const mock = createMockAdapter({ storage, now: () => NOW })
  const api = createApi({ adapter: mock, storage, now: () => NOW })
  await assert.rejects(api.upsertWeight({ day: '2026-10-11', kg: 70, id: 'w-future', ts: '2026-10-11T12:00:00+08:00' }), /future_day/)
  assert.equal(api.peek()?.weights.some((w) => w.id === 'w-future') ?? false, false)
  await api.upsertWeight({ day: '2026-10-10', kg: 70, id: 'w-today', ts: taipeiIso(NOW) })
  assert.equal(api.peek()?.weights.some((w) => w.id === 'w-today'), true)
})
