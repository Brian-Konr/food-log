// 資料層：畫面只跟這裡講話。所有寫入先進待送佇列，再依序送出。
import type { ItemRecord, LogRecord, Snapshot, StoreRecord, WeightRecord } from '@/types'
import { taipeiIso, taipeiToday } from '@/lib/day'
import { DEFAULT_CONFIG } from '@/data/defaults'
import { normalizeSheetSrc } from '@/data/codec'
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

function opTable(op: WriteOp): 'Logs' | 'Items' | 'Stores' | 'Weights' | null {
  if (op.action === 'append') return 'Logs'
  if (op.action === 'upsertItem') return 'Items'
  if (op.action === 'upsertStore') return 'Stores'
  if (op.action === 'upsertWeight') return 'Weights'
  if (op.action === 'update' || op.action === 'softDelete' || op.action === 'restore') return op.table
  return null
}

function isCreate(op: WriteOp): boolean {
  return op.action === 'append' || op.action === 'upsertItem' || op.action === 'upsertStore' || op.action === 'upsertWeight'
}

type ClearedStore = { qid: string; id: string; store: string }
type LocalStash = { outbox: Queued[]; failed: FailedWrite[]; cleared?: ClearedStore[]; at?: number }
// 本機丟掉的暫存留多久（和刪除 toast 同一個生命週期，留一點餘裕）。
const LOCAL_UNDO_TTL_MS = 10_000
type WriteTable = 'Logs' | 'Weights' | 'Items' | 'Stores'

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
  let failedNotified = new Set<string>()
  let readySettled = false
  const localUndo = new Map<string, LocalStash>()
  let persistChain: Promise<unknown> = Promise.resolve()

  const status = (): ApiStatus => ({ pending: outbox.length, failed: [...failed], online, adapter: adapter.kind })
  const emit = () => { const s = status(); listeners.forEach((fn) => fn(s)) }

  function pruneLocalUndo() {
    const t = now()
    for (const [k, st] of [...localUndo]) {
      if (typeof st.at === 'number' && t - st.at > LOCAL_UNDO_TTL_MS) localUndo.delete(k)
    }
  }

  function pruneFailedNotified() {
    pruneLocalUndo()
    const keep = new Set<string>()
    for (const f of failed) keep.add(f.qid)
    for (const stash of localUndo.values()) {
      for (const f of stash.failed) keep.add(f.qid)
    }
    for (const q of [...failedNotified]) {
      if (!keep.has(q)) failedNotified.delete(q)
    }
  }

  function persistQueue(): Promise<void> {
    const job = persistChain.then(async () => {
      pruneFailedNotified()
      await kv.set('outbox', JSON.stringify(outbox))
      await kv.set('failed', JSON.stringify(failed))
      await kv.set('failedNotified', JSON.stringify([...failedNotified]))
      await kv.set('localUndo', JSON.stringify([...localUndo.entries()].map(([key, stash]) => ({ key, stash }))))
    })
    persistChain = job.then(() => {}, () => {})
    return job
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

  function relatedKeys(table: WriteTable, id: string): Set<string> {
    const keys = new Set<string>([table + '\n' + id])
    if (table !== 'Stores') return keys
    // 只連帶店家自己的「從未同步的」品項。Logs 不連帶（v1：刪店家不動 Logs），見 clearLogStores。
    // 對已在伺服器上的品項的編輯也不碰：留在佇列，伺服器若拒收會進 failed 讓使用者看到。
    const scan = (op: WriteOp) => {
      if (op.action === 'upsertItem' && op.record.store === id && !serverHas('Items', op.record.id)) keys.add('Items\n' + op.record.id)
    }
    for (const q of outbox) scan(q)
    for (const f of failed) scan(f.op)
    return keys
  }

  function opKey(op: WriteOp): string | null {
    const table = opTable(op)
    const id = recordId(op)
    if (!table || !id) return null
    return table + '\n' + id
  }

  function takeRelated(table: WriteTable, id: string): LocalStash {
    const keys = relatedKeys(table, id)
    const hit = (op: WriteOp) => {
      const k = opKey(op)
      return !!k && keys.has(k)
    }
    const takenOut = outbox.filter((op) => hit(op))
    const takenFail = failed.filter((f) => hit(f.op))
    outbox = outbox.filter((op) => !hit(op))
    failed = failed.filter((f) => !hit(f.op))
    for (const q of takenOut) failedNotified.delete(q.qid)
    for (const f of takenFail) failedNotified.delete(f.qid)
    return { outbox: structuredClone(takenOut), failed: structuredClone(takenFail) }
  }

  // 最後一次伺服器快照（讀取結果／快取，加上已成功送出的 op）有沒有這筆 id。不含 outbox／failed 的樂觀疊加。
  function serverHas(table: WriteTable, id: string): boolean {
    if (!lastData) return false
    const rows: { id: string }[] =
      table === 'Logs' ? lastData.logs : table === 'Items' ? lastData.items : table === 'Weights' ? lastData.weights : (lastData.stores ?? [])
    return rows.some((r) => r.id === id)
  }

  // 店家被本機丟掉時，指到它的待送 Logs 不能跟著丟，也不能指向不存在的店：清掉 store 欄位。
  function clearLogStores(storeId: string): ClearedStore[] {
    const cleared: ClearedStore[] = []
    const fix = <T extends WriteOp>(op: T, qid: string): T => {
      if (op.action !== 'append' || op.record.store !== storeId) return op
      cleared.push({ qid, id: op.record.id, store: storeId })
      return { ...op, record: { ...op.record, store: '' } } as T
    }
    outbox = outbox.map((q) => fix(q, q.qid))
    failed = failed.map((f) => { const op = fix(f.op, f.qid); return op === f.op ? f : { ...f, op } })
    return cleared
  }

  // 「從未同步的 create」：有排隊／失敗的 create，而且伺服器快照裡沒有這筆。
  // upsertItem／upsertStore 也會編輯已存在的列（離線改名），那種不是 create，刪除必須送 softDelete。
  function hasUnsyncedCreate(table: WriteTable, id: string): boolean {
    if (serverHas(table, id)) return false
    const hit = (op: WriteOp) => isCreate(op) && opTable(op) === table && recordId(op) === id
    return outbox.some((op) => hit(op)) || failed.some((f) => hit(f.op))
  }

  async function dropUnsyncedCreate(table: WriteTable, id: string): Promise<{ queued: boolean; qid: string }> {
    const key = `${table}:${id}`
    if (localUndo.has(key)) return { queued: false, qid: '' }
    const taken = takeRelated(table, id)
    if (table === 'Stores') taken.cleared = clearLogStores(id)
    taken.at = now()
    localUndo.set(key, taken)
    emit()
    await persistQueue()
    return { queued: false, qid: '' }
  }

  function autoHeal(): number {
    const drop = new Set<string>()
    for (const f of failed) {
      if (f.op.action === 'softDelete' && f.error === 'not_found') drop.add(f.qid)
    }
    const rows = [
      ...outbox.map((op) => ({ qid: op.qid, op })),
      ...failed.map((f) => ({ qid: f.qid, op: f.op })),
    ]
    const groups = new Map<string, { qid: string; op: WriteOp }[]>()
    for (const row of rows) {
      const table = opTable(row.op)
      const id = recordId(row.op)
      if (!table || !id) continue
      const key = table + '\n' + id
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }
    const failErr = new Map(failed.map((f) => [f.qid, f.error]))
    for (const [key, list] of groups) {
      const creates = list.filter((r) => isCreate(r.op))
      const dels = list.filter((r) => r.op.action === 'softDelete')
      if (!creates.length || !dels.length) continue
      const [table, id] = key.split('\n') as [WriteTable, string]
      // 伺服器回過 not_found，就證明這筆從沒同步；否則看啟動時的快取（伺服器快照）有沒有這筆。
      // append 永遠是 create；upsert* 也可能是對已存在列的編輯，沒有快取就不丟（保守，保留刪除）。
      const proven = dels.some((r) => failErr.get(r.qid) === 'not_found')
      const neverSynced = proven || (!serverHas(table, id) && (!creates.some((r) => r.op.action !== 'append') || !!cacheMeta))
      if (!neverSynced) continue
      for (const r of list) drop.add(r.qid)
    }
    if (drop.size === 0) return 0
    const before = outbox.length + failed.length
    outbox = outbox.filter((op) => !drop.has(op.qid))
    failed = failed.filter((f) => !drop.has(f.qid))
    for (const q of drop) failedNotified.delete(q)
    return before - outbox.length - failed.length
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
      // 已存在的列被刪除後，失敗的編輯不能把它在畫面上復活（編輯仍留在 failed，由使用者重試或捨棄）
      if (f.op.action === 'upsertItem') {
        const rid = f.op.record.id
        if (data.items.some((r) => r.id === rid && r.deleted)) continue
      }
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
        const missingDelete = isFail(res) && (rest as WriteOp).action === 'softDelete' && res.error === 'not_found'
        if (isFail(res) && !missingDelete && !PERMANENT_ERRORS.has(res.error)) { scheduleRetry(false); break }
        if (isFail(res) && !missingDelete) {
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
        if (missingDelete) {
          const del = rest as WriteOp & { action: 'softDelete'; table: WriteTable; id: string }
          takeRelated(del.table, del.id)
          if (del.table === 'Stores') clearLogStores(del.id)
          localUndo.delete(`${del.table}:${del.id}`)
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
    failedNotified = new Set(parseList<string>(await kv.get('failedNotified')))
    for (const e of parseList<{ key: string; stash: LocalStash }>(await kv.get('localUndo'))) {
      const st = e?.stash
      if (!e?.key || !st || !Array.isArray(st.outbox) || !Array.isArray(st.failed)) continue
      if (typeof st.at !== 'number' || now() - st.at > LOCAL_UNDO_TTL_MS) continue
      localUndo.set(e.key, st)
    }
    await migrateFromLocalStorage()
    cacheMeta = await loadCache(kv)
    if (cacheMeta) lastData = snapshotFromCache(cacheMeta)
    const o = parseList<Queued>(await kv.get('outbox'))
    const f = parseList<FailedWrite>(await kv.get('failed'))
    if (o.length) outbox = o
    if (f.length) failed = f
    const n = autoHeal()
    if (n > 0) {
      console.info('food-log auto-heal ' + n)
      await persistQueue()
    }
    emit()
    readySettled = true
    void flush().catch(() => 0)
  })()

  return {
    status,
    flush,
    ready,
    onStatus(fn: (s: ApiStatus) => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    peek(): Snapshot | null { return lastData ? view(lastData) : null },
    outbox(): Queued[] { return [...outbox] },
    failed(): FailedWrite[] { return [...failed] },
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
    remove(table: WriteTable, id: string) {
      const run = () => hasUnsyncedCreate(table, id)
        ? dropUnsyncedCreate(table, id)
        : write({ action: 'softDelete', table, id })
      if (readySettled) return Promise.resolve(run())
      return ready.then(run)
    },
    undoLocalDrop(table: WriteTable, id: string): boolean {
      const key = `${table}:${id}`
      pruneLocalUndo()
      const stash = localUndo.get(key)
      if (!stash) return false
      outbox = unionByQid(outbox, stash.outbox)
      failed = unionByQid(failed, stash.failed)
      for (const c of stash.cleared ?? []) {
        const q = outbox.find((x) => x.qid === c.qid)
        const f = failed.find((x) => x.qid === c.qid)
        if (q && q.action === 'append') q.record = { ...q.record, store: c.store }
        else if (f && f.op.action === 'append') f.op = { ...f.op, record: { ...f.op.record, store: c.store } }
        else {
          // 那筆 Log 已經送出（store 是空的）：補一個 update，把店家接回去。
          outbox = [...outbox, { action: 'update', table: 'Logs', id: c.id, patch: { store: c.store }, qid: uuid(), queuedAt: taipeiIso(now()) }]
        }
      }
      localUndo.delete(key)
      for (const f of stash.failed) failedNotified.add(f.qid)
      emit()
      void persistQueue()
      if (outbox.length > 0) void flush()
      return true
    },
    async failedNotified(): Promise<string[]> {
      await ready
      return [...failedNotified]
    },
    async markFailedNotified(qid: string): Promise<void> {
      await ready
      failedNotified.add(qid)
      await persistQueue()
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
      for (const f of moving) failedNotified.delete(f.qid)
      outbox = [...outbox, ...moving.map((f) => {
        let op = f.op
        if (op.action === 'append') {
          const next = normalizeSheetSrc(op.record.src)
          if (next !== op.record.src) op = { ...op, record: { ...op.record, src: next as LogRecord['src'] } }
        } else if (op.action === 'upsertItem') {
          const next = normalizeSheetSrc(op.record.src)
          if (next !== op.record.src) op = { ...op, record: { ...op.record, src: next as ItemRecord['src'] } }
        }
        return { ...op, qid: f.qid, queuedAt: f.queuedAt, groupId: f.groupId, label: f.label }
      })]
      await persistQueue()
      emit()
      return flush()
    },
    async discardFailed(qid: string) {
      await ready
      const one = failed.find((f) => f.qid === qid)
      const gid = one?.groupId
      const dropping = failed.filter((f) => f.qid === qid || (gid && f.groupId === gid))
      for (const f of dropping) failedNotified.delete(f.qid)
      failed = failed.filter((f) => f.qid !== qid && !(gid && f.groupId === gid))
      await persistQueue()
      emit()
    },
    async dropQueued(qid: string) {
      await ready
      const one = outbox.find((x) => x.qid === qid)
      const gid = one?.groupId
      const dropping = outbox.filter((x) => x.qid === qid || (gid && x.groupId === gid))
      for (const x of dropping) failedNotified.delete(x.qid)
      outbox = outbox.filter((x) => x.qid !== qid && !(gid && x.groupId === gid))
      await persistQueue()
      emit()
    },
  }
}

export type Api = ReturnType<typeof createApi>
export { uuid }
