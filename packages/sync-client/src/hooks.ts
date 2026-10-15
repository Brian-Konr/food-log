// React hooks（dexie-react-hooks 的 useLiveQuery）：畫面只讀本機的畫面表，所以離線、同步中、剛 mutate 完都立刻看得到。
// 需要在 <SyncProvider client={…}> 底下使用。
// 回傳 undefined = 還在載入（loadstate 要顯示骨架，不要顯示假數字）；查詢完成才會是陣列／物件。
// 已軟刪除的列（deleted_at != null）一律不回傳。
import { createContext, createElement, useContext, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { defaultConfigRow } from '@food-log/core'
import type { ConfigRow, ItemRow, LogRow, StoreRow, WeightRow } from '@food-log/core'
import { CONFIG_KEY } from './db'
import type { FailedRow } from './db'
import type { SyncClient } from './client'
import type { SyncStatus } from './status'

const SyncContext = createContext<SyncClient | null>(null)

export function SyncProvider(props: { client: SyncClient; children?: ReactNode }) {
  return createElement(SyncContext.Provider, { value: props.client }, props.children)
}

export function useSyncClient(): SyncClient {
  const c = useContext(SyncContext)
  if (!c) throw new Error('useSyncClient 必須在 <SyncProvider> 底下使用')
  return c
}

const live = <T extends { deleted_at: string | null }>(r: T): boolean => r.deleted_at === null

/** 某一天（台北日 YYYY-MM-DD）的紀錄，依 ts 遞增。 */
export function useLogsForDay(day: string): LogRow[] | undefined {
  const { db } = useSyncClient()
  return useLiveQuery(async () => (await db.view('logs').where('day').equals(day).toArray()).filter(live).sort(byTs), [db, day])
}

/** 日期區間（含頭尾）的紀錄，依 day、ts 遞增。 */
export function useLogsRange(fromDay: string, toDay: string): LogRow[] | undefined {
  const { db } = useSyncClient()
  return useLiveQuery(
    async () => (await db.view('logs').where('day').between(fromDay, toDay, true, true).toArray()).filter(live).sort((a, b) => a.day.localeCompare(b.day) || byTs(a, b)),
    [db, fromDay, toDay],
  )
}

export function useItems(): ItemRow[] | undefined {
  const { db } = useSyncClient()
  return useLiveQuery(async () => (await db.view('items').toArray()).filter(live), [db])
}

export function useStores(): StoreRow[] | undefined {
  const { db } = useSyncClient()
  return useLiveQuery(async () => (await db.view('stores').toArray()).filter(live), [db])
}

/** 體重，依日期遞增；可以用 from／to（含）限制區間（體重圖的 1W／1M／3M）。 */
export function useWeights(range: { from?: string; to?: string } = {}): WeightRow[] | undefined {
  const { db } = useSyncClient()
  const { from, to } = range
  return useLiveQuery(async () => {
    const all = await db.view('weights').orderBy('day').toArray()
    return all.filter((w) => live(w) && (from === undefined || w.day >= from) && (to === undefined || w.day <= to))
  }, [db, from, to])
}

/** 收藏的品項 id（含官方品項 fm:／711:）。 */
export function useFavorites(): string[] | undefined {
  const { db } = useSyncClient()
  return useLiveQuery(async () => (await db.view('favorites').toArray()).filter(live).map((f) => f.item_id), [db])
}

/** 設定；使用者還沒有設定時是預設值（和伺服器的 getConfig 一致）。 */
export function useConfig(): ConfigRow | undefined {
  const { db, userId } = useSyncClient()
  return useLiveQuery(async () => (await db.view('config').get(CONFIG_KEY)) ?? defaultConfigRow(userId ?? 'local'), [db, userId])
}

/** 還沒被伺服器確認的鍵（`<table>:<key>`，例如 `logs:abc`），給列表顯示「同步中」。 */
export function usePendingKeys(): ReadonlySet<string> | undefined {
  const { db } = useSyncClient()
  return useLiveQuery(async () => new Set((await db.pending.toArray()).flatMap((p) => p.touched)), [db])
}

/** 失敗的 mutation（業務錯誤），依 mutationId 遞增。 */
export function useFailed(): FailedRow[] | undefined {
  const { db } = useSyncClient()
  return useLiveQuery(() => db.failed.orderBy('mutationId').toArray(), [db])
}

export function useSyncStatus(): SyncStatus {
  const { status } = useSyncClient()
  return useSyncExternalStore(status.subscribe, status.getSnapshot, status.getSnapshot)
}

function byTs(a: { ts: string }, b: { ts: string }): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
}
