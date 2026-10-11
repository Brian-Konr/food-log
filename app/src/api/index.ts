// 資料層：畫面只跟這裡講話。所有寫入先進待送佇列，再依序送出。
import type { ItemRecord, LogRecord, Snapshot, StoreRecord, WeightRecord } from '@/types'
import { taipeiIso, taipeiToday } from '@/lib/day'
import { DEFAULT_CONFIG } from '@/data/defaults'
import { defaultKv, type Kv } from '@/data/kv'
import { loadCache, saveCache, snapshotFromCache, toCached, type CachedSnapshot } from '@/data/cache'
import { NetworkError, PERMANENT_ERRORS, ServerError } from './errors'
import type { Adapter, Response, WriteOp } from './types'

export type { Adapter } from './types'
export type { Kv } from '@/data/kv'
export { memoryKv } from '@/data/kv'

type Queued = WriteOp & { qid: string; queuedAt: string; groupId?: string; label?: string; sawNet?: boolean }
export interface FailedWrite {
  op: WriteOp
  error: string
  message?: string
  queuedAt: string
  qid: string
  groupId?: string
  label?: string
}
export interface ApiStatus { pending: number; failed: FailedWrite[]; online: boolean; adapter: string }

const uuid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

const emptySnapshot = (now: number): Snapshot => ({
  ok: true, version: 1, serverTime: taipeiIso(now), config: { ...DEFAULT_CONFIG },
  items: [], stores: [], logs: [], weights: [],
})

const isFail = (r: Response): r is { ok: false; error: string; message?: string } => r.ok === false

function parseList<T>(raw: string | null): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v as T[] : []
  } catch {
    return []
  }
}

function unionByQid<T extends { qid?: string }>(a: T[], b: T[]): T[] {
  const seen = new Set(a.map((x) => x.qid).filter(Boolean) as string[])
  const out = [...a]
  for (const x of b) {
    if (x.qid && seen.has(x.qid)) continue
    if (x.qid) seen.add(x.qid)
    out.push(x)
  }
  return out
}

function stripForSend(op: WriteOp): WriteOp {
  const clone = JSON.parse(JSON.stringify(op)) as WriteOp & { qid?: string; queuedAt?: string; groupId?: string; label?: string; sawNet?: boolean }
  delete clone.qid
  delete clone.queuedAt
  delete clone.groupId
  delete clone.label
  delete clone.sawNet
  const rec = 'record' in clone ? (clone as { record?: Record<string, unknown> }).record : undefined
  if (rec) for (const k of Object.keys(rec)) if (k.startsWith('__')) delete rec[k]
  return clone
}

function recordId(op: WriteOp): string | null {
  if (op.action === 'update' || op.action === 'softDelete' || op.action === 'restore') return op.id
  if (op.action === 'upsertItem' || op.action === 'upsertStore') return op.record.id
  if (op.action === 'append') return op.record.id
  if (op.action === 'upsertWeight') return op.record.id
  return null
}

export interface ApiOptions {
  adapter: Adapter
  storage?: Storage
  now?: () => number
  prefix?: string
  kv?: Kv
}

