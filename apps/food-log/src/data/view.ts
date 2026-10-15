// 本機資料庫的列（packages/core 的型別）→ 畫面元件用的紀錄型別（src/types.ts）。
// 畫面元件只吃 props，型別維持 v1 的樣子（deleted、store、__write…），資料從 sync-client 的 hooks 來。
import { configToStrings } from '@food-log/core'
import type { ConfigRow, LogRow, StoreRow, WeightRow } from '@food-log/core'
import type { FailedRow } from '@food-log/sync-client'
import type { ConfigMap, LogRecord, StoreRecord, WeightRecord } from '@/types'

/** 還沒被伺服器確認的鍵（`<table>:<key>`）→ 最早排進佇列的時間（epoch ms）。 */
export type PendingInfo = ReadonlyMap<string, number>

export function toStoreRecord(s: StoreRow): StoreRecord {
  return {
    id: s.id,
    ts: s.ts,
    deleted: s.deleted_at !== null,
    updated_at: s.updated_at,
    name: s.name,
    last_eaten_at: s.last_eaten_at ?? '',
    created_by: s.created_by,
  }
}

export function toLogRecord(l: LogRow, pending?: PendingInfo, syncing = false): LogRecord {
  const queuedAt = pending?.get(`logs:${l.id}`)
  const rec: LogRecord = {
    id: l.id,
    ts: l.ts,
    deleted: l.deleted_at !== null,
    updated_at: l.updated_at,
    day: l.day,
    item_id: l.item_id ?? '',
    name: l.name,
    src: l.src,
    qty: l.qty,
    grams: l.grams,
    kcal: l.kcal,
    protein: l.protein,
    fat: l.fat,
    carb: l.carb,
    source: l.source,
    store: l.store_id ?? '',
  }
  if (queuedAt !== undefined) {
    rec.__pending = true
    rec.__write = 'pending'
    rec.__queuedAt = new Date(queuedAt).toISOString()
    if (syncing) rec.__syncing = true
  }
  return rec
}

export function toWeightRecord(w: WeightRow): WeightRecord {
  return { id: w.id, day: w.day, ts: w.ts, deleted: w.deleted_at !== null, updated_at: w.updated_at, kg: w.kg }
}

/** 設定列 → v1 的字串 map（畫面元件和趨勢函式吃的格式）。 */
export function toConfigMap(c: ConfigRow): ConfigMap {
  return configToStrings(c)
}

/** 失敗的「記一筆」：伺服器沒收，本機畫面已經還原；列在今天的清單裡，標「沒有存到 · 重試」。 */
export function failedLogRecord(f: FailedRow): LogRecord | null {
  if (f.name !== 'logs.add@1') return null
  const log = (f.args as { log?: Record<string, unknown> } | null)?.log
  if (!log || typeof log.id !== 'string') return null
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    id: log.id,
    ts: String(log.ts ?? ''),
    deleted: false,
    updated_at: '',
    day: String(log.day ?? ''),
    item_id: typeof log.item_id === 'string' ? log.item_id : '',
    name: String(log.name ?? ''),
    src: (log.src as LogRecord['src']) ?? '其他',
    qty: num(log.qty, 1),
    grams: typeof log.grams === 'number' ? log.grams : null,
    kcal: num(log.kcal),
    protein: num(log.protein),
    fat: num(log.fat),
    carb: num(log.carb),
    source: log.source === 'quick' ? 'quick' : 'app',
    store: typeof log.store_id === 'string' ? log.store_id : '',
    __write: 'failed',
    __failMessage: f.message || '沒有存到',
  }
}
