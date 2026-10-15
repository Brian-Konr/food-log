import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createApi, memoryKv } from '@/api'
import { createMockAdapter } from '@/api/mock'
import type { Op } from '@/api/types'
import { memoryStorage, logFields, itemFields, storeFields } from './helpers'

afterEach(() => {
  vi.restoreAllMocks()
})

const NOW = Date.parse('2026-10-10T18:00:00+08:00')

function wrap(
  inner: ReturnType<typeof createMockAdapter>,
  intercept?: (op: Op) => ReturnType<typeof inner.call> | undefined,
) {
  const calls: Op[] = []
  return {
    kind: 'test' as const,
    calls,
    setOffline: (v: boolean) => inner.setOffline(v),
    call: (op: Op) => {
      calls.push(op)
      const hit = intercept?.(op)
      if (hit) return hit
      return inner.call(op)
    },
  }
}

test('未同步 failed append，remove 不打後端；復原回 failed', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner, (op) => {
    if (op.action === 'append') return Promise.resolve({ ok: false as const, error: 'bad_record', message: '壞' })
  })
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  const rec = logFields({ id: 'l-fail' })
  await api.appendLog(rec)
  assert.equal(api.failed().length, 1)
  assert.equal(api.status().pending, 0)
  const n = adapter.calls.length
  await api.remove('Logs', rec.id)
  assert.equal(adapter.calls.slice(n).some((c) => c.action === 'softDelete'), false)
  assert.equal(api.failed().length, 0)
  assert.equal(api.outbox().length, 0)
  assert.equal(api.peek()?.logs.some((r) => r.id === rec.id) ?? false, false)

  assert.equal(api.undoLocalDrop('Logs', rec.id), true)
  assert.equal(api.failed()[0].qid, api.failed()[0].qid)
  assert.equal(api.failed()[0].error, 'bad_record')
  assert.equal(api.failed()[0].op.action, 'append')
  const restored = api.failed()[0].op
  assert.equal(restored.action, 'append')
  if (restored.action !== 'append') throw new Error('expected append')
  assert.equal(restored.record.id, rec.id)
  assert.equal(api.outbox().length, 0)
  assert.equal(api.peek()?.logs.find((r) => r.id === rec.id)?.__write, 'failed')
  assert.equal(api.undoLocalDrop('Logs', rec.id), false)
})

test('未同步 outbox append；復原回 outbox', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner)
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  adapter.setOffline(true)
  const rec = logFields({ id: 'l-out' })
  await api.appendLog(rec)
  const qid = api.outbox()[0].qid
  const n = adapter.calls.length
  await api.remove('Logs', rec.id)
  assert.equal(api.outbox().length, 0)
  assert.equal(adapter.calls.slice(n).some((c) => c.action === 'softDelete'), false)
  assert.equal(api.peek()?.logs.some((r) => r.id === rec.id) ?? false, false)

  assert.equal(api.undoLocalDrop('Logs', rec.id), true)
  assert.equal(api.outbox()[0].qid, qid)
  assert.equal(api.outbox()[0].action, 'append')
  assert.equal(api.failed().length, 0)
  assert.equal(api.peek()?.logs.find((r) => r.id === rec.id)?.__pending, true)
})

test('已同步的刪除仍打後端', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner)
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  const rec = logFields({ id: 'l-ok' })
  await api.appendLog(rec)
  await api.remove('Logs', rec.id)
  assert.ok(adapter.calls.some((c) => c.action === 'softDelete' && c.action === 'softDelete' && (c as { id?: string }).id === rec.id))
})

test('舊後端 not_found 當成功；update not_found 仍進 failed', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner, (op) => {
    if (op.action === 'softDelete') return Promise.resolve({ ok: false as const, error: 'not_found' })
    if (op.action === 'update') return Promise.resolve({ ok: false as const, error: 'not_found' })
  })
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  const rec = logFields({ id: 'l-nf' })
  await api.appendLog(rec)
  await api.remove('Logs', rec.id)
  assert.equal(api.status().pending, 0)
  assert.equal(api.failed().length, 0)
  assert.equal(api.peek()?.logs.find((r) => r.id === rec.id)?.deleted, true)

  await api.updateLog(rec.id, { qty: 2 })
  assert.equal(api.failed()[0].error, 'not_found')
})