export function createApi({ adapter, storage, now = () => Date.now(), prefix = 'foodlog', kv: kvOpt }: ApiOptions) {
  const kv = kvOpt ?? defaultKv()
  const ls = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  const listeners = new Set<(s: ApiStatus) => void>()
  let online = true
  let flushing: Promise<number> | null = null
  let lastData: Snapshot | null = null
  let cacheMeta: CachedSnapshot | null = null
  let outbox: Queued[] = []
  let failed: FailedWrite[] = []
  let retryWave = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const RETRY_GAPS_MS = [2000, 5000, 15000]

  const status = (): ApiStatus => ({ pending: outbox.length, failed: [...failed], online, adapter: adapter.kind })
  const emit = () => { const s = status(); listeners.forEach((fn) => fn(s)) }

  async function persistQueue() {
    await kv.set('outbox', JSON.stringify(outbox))
    await kv.set('failed', JSON.stringify(failed))
  }

  function clearRetries() {
    if (retryTimer != null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    retryWave = 0
  }

  function scheduleRetry(isNetwork: boolean) {
    if (retryTimer != null) return
    if (retryWave >= 3) {
      if (isNetwork && outbox.length > 0) online = false
      return
    }
    const gap = RETRY_GAPS_MS[retryWave]
    retryWave += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      void flush()
    }, gap)
  }

  function applyOp(data: Snapshot, op: WriteOp, pending: boolean, meta?: { queuedAt?: string; failed?: boolean; message?: string; sawNet?: boolean }) {
    if (!data.stores) data.stores = []
    const mark = meta?.failed
      ? { __write: 'failed' as const, __queuedAt: meta.queuedAt, __failMessage: meta.message }
      : pending
        ? { __pending: true as const, __write: 'pending' as const, __queuedAt: meta?.queuedAt }
        : {}
    if (op.action === 'setConfig') { data.config = { ...data.config, [op.key]: op.value }; return }
    if (op.action === 'upsertItem') {
      const i = data.items.findIndex((f) => f.id === op.record.id)
      const row = { ...op.record, ...mark }
      if (i < 0) data.items.push(row)
      else data.items[i] = pending || meta?.failed ? { ...data.items[i], ...row } : { ...data.items[i], ...op.record }
      return
    }
    if (op.action === 'upsertStore') {
      const i = data.stores.findIndex((f) => f.id === op.record.id)
      const row = { ...op.record, ...mark }
      if (i < 0) data.stores.push(row)
      else data.stores[i] = pending || meta?.failed ? { ...data.stores[i], ...row } : { ...data.stores[i], ...op.record }
      return
    }
    if (op.action === 'upsertWeight') {
      const byId = data.weights.find((w) => w.id === op.record.id)
      if (byId) return
      const live = data.weights.find((w) => w.day === op.record.day && !w.deleted)
      if (live) {
        Object.assign(live, { kg: op.record.kg, ts: op.record.ts, ...mark })
        if (!pending && !meta?.failed) {
          delete live.__pending
          delete live.__write
        }
        return
      }
      data.weights.push({ id: op.record.id, day: op.record.day, ts: op.record.ts, kg: op.record.kg, deleted: false, updated_at: '', ...mark })
      return
    }
    if (op.action === 'append') {
      const rowMark = pending && meta?.sawNet ? { ...mark, __syncing: true as const } : mark
      const i = data.logs.findIndex((r) => r.id === op.record.id)
      if (i < 0) data.logs.push({ ...op.record, ...rowMark })
      else if (pending || meta?.failed) {
        data.logs[i] = { ...data.logs[i], ...op.record, ...rowMark }
      } else {
        const { __pending: _, __write: _w, __syncing: _s, ...rest } = data.logs[i]
        data.logs[i] = rest as LogRecord
      }
      if (op.record.store) {
        const st = data.stores.find((s) => s.id === op.record.store)
        if (st) {
          const ts = op.record.ts
          if (!st.last_eaten_at || ts > st.last_eaten_at) st.last_eaten_at = ts
        }
      }
      return
    }
    const table = op.table
    const rows: { id: string; deleted?: boolean; __cascade?: string }[] =
      table === 'Logs' ? data.logs : table === 'Items' ? data.items : table === 'Weights' ? data.weights : table === 'Stores' ? data.stores : []
    const i = rows.findIndex((r) => r.id === op.id)
    if (i < 0) return
    if (op.action === 'softDelete') {
      rows[i] = { ...rows[i], deleted: true, ...mark }
      if (table === 'Stores') {
        for (const item of data.items) {
          if (item.store === op.id && !item.deleted) {
            item.deleted = true
            item.__cascade = op.id
            if (pending) {
              item.__pending = true
              item.__write = 'pending'
            }
          }
        }
      }
    } else if (op.action === 'restore') {
      rows[i] = { ...rows[i], deleted: false, ...mark }
      if (table === 'Stores') {
        for (const item of data.items) {
          if (item.__cascade === op.id) {
            item.deleted = false
            delete item.__cascade
          }
        }
      }
    } else if (op.action === 'update') rows[i] = { ...rows[i], ...op.patch, ...mark }
  }

  function applyPending(data: Snapshot): Snapshot {
    for (const q of outbox) applyOp(data, q, true, { queuedAt: q.queuedAt, sawNet: q.sawNet })
    for (const f of failed) {
      if (f.op.action === 'softDelete' || f.op.action === 'restore') continue
      if (f.op.action === 'upsertStore') continue
      if (f.label === 'fav' || (f.op.action === 'setConfig' && f.op.key === 'fav_ids')) continue
      applyOp(data, f.op, false, { queuedAt: f.queuedAt, failed: true, message: f.message })
    }
    return data
  }

  function view(snap: Snapshot): Snapshot {
    return applyPending(structuredClone(snap))
  }

  function pruneAgainstServer(server: Snapshot) {
    const deleted = new Set<string>()
    for (const list of [server.items, server.logs, server.weights, server.stores ?? []]) {
      for (const r of list) if (r.deleted) deleted.add(r.id)
    }
    outbox = outbox.filter((op) => {
      if (op.action === 'update' || op.action === 'upsertItem' || op.action === 'upsertStore') {
        const id = recordId(op)
        if (id && deleted.has(id)) return false
      }
      return true
    })
  }

  async function flush(): Promise<number> {
    await ready
    if (flushing) return flushing
    flushing = (async () => {
      let sent = 0
      for (;;) {
        if (!outbox.length) { clearRetries(); break }
        const cur = outbox[0]
        const { qid, queuedAt, groupId, label: _label, sawNet: _sawNet, ...rest } = cur
        const op = stripForSend(rest as WriteOp)
        let res: Response
        try {
          res = await adapter.call(op as WriteOp)
          online = true
        } catch (err) {
          if (err instanceof NetworkError) {
            outbox[0].sawNet = true
            await persistQueue()
            scheduleRetry(true)
            break
          }
          throw err
        }
        if (isFail(res) && !PERMANENT_ERRORS.has(res.error)) { scheduleRetry(false); break }
        if (isFail(res)) {
          const group = groupId
          const moving = group ? outbox.filter((x) => x.groupId === group) : [cur]
          const ids = new Set(moving.map((x) => x.qid))
          outbox = outbox.filter((x) => !ids.has(x.qid))
          failed = [...failed, ...moving.map((x) => ({
            op: stripForSend(x) as WriteOp, error: res.error, message: res.message, queuedAt: x.queuedAt, qid: x.qid, groupId: x.groupId, label: x.label,
          }))]
          await persistQueue()
          continue
        }
        clearRetries()
        outbox = outbox.filter((x) => x.qid !== qid)
        const ignored = (res as { ignored?: string }).ignored === 'deleted'
        if (!ignored) {
          sent += 1
          if (!lastData) lastData = emptySnapshot(now())
          applyOp(lastData, rest as WriteOp, false)
        }
        await persistQueue()
      }
      return sent
    })()
    try { return await flushing } finally { flushing = null; emit() }
  }

  async function write(op: WriteOp, extra?: { groupId?: string; label?: string }): Promise<{ queued: boolean; qid: string }> {
    await ready
    if (!lastData) lastData = lastData ?? emptySnapshot(now())
    const qid = uuid()
    outbox = [...outbox, { ...op, qid, queuedAt: taipeiIso(now()), groupId: extra?.groupId, label: extra?.label }]
    await persistQueue()
    emit()
    await flush()
    return { queued: outbox.some((x) => x.qid === qid), qid }
  }

  async function migrateFromLocalStorage() {
    const oldOut = parseList<Queued>(ls?.getItem(`${prefix}.outbox`) ?? null)
    const oldFailRaw = parseList<FailedWrite & { qid?: string }>(ls?.getItem(`${prefix}.failed`) ?? null)
    const oldCache = ls?.getItem(`${prefix}.cache`) ?? null
    const idbOut = parseList<Queued>(await kv.get('outbox'))
    const idbFail = parseList<FailedWrite>(await kv.get('failed'))
    const idbSnap = await kv.get('snapshot')

    if (oldOut.length || idbOut.length) {
      outbox = unionByQid(idbOut, oldOut)
    }
    const oldFail = oldFailRaw.map((f) => ({ ...f, qid: f.qid || uuid() }))
    if (oldFail.length || idbFail.length) {
      failed = unionByQid(idbFail, oldFail)
    }
    await persistQueue()

    if (oldCache && !idbSnap) {
      try {
        const snap = JSON.parse(oldCache) as Snapshot & { serverTime?: string }
        const day = (snap.serverTime || '').slice(0, 10) || taipeiToday(now())
        const cached: CachedSnapshot = {
          savedAt: snap.serverTime || taipeiIso(now()),
          serverTime: snap.serverTime || taipeiIso(now()),
          day,
          config: snap.config ?? { ...DEFAULT_CONFIG },
          items: snap.items ?? [],
          stores: snap.stores ?? [],
          logs: snap.logs ?? [],
          weights: snap.weights ?? [],
        }
        await saveCache(kv, cached)
      } catch { /* ignore bad cache */ }
    }
    ls?.removeItem(`${prefix}.outbox`)
    ls?.removeItem(`${prefix}.failed`)
    ls?.removeItem(`${prefix}.cache`)
  }

  const ready: Promise<void> = (async () => {
    await migrateFromLocalStorage()
    cacheMeta = await loadCache(kv)
    if (cacheMeta) lastData = snapshotFromCache(cacheMeta)
    const o = parseList<Queued>(await kv.get('outbox'))
    const f = parseList<FailedWrite>(await kv.get('failed'))
    if (o.length) outbox = o
    if (f.length) failed = f
    emit()
    void flush().catch(() => 0)
  })()

  return {
    status,
    flush,
    ready,
    onStatus(fn: (s: ApiStatus) => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    peek(): Snapshot | null { return lastData ? view(lastData) : null },
    outbox(): Queued[] { return [...outbox] },
    cache(): CachedSnapshot | null { return cacheMeta },

    async load(): Promise<Snapshot> {
      await ready
      await flush().catch(() => 0)
      try {
        const res = await adapter.call({ action: 'read' })
        online = true
        if (isFail(res)) throw new ServerError(res.error, res.message)
        lastData = res as Snapshot
        if (!lastData.items) lastData.items = []
        if (!lastData.logs) lastData.logs = []
        if (!lastData.weights) lastData.weights = []
        if (!lastData.stores) lastData.stores = []
        if (!lastData.config) lastData.config = { ...DEFAULT_CONFIG }
        pruneAgainstServer(lastData)
        cacheMeta = toCached(lastData, now())
        await saveCache(kv, cacheMeta)
        await persistQueue()
      } catch (err) {
        if (err instanceof NetworkError) {
          const isTimeout = err.kind === 'timeout'
          if (!cacheMeta && !isTimeout) online = false
        }
        emit()
        throw err
      } finally {
        emit()
      }
      if (!lastData) throw new Error('no_data')
      return view(lastData)
    },

    async history(args: { table: 'Logs' | 'Weights'; before: string; limit?: number }) {
      const res = await adapter.call({ action: 'history', ...args })
      if (isFail(res)) throw new ServerError(res.error, res.message)
      return res
    },

    appendLog(record: LogRecord, extra?: { groupId?: string; label?: string }) {
      return write({ action: 'append', table: 'Logs', record }, extra)
    },
    updateLog(id: string, patch: Partial<LogRecord>) {
      return write({ action: 'update', table: 'Logs', id, patch: patch as Record<string, unknown> })
    },
    remove(table: 'Logs' | 'Weights' | 'Items' | 'Stores', id: string) {
      return write({ action: 'softDelete', table, id })
    },
    restore(table: 'Logs' | 'Weights' | 'Items' | 'Stores', id: string) {
      return write({ action: 'restore', table, id })
    },
    setConfig(key: string, value: string, extra?: { label?: string }) {
      return write({ action: 'setConfig', key, value }, extra)
    },
    upsertItem(record: ItemRecord, extra?: { groupId?: string; label?: string }) {
      return write({ action: 'upsertItem', record }, extra)
    },
    upsertStore(record: StoreRecord) {
      return write({ action: 'upsertStore', record })
    },
    upsertWeight(record: Pick<WeightRecord, 'day' | 'kg' | 'id' | 'ts'>) {
      if (record.day > taipeiToday(now())) return Promise.reject(new Error('future_day'))
      return write({ action: 'upsertWeight', record })
    },

    dismissFailed() { failed = []; void persistQueue(); emit() },
    async retryFailed(qid?: string) {
      await ready
      let moving: FailedWrite[]
      if (!qid) {
        moving = failed
        failed = []
      } else {
        const one = failed.find((f) => f.qid === qid)
        const gid = one?.groupId
        moving = failed.filter((f) => f.qid === qid || (gid && f.groupId === gid))
        const ids = new Set(moving.map((f) => f.qid))
        failed = failed.filter((f) => !ids.has(f.qid))
      }
      outbox = [...outbox, ...moving.map((f) => ({ ...f.op, qid: f.qid, queuedAt: f.queuedAt, groupId: f.groupId, label: f.label }))]
      await persistQueue()
      emit()
      return flush()
    },
    async discardFailed(qid: string) {
      await ready
      const one = failed.find((f) => f.qid === qid)
      const gid = one?.groupId
      failed = failed.filter((f) => f.qid !== qid && !(gid && f.groupId === gid))
      await persistQueue()
      emit()
    },
    async dropQueued(qid: string) {
      await ready
      const one = outbox.find((x) => x.qid === qid)
      const gid = one?.groupId
      outbox = outbox.filter((x) => x.qid !== qid && !(gid && x.groupId === gid))
      await persistQueue()
      emit()
    },
  }
}

export type Api = ReturnType<typeof createApi>
export { uuid }
