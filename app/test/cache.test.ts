import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { createApi } from '@/api'
import { createMockAdapter } from '@/api/mock'
import { isStaleToday, saveCache, loadCache, toCached } from '@/data/cache'
import { idbKv, memoryKv } from '@/data/kv'
import { memoryStorage } from './helpers'
import { DEFAULT_CONFIG } from '@/data/defaults'

const NOW = Date.parse('2026-10-10T18:00:00+08:00')

test('存讀快照；day 不是今天時 staleToday', async () => {
  const kv = idbKv()
  const cached = {
    savedAt: '2026-10-09T18:00:00+08:00',
    serverTime: '2026-10-09T18:00:00+08:00',
    day: '2026-10-09',
    config: { ...DEFAULT_CONFIG, target_kcal: '1800' },
    items: [],
    stores: [],
    logs: [],
    weights: [],
  }
  await saveCache(kv, cached)
  const loaded = await loadCache(kv)
  expect(loaded?.day).toBe('2026-10-09')
  expect(loaded?.config.target_kcal).toBe('1800')
  expect(isStaleToday(loaded, '2026-10-10')).toBe(true)
  expect(isStaleToday(loaded, '2026-10-09')).toBe(false)
  const snap = { ok: true as const, version: 1, serverTime: '2026-10-10T18:00:00+08:00', config: { ...DEFAULT_CONFIG }, items: [], stores: [], logs: [], weights: [] }
  const today = toCached(snap, NOW)
  expect(today.day).toBe('2026-10-10')
  expect(isStaleToday(today, '2026-10-10')).toBe(false)
})

test('outbox 只有 localStorage 時抄到 kv 並清掉 key', async () => {
  const storage = memoryStorage()
  const kv = memoryKv()
  storage.setItem('foodlog.outbox', JSON.stringify([{ qid: 'a', action: 'append', table: 'Logs', record: { id: 'l1' }, queuedAt: 't' }]))
  const mock = createMockAdapter({ storage, now: () => NOW })
  mock.setOffline(true)
  const api = createApi({ adapter: mock, storage, now: () => NOW, kv })
  await api.ready
  const box = JSON.parse(await kv.get('outbox') || '[]') as { qid: string }[]
  expect(box.map((x) => x.qid)).toEqual(['a'])
  expect(storage.getItem('foodlog.outbox')).toBeNull()
})

test('兩邊都有不同 qid 時聯集；再啟動一次不會變四筆', async () => {
  const storage = memoryStorage()
  const kv = memoryKv()
  storage.setItem('foodlog.outbox', JSON.stringify([{ qid: 'a', action: 'append', table: 'Logs', record: { id: 'l1' }, queuedAt: 't' }]))
  await kv.set('outbox', JSON.stringify([{ qid: 'b', action: 'append', table: 'Logs', record: { id: 'l2' }, queuedAt: 't' }]))
  const mock = createMockAdapter({ storage, now: () => NOW })
  mock.setOffline(true)
  const api = createApi({ adapter: mock, storage, now: () => NOW, kv })
  await api.ready
  const box = JSON.parse(await kv.get('outbox') || '[]') as { qid: string }[]
  expect(new Set(box.map((x) => x.qid))).toEqual(new Set(['a', 'b']))
  expect(storage.getItem('foodlog.outbox')).toBeNull()
  const api2 = createApi({ adapter: mock, storage, now: () => NOW, kv })
  await api2.ready
  const box2 = JSON.parse(await kv.get('outbox') || '[]') as { qid: string }[]
  expect(box2).toHaveLength(2)
})