test('not_found 的 softDelete 會把成對的 failed append 一起丟掉（ready heal）', async () => {
  const info = vi.spyOn(console, 'info')
  const rec = logFields({ id: 'l-pair', name: '幽靈豆漿' })
  const kv = memoryKv({
    failed: JSON.stringify([
      { qid: 'q-app', error: 'bad_record', message: '壞', queuedAt: rec.ts, op: { action: 'append', table: 'Logs', record: rec } },
      { qid: 'q-del', error: 'not_found', message: '找不到', queuedAt: rec.ts, op: { action: 'softDelete', table: 'Logs', id: rec.id } },
    ]),
  })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner, (op) => {
    if (op.action === 'softDelete') return Promise.resolve({ ok: false as const, error: 'not_found' })
  })
  const api = createApi({ adapter, storage, now: () => NOW, kv })
  await api.ready
  assert.equal(api.failed().length, 0)
  assert.equal(api.outbox().length, 0)
  assert.ok(info.mock.calls.some((c) => c[0] === 'food-log auto-heal 2'))
  assert.equal(api.peek()?.logs.some((r) => r.name === '幽靈豆漿') ?? false, false)
})

test('heal 只有 not_found softDelete；第二次行程不再 info', async () => {
  const info = vi.spyOn(console, 'info')
  const kv = memoryKv({
    failed: JSON.stringify([
      { qid: 'q-ghost', error: 'not_found', message: 'x', queuedAt: '2026-10-10T12:00:00+08:00', op: { action: 'softDelete', table: 'Logs', id: 'l-ghost' } },
    ]),
  })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const api = createApi({ adapter: wrap(inner), storage, now: () => NOW, kv })
  await api.ready
  assert.equal(api.failed().length, 0)
  assert.ok(info.mock.calls.some((c) => c[0] === 'food-log auto-heal 1'))
  info.mockClear()
  const api2 = createApi({ adapter: wrap(inner), storage, now: () => NOW, kv })
  await api2.ready
  assert.equal(info.mock.calls.some((c) => String(c[0]).includes('food-log auto-heal')), false)
})

test('heal 不碰單獨的 failed append、不碰 update not_found', async () => {
  const info = vi.spyOn(console, 'info')
  const rec = logFields({ id: 'l-keep' })
  const kv = memoryKv({
    failed: JSON.stringify([
      { qid: 'q-app', error: 'bad_record', message: '壞', queuedAt: rec.ts, op: { action: 'append', table: 'Logs', record: rec } },
      { qid: 'q-up', error: 'not_found', message: 'x', queuedAt: rec.ts, op: { action: 'update', table: 'Logs', id: rec.id, patch: { qty: 2 } } },
    ]),
  })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const api = createApi({ adapter: wrap(inner), storage, now: () => NOW, kv })
  await api.ready
  assert.equal(api.failed().length, 2)
  assert.equal(info.mock.calls.some((c) => String(c[0]).includes('food-log auto-heal')), false)
})

test('heal 成對時跨清單，不送出', async () => {
  const rec = logFields({ id: 'l-cross' })
  const kv = memoryKv({
    outbox: JSON.stringify([
      { ...({ action: 'append', table: 'Logs', record: rec } as const), qid: 'q-out', queuedAt: rec.ts },
    ]),
    failed: JSON.stringify([
      { qid: 'q-del', error: 'bad_record', message: 'x', queuedAt: rec.ts, op: { action: 'softDelete', table: 'Logs', id: rec.id } },
    ]),
  })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner)
  const api = createApi({ adapter, storage, now: () => NOW, kv })
  await api.ready
  assert.equal(api.outbox().length, 0)
  assert.equal(api.failed().length, 0)
  assert.equal(adapter.calls.length, 0)
})

test('failedNotified 持久', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner, (op) => {
    if (op.action === 'update') return Promise.resolve({ ok: false as const, error: 'not_found' })
  })
  const kv = memoryKv()
  const api = createApi({ adapter, storage, now: () => NOW, kv })
  await api.ready
  await api.updateLog('no-such', { qty: 2 })
  const qid = api.failed()[0].qid
  await api.markFailedNotified(qid)
  const api2 = createApi({ adapter: wrap(inner), storage, now: () => NOW, kv })
  await api2.ready
  assert.ok((await api2.failedNotified()).includes(qid))
  assert.equal(api2.failed().length, 1)
})

