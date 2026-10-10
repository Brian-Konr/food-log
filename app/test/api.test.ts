import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createApi } from '@/api'
import { createMockAdapter } from '@/api/mock'
import { createGasAdapter } from '@/api/gas'
import { memoryStorage } from './helpers'
import { taipeiDay, taipeiIso } from '@/lib/day'

const NOW = Date.parse('2026-10-10T18:00:00+08:00')
const day = taipeiDay(new Date(NOW))
const ts = taipeiIso(NOW)

function setup() {
  const storage = memoryStorage()
  const mock = createMockAdapter({ storage, now: () => NOW })
  const api = createApi({ adapter: mock, storage, now: () => NOW })
  return { storage, mock, api }
}

const logFields = { ts, day, item_id: 'fm:1', name: '雞胸', src: '全家' as const, qty: 1, grams: null, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3, deleted: false, updated_at: ts }

test('本機試用起始是空資料', async () => {
  const { api } = setup()
  const d = await api.load()
  assert.equal(d.logs.length, 0)
  assert.equal(d.weights.length, 0)
  assert.equal(d.config.target_kcal, '2000')
})

test('離線寫入留在 outbox、順序送出、樂觀列有待上傳標記', async () => {
  const { api, mock } = setup()
  mock.setOffline(true)
  const p = api.appendLog({ id: 'l1', ...logFields })
  assert.equal(api.peek()!.logs.find((r) => r.id === 'l1')?.__pending, true)
  await p
  assert.equal(api.status().pending, 1)
  mock.setOffline(false)
  assert.equal(await api.flush(), 1)
  assert.equal(api.status().pending, 0)
  assert.ok(!api.peek()!.logs.find((r) => r.id === 'l1')?.__pending)
})

test('永久錯誤移出、busy 留下', async () => {
  const { api } = setup()
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
  const { mock } = setup()
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
