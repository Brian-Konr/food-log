// 資料層：畫面只跟這裡講話。所有寫入先進待送佇列，再依序送出。
import type { ItemRecord, LogRecord, Snapshot, WeightRecord } from '@/types'
import { taipeiIso } from '@/lib/day'
import { DEFAULT_CONFIG } from '@/data/defaults'
import { NetworkError, PERMANENT_ERRORS, ServerError } from './errors'
import type { Adapter, Response, WriteOp } from './types'

export type { Adapter } from './types'

type Queued = WriteOp & { qid: string; queuedAt: string }
export interface FailedWrite { op: WriteOp; error: string; message?: string; queuedAt: string }
export interface ApiStatus { pending: number; failed: FailedWrite[]; online: boolean; adapter: string }

const uuid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

const emptySnapshot = (now: number): Snapshot => ({
  ok: true, version: 1, serverTime: taipeiIso(now), config: { ...DEFAULT_CONFIG },
  items: [], logs: [], weights: [],
})

const isFail = (r: Response): r is { ok: false; error: string; message?: string } => r.ok === false

export interface ApiOptions {
  adapter: Adapter
  storage?: Storage
  now?: () => number
  prefix?: string
}

export function createApi({ adapter, storage, now = () => Date.now(), prefix = 'foodlog' }: ApiOptions) {
  const K = { outbox: `${prefix}.outbox`, failed: `${prefix}.failed`, cache: `${prefix}.cache` }
  const mem = new Map<string, string>()
  const getRaw = (k: string) => (storage ? storage.getItem(k) : mem.get(k) ?? null)
  const setRaw = (k: string, v: string) => (storage ? storage.setItem(k, v) : mem.set(k, v))
  const getList = <T>(k: string): T[] => JSON.parse(getRaw(k) || '[]') as T[]
  const putList = (k: string, v: unknown[]) => setRaw(k, JSON.stringify(v))

  const listeners = new Set<(s: ApiStatus) => void>()
  let online = true
  let flushing: Promise<number> | null = null
  let lastData: Snapshot | null = null

  const status = (): ApiStatus => ({ pending: getList(K.outbox).length, failed: getList<FailedWrite>(K.failed), online, adapter: adapter.kind })
  const emit = () => { const s = status(); listeners.forEach((fn) => fn(s)) }

  async function flush(): Promise<number> {
    if (flushing) return flushing
    flushing = (async () => {
      let sent = 0
      for (;;) {
        const box = getList<Queued>(K.outbox)
        if (!box.length) break
        const { qid, queuedAt, ...op } = box[0]
        let res: Response
        try {
          res = await adapter.call(op as WriteOp)
          online = true
        } catch (err) {
          if (err instanceof NetworkError) { online = false; break }
          throw err
        }
        if (isFail(res) && !PERMANENT_ERRORS.has(res.error)) break
        putList(K.outbox, getList<Queued>(K.outbox).filter((x) => x.qid !== qid))
        if (isFail(res)) putList(K.failed, [...getList(K.failed), { op, error: res.error, message: res.message, queuedAt }])
        else {
          sent += 1
          if (!lastData) lastData = emptySnapshot(now())
          applyOp(lastData, op as WriteOp, false)
          setRaw(K.cache, JSON.stringify(lastData))
        }
      }
      return sent
    })()
    try { return await flushing } finally { flushing = null; emit() }
  }

  async function write(op: WriteOp): Promise<{ queued: boolean }> {
    if (!lastData) lastData = (JSON.parse(getRaw(K.cache) || 'null') as Snapshot | null) ?? emptySnapshot(now())
    const qid = uuid()
    putList(K.outbox, [...getList(K.outbox), { ...op, qid, queuedAt: taipeiIso(now()) }])
    emit()
    await flush()
    return { queued: getList<Queued>(K.outbox).some((x) => x.qid === qid) }
  }

  function applyOp(data: Snapshot, op: WriteOp, pending: boolean) {
    const mark = pending ? { __pending: true as const } : {}
    if (op.action === 'setConfig') { data.config = { ...data.config, [op.key]: op.value }; return }
    if (op.action === 'upsertItem') {
      const i = data.items.findIndex((f) => f.id === op.record.id)
      const row = { ...op.record, ...mark }
      if (i < 0) data.items.push(row)
      else data.items[i] = pending ? { ...data.items[i], ...row } : { ...data.items[i], ...op.record }
      return
    }
    if (op.action === 'upsertWeight') {
      const byId = data.weights.find((w) => w.id === op.record.id)
      if (byId) return
      const live = data.weights.find((w) => w.day === op.record.day && !w.deleted)
      if (live) {
        Object.assign(live, { kg: op.record.kg, ts: op.record.ts, ...mark })
        if (!pending) delete live.__pending
        return
      }
      data.weights.push({ id: op.record.id, day: op.record.day, ts: op.record.ts, kg: op.record.kg, deleted: false, updated_at: '', ...mark })
      return
    }
    if (op.action === 'append') {
      const i = data.logs.findIndex((r) => r.id === op.record.id)
      if (i < 0) data.logs.push({ ...op.record, ...mark })
      else if (!pending) { const { __pending: _, ...rest } = data.logs[i]; data.logs[i] = rest as LogRecord }
      return
    }
    const table = op.table
    const rows: { id: string; deleted?: boolean }[] =
      table === 'Logs' ? data.logs : table === 'Items' ? data.items : table === 'Weights' ? data.weights : []
    const i = rows.findIndex((r) => r.id === op.id)
    if (i < 0) return
    if (op.action === 'softDelete') rows[i] = { ...rows[i], deleted: true, ...mark }
    else if (op.action === 'restore') rows[i] = { ...rows[i], deleted: false, ...mark }
    else if (op.action === 'update') rows[i] = { ...rows[i], ...op.patch, ...mark }
  }

  function view(snap: Snapshot): Snapshot {
    return applyPending(structuredClone(snap))
  }

  function applyPending(data: Snapshot): Snapshot {
    for (const { qid: _q, queuedAt: _t, ...op } of getList<Queued>(K.outbox)) applyOp(data, op as WriteOp, true)
    return data
  }

  return {
    status,
    flush,
    onStatus(fn: (s: ApiStatus) => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    peek(): Snapshot | null { return lastData ? view(lastData) : null },
    outbox(): Queued[] { return getList<Queued>(K.outbox) },

    async load(): Promise<Snapshot> {
      await flush().catch(() => 0)
      try {
        const res = await adapter.call({ action: 'read' })
        online = true
        if (isFail(res)) throw new ServerError(res.error, res.message)
        lastData = res as Snapshot
        if (!lastData.items) lastData.items = []
        if (!lastData.logs) lastData.logs = []
        if (!lastData.weights) lastData.weights = []
        if (!lastData.config) lastData.config = { ...DEFAULT_CONFIG }
        setRaw(K.cache, JSON.stringify(lastData))
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err
        online = false
        lastData = lastData ?? (JSON.parse(getRaw(K.cache) || 'null') as Snapshot | null) ?? emptySnapshot(now())
      } finally {
        emit()
      }
      return view(lastData)
    },

    async history(args: { table: 'Logs' | 'Weights'; before: string; limit?: number }) {
      const res = await adapter.call({ action: 'history', ...args })
      if (isFail(res)) throw new ServerError(res.error, res.message)
      return res
    },

    appendLog(record: LogRecord) { return write({ action: 'append', table: 'Logs', record }) },
    updateLog(id: string, patch: Partial<LogRecord>) { return write({ action: 'update', table: 'Logs', id, patch: patch as Record<string, unknown> }) },
    remove(table: 'Logs' | 'Weights' | 'Items', id: string) { return write({ action: 'softDelete', table, id }) },
    restore(table: 'Logs' | 'Weights' | 'Items', id: string) { return write({ action: 'restore', table, id }) },
    setConfig(key: string, value: string) { return write({ action: 'setConfig', key, value }) },
    upsertItem(record: ItemRecord) { return write({ action: 'upsertItem', record }) },
    upsertWeight(record: Pick<WeightRecord, 'day' | 'kg' | 'id' | 'ts'>) { return write({ action: 'upsertWeight', record }) },

    dismissFailed() { putList(K.failed, []); emit() },
    async retryFailed() {
      const failed = getList<FailedWrite>(K.failed)
      putList(K.failed, [])
      putList(K.outbox, [...getList(K.outbox), ...failed.map((f) => ({ ...f.op, qid: uuid(), queuedAt: f.queuedAt }))])
      emit()
      return flush()
    },
  }
}

export type Api = ReturnType<typeof createApi>
export { uuid }