test('retry 後再失敗會再通知', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner, (op) => {
    if (op.action === 'update') return Promise.resolve({ ok: false as const, error: 'not_found' })
  })
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  await api.updateLog('no-such', { qty: 2 })
  const qid = api.failed()[0].qid
  await api.markFailedNotified(qid)
  await api.retryFailed(qid)
  assert.equal((await api.failedNotified()).includes(qid), false)
})

test('未同步 upsertItem', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner, (op) => {
    if (op.action === 'upsertItem') return Promise.resolve({ ok: false as const, error: 'bad_record', message: '壞' })
  })
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  const rec = itemFields({ id: 'u:1', name: '豆漿' })
  await api.upsertItem(rec)
  const n = adapter.calls.length
  await api.remove('Items', rec.id)
  assert.equal(adapter.calls.slice(n).some((c) => c.action === 'softDelete'), false)
  assert.equal(api.undoLocalDrop('Items', rec.id), true)
  assert.equal(api.failed()[0].op.action, 'upsertItem')
})

test('未同步的店連子項；已同步的店仍送 softDelete', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner)
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  adapter.setOffline(true)
  const store = storeFields({ id: 's:1', name: '店' })
  const item = itemFields({ id: 'u:s1', name: '品', store: 's:1' })
  const log = logFields({ id: 'l:s1', store: 's:1' })
  await api.upsertStore(store)
  await api.upsertItem(item)
  await api.appendLog(log)
  const n = adapter.calls.length
  await api.remove('Stores', 's:1')
  // 店家和它的品項是本機丟掉；Logs 不連帶（v1：刪店家不動 Logs），仍在佇列，只是 store 被清掉
  assert.deepEqual(api.outbox().map((x) => x.action), ['append'])
  assert.equal(adapter.calls.slice(n).some((c) => c.action === 'softDelete'), false)
  assert.equal(api.undoLocalDrop('Stores', 's:1'), true)
  assert.equal(api.outbox().length, 3)

  const storage2 = memoryStorage()
  const inner2 = createMockAdapter({ storage: storage2, now: () => NOW })
  const adapter2 = wrap(inner2)
  const api2 = createApi({ adapter: adapter2, storage: storage2, now: () => NOW })
  await api2.ready
  await api2.upsertStore(store)
  adapter2.setOffline(true)
  await api2.upsertItem(item)
  const n2 = adapter2.calls.length
  await api2.remove('Stores', 's:1')
  assert.ok(
    api2.outbox().some((x) => x.action === 'softDelete' && x.id === 's:1')
    || adapter2.calls.slice(n2).some((c) => c.action === 'softDelete'),
  )
  assert.ok(api2.outbox().some((x) => x.action === 'upsertItem'))
  assert.equal(api2.undoLocalDrop('Stores', 's:1'), false)
})

// ---- v1.1.5 fixes: create vs edit, autoHeal, logs of dropped store, persisted undo ----

test('離線改名已存在的店再刪除：真的送 softDelete，編輯留在前面', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner)
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  const store = storeFields({ id: 's:old', name: '老店' })
  await api.upsertStore(store)
  assert.equal(api.status().pending, 0)
  adapter.setOffline(true)
  await api.upsertStore({ ...store, name: '新名字' })
  assert.equal(api.outbox().length, 1)
  await api.remove('Stores', 's:old')
  assert.deepEqual(api.outbox().map((x) => x.action), ['upsertStore', 'softDelete'])
  adapter.setOffline(false)
  await api.flush()
  assert.equal(api.status().pending, 0)
  assert.ok(adapter.calls.some((c) => c.action === 'softDelete' && (c as { id?: string }).id === 's:old'))
  const snap = await api.load()
  assert.equal(snap.stores?.find((x) => x.id === 's:old')?.deleted, true)
})

