import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createApi } from '@/api'
import { createMockAdapter } from '@/api/mock'
import { PERMANENT_ERRORS } from '@/api/errors'
import type { Op } from '@/api/types'
import { memoryStorage } from './helpers'
import { taipeiDay, taipeiIso } from '@/lib/day'

afterEach(() => {
  vi.useRealTimers()
})

const NOW = Date.parse('2026-10-10T18:00:00+08:00')
const day = taipeiDay(new Date(NOW))
const ts = taipeiIso(NOW)
const logFields = { ts, day, item_id: 'fm:1', name: '雞胸', src: '全家' as const, qty: 1, grams: null, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3, deleted: false, updated_at: ts, source: 'app' as const, store: '' }

function setup(failure: { ok: false; error: string; message?: string }) {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const calls = { writes: 0 }
  const adapter = {
    kind: 'test',
    call: (op: Op) => {
      if (op.action === 'read') return inner.call(op)
      calls.writes += 1
      return Promise.resolve(failure)
    },
  }
  return { calls, api: createApi({ adapter, storage, now: () => NOW }) }
}

test('read_only 是永久錯誤：不重試、移到 failed 並帶「已搬到新網址」訊息', async () => {
  vi.useFakeTimers()
  const { api, calls } = setup({ ok: false, error: 'read_only', message: 'food-log 已搬到新網址，這裡只能讀' })
  await api.ready
  await api.appendLog({ id: 'ro1', ...logFields })
  assert.equal(calls.writes, 1)
  assert.equal(api.status().pending, 0)
  assert.equal(api.status().failed.length, 1)
  assert.equal(api.status().failed[0].error, 'read_only')
  assert.match(api.status().failed[0].message ?? '', /已搬到新網址/)
  await vi.advanceTimersByTimeAsync(60_000)
  assert.equal(calls.writes, 1, '不排程自動重送')
  assert.ok(PERMANENT_ERRORS.has('read_only'))
})

test('read_only 的 message 照伺服器給的原樣帶過來（前端不另加文案）', async () => {
  const { api } = setup({ ok: false, error: 'read_only', message: '伺服器自訂文案' })
  await api.ready
  await api.appendLog({ id: 'ro2', ...logFields })
  assert.equal(api.status().failed[0].message, '伺服器自訂文案')
})