test('編輯已存在的品項（含失敗的編輯）再刪除：送 softDelete，畫面不會被失敗編輯復活', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  let reject = false
  const adapter = wrap(inner, (op) => {
    if (reject && op.action === 'upsertItem') return Promise.resolve({ ok: false as const, error: 'bad_record', message: '壞' })
  })
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  const item = itemFields({ id: 'u:ex', name: '豆漿' })
  await api.upsertItem(item)
  adapter.setOffline(true)
  await api.upsertItem({ ...item, name: '改名豆漿' })
  await api.remove('Items', 'u:ex')
  assert.deepEqual(api.outbox().map((x) => x.action), ['upsertItem', 'softDelete'])

  // 編輯被永久拒收：進 failed，但刪除照送，畫面維持已刪除
  adapter.setOffline(false)
  reject = true
  await api.flush()
  assert.equal(api.failed()[0].op.action, 'upsertItem')
  assert.ok(adapter.calls.some((c) => c.action === 'softDelete' && (c as { id?: string }).id === 'u:ex'))
  assert.equal(api.status().pending, 0)
  assert.equal(api.peek()?.items.find((x) => x.id === 'u:ex')?.deleted, true)
})

test('伺服器上已有的 append（重送）刪除要送 softDelete', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner)
  const kv = memoryKv()
  const api = createApi({ adapter, storage, now: () => NOW, kv })
  await api.ready
  const rec = logFields({ id: 'l-resend' })
  await api.appendLog(rec)
  adapter.setOffline(true)
  await api.appendLog(rec) // 重送同一筆
  assert.equal(api.outbox().length, 1)
  await api.remove('Logs', rec.id)
  assert.deepEqual(api.outbox().map((x) => x.action), ['append', 'softDelete'])
})

function cacheOf(items: ReturnType<typeof itemFields>[]) {
  return JSON.stringify({
    savedAt: '2026-10-10T17:00:00+08:00', serverTime: '2026-10-10T17:00:00+08:00', day: '2026-10-10',
    config: {}, items, stores: [], logs: [], weights: [],
  })
}

test('heal：已存在品項的 [編輯, softDelete] 保留刪除', async () => {
  const info = vi.spyOn(console, 'info')
  const item = itemFields({ id: 'u:keep', name: '舊' })
  const kv = memoryKv({
    snapshot: cacheOf([item]),
    outbox: JSON.stringify([
      { action: 'upsertItem', record: { ...item, name: '新' }, qid: 'q-edit', queuedAt: item.ts },
      { action: 'softDelete', table: 'Items', id: item.id, qid: 'q-del', queuedAt: item.ts },
    ]),
  })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  inner.setOffline(true)
  const api = createApi({ adapter: wrap(inner), storage, now: () => NOW, kv })
  await api.ready
  assert.deepEqual(api.outbox().map((x) => x.action), ['upsertItem', 'softDelete'])
  assert.equal(info.mock.calls.some((c) => String(c[0]).includes('food-log auto-heal')), false)
})

test('heal：沒有快取，[upsert, softDelete] 不丟刪除（保守）', async () => {
  const item = itemFields({ id: 'u:nocache', name: '舊' })
  const kv = memoryKv({
    outbox: JSON.stringify([
      { action: 'upsertItem', record: item, qid: 'q-edit', queuedAt: item.ts },
      { action: 'softDelete', table: 'Items', id: item.id, qid: 'q-del', queuedAt: item.ts },
    ]),
  })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  inner.setOffline(true)
  const api = createApi({ adapter: wrap(inner), storage, now: () => NOW, kv })
  await api.ready
  assert.ok(api.outbox().some((x) => x.action === 'softDelete'))
})

test('heal：快取裡沒有這個品項（從未同步）的 [upsert, softDelete] 兩個都丟', async () => {
  const info = vi.spyOn(console, 'info')
  const item = itemFields({ id: 'u:ghost', name: '幽靈' })
  const kv = memoryKv({
    snapshot: cacheOf([]),
    outbox: JSON.stringify([
      { action: 'upsertItem', record: item, qid: 'q-edit', queuedAt: item.ts },
      { action: 'softDelete', table: 'Items', id: item.id, qid: 'q-del', queuedAt: item.ts },
    ]),
  })
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  inner.setOffline(true)
  const api = createApi({ adapter: wrap(inner), storage, now: () => NOW, kv })
  await api.ready
  assert.equal(api.outbox().length, 0)
  assert.ok(info.mock.calls.some((c) => c[0] === 'food-log auto-heal 2'))
})

test('刪除未同步的店：待送 Logs 留著、store 清空；復原把 store 接回（outbox 與 failed 都是）', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner, (op) => {
    if (op.action === 'append' && op.record.id === 'l:bad') return Promise.resolve({ ok: false as const, error: 'bad_record', message: '壞' })
  })
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  // 先讓 l:bad 進 failed（這時店家還不存在於伺服器，所以用 mock 直接拒收）
  await api.appendLog(logFields({ id: 'l:bad', store: 's:new' }))
  assert.equal(api.failed().length, 1)
  adapter.setOffline(true)
  await api.upsertStore(storeFields({ id: 's:new', name: '新店' }))
  await api.appendLog(logFields({ id: 'l:ok', store: 's:new', name: '午餐' }))
  const n = adapter.calls.length
  await api.remove('Stores', 's:new')
  assert.equal(adapter.calls.slice(n).some((c) => c.action === 'softDelete'), false)
  assert.deepEqual(api.outbox().map((x) => x.action), ['append'])
  const ob = api.outbox()[0]
  if (ob.action !== 'append') throw new Error('expected append')
  assert.equal(ob.record.id, 'l:ok')
  assert.equal(ob.record.store, '')
  const fl = api.failed()[0].op
  if (fl.action !== 'append') throw new Error('expected append')
  assert.equal(fl.record.store, '')

  assert.equal(api.undoLocalDrop('Stores', 's:new'), true)
  const back = api.outbox().find((x) => x.action === 'append')
  if (!back || back.action !== 'append') throw new Error('expected append')
  assert.equal(back.record.store, 's:new')
  const ff = api.failed()[0].op
  if (ff.action !== 'append') throw new Error('expected append')
  assert.equal(ff.record.store, 's:new')
  assert.ok(api.outbox().some((x) => x.action === 'upsertStore'))
})

test('刪除未同步的店後上線：餐點仍被記錄（沒有店家）', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner)
  const api = createApi({ adapter, storage, now: () => NOW })
  await api.ready
  adapter.setOffline(true)
  await api.upsertStore(storeFields({ id: 's:gone', name: '店' }))
  await api.appendLog(logFields({ id: 'l:keep', store: 's:gone', name: '便當' }))
  await api.remove('Stores', 's:gone')
  adapter.setOffline(false)
  await api.flush()
  assert.equal(api.failed().length, 0)
  const snap = await api.load()
  const row = snap.logs.find((r) => r.id === 'l:keep')
  assert.ok(row)
  assert.equal(row?.store, '')
})

test('重新載入後，本機刪除的復原仍有效；超過 10 秒的暫存啟動時丟掉', async () => {
  const storage = memoryStorage()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = wrap(inner)
  const kv = memoryKv()
  let t = NOW
  const api = createApi({ adapter, storage, now: () => t, kv })
  await api.ready
  adapter.setOffline(true)
  const rec = logFields({ id: 'l-reload' })
  await api.appendLog(rec)
  await api.remove('Logs', rec.id)
  assert.equal(api.outbox().length, 0)

  // 重新載入（同一個 kv）
  t = NOW + 3000
  const api2 = createApi({ adapter: wrap(inner), storage, now: () => t, kv })
  await api2.ready
  assert.equal(api2.outbox().length, 0)
  assert.equal(api2.undoLocalDrop('Logs', rec.id), true)
  assert.equal(api2.outbox()[0].action, 'append')
  assert.equal(api2.undoLocalDrop('Logs', rec.id), false)

  // 另一筆：再刪、等超過 10 秒才重新載入 → 暫存已過期
  const inner3 = createMockAdapter({ storage, now: () => NOW })
  inner3.setOffline(true)
  const rec2 = logFields({ id: 'l-old' })
  await api2.appendLog(rec2)
  await api2.remove('Logs', rec2.id)
  t = NOW + 3000 + 11_000
  const api3 = createApi({ adapter: wrap(inner3), storage, now: () => t, kv })
  await api3.ready
  assert.equal(api3.undoLocalDrop('Logs', rec2.id), false)
})
