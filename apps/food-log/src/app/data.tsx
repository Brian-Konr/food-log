// 畫面要的資料，一次算好給所有 feature 用：從 sync-client 的 hooks（本機 Dexie 的畫面表）讀，
// 派生的數字（合計、剩餘、趨勢）一律走 packages/core，和 Kyujin 的 summary 同一份算法。
//
// 「不顯示假數字」：本機沒有伺服器資料（帳號模式還沒 pull 成功過）時，config 視為未知，目標一律是 0，
// loadState 是 skeleton／error-empty，畫面只畫灰條，不會用預設的 2000 kcal 去算剩餘。
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addDays, defaultConfigRow, formatRemain, parseTargets, remaining, sumLogs, taipeiToday } from '@food-log/core'
import type { ConfigRow, ItemRow, LogRow, StoreRow, WeightRow } from '@food-log/core'
import { CONFIG_KEY, useSyncClient, useSyncStatus } from '@food-log/sync-client'
import type { FailedRow, FoodLogDb } from '@food-log/sync-client'
import { mergeCatalog } from '@/data/catalog'
import { classifyError, deriveLoadState, errorCopy } from '@/data/loadstate'
import type { ErrorKind, LoadState } from '@/data/loadstate'
import { WRITE_FAILS_BEFORE_UNREACHABLE, networkState } from '@/data/network'
import { buildIndex, frequentChips } from '@/data/search'
import type { IndexedItem } from '@/data/search'
import { failedLogRecord, toConfigMap, toLogRecord, toStoreRecord, toWeightRecord } from '@/data/view'
import type { PendingInfo } from '@/data/view'
import type { DockChip } from '@/components/SearchDock'
import type { ConfigMap, LogRecord, MergedItem, NetworkState, StoreRecord, WeightRecord } from '@/types'
import { useServices } from './services'
import { useSession } from './session'

/** 近 35 天的紀錄就夠了（常吃、上次份量、趨勢 4 週）；更舊的留在本機，要查再開。 */
export const LOG_WINDOW_DAYS = 35

export interface Macros4 {
  kcal: number
  protein: number
  fat: number
  carb: number
}

export interface AppData {
  today: string
  /** 每秒一跳（只在有待送資料時），給「待上傳」判斷用。 */
  nowTick: number
  mode: 'trial' | 'account'
  /** 本機資料庫的 live query 都讀出來了。 */
  ready: boolean
  loadState: LoadState
  errorKind: ErrorKind | null
  errorReason: string | null
  errorCodeLine: string | null
  staleToday: boolean
  /** 今天的數字是可信的（可以畫剩餘）。 */
  todayKnown: boolean
  retrying: boolean
  network: NetworkState
  pending: number
  items: MergedItem[]
  itemsById: Map<string, MergedItem>
  indexed: IndexedItem[]
  stores: StoreRecord[]
  /** 近 35 天，含還沒被伺服器確認的（標 __write）。不含失敗的新增。 */
  logs: LogRecord[]
  todayLogs: LogRecord[]
  /** 今天失敗的「記一筆」：不在伺服器、也不在畫面表，只列在今天清單裡讓人重試或捨棄。 */
  failedTodayLogs: LogRecord[]
  /** logId → 失敗的 mutationId。 */
  failedByLogId: ReadonlyMap<string, number>
  failed: FailedRow[]
  weights: WeightRecord[]
  config: ConfigMap
  targets: Macros4
  eaten: Macros4 & { count: number }
  remain: Macros4
  /** 搜尋、選店、店家 Sheet 頂上那行：今天的數字不可信時是「同步後顯示剩餘」，不畫假數字。 */
  remainLine: string
  dockChips: DockChip[]
  /** 立刻同步一次（SyncBadge 的「重試」）。 */
  retry: () => void
}

const DataContext = createContext<AppData | null>(null)

export function useAppData(): AppData {
  const d = useContext(DataContext)
  if (!d) throw new Error('useAppData 必須在 <DataProvider> 底下使用')
  return d
}

/** 台北今天：每分鐘與回到前景時重算（跨過午夜要換日）。 */
export function useToday(now: () => number): string {
  const [today, setToday] = useState(() => taipeiToday(now()))
  useEffect(() => {
    const tick = () => setToday(taipeiToday(now()))
    tick()
    const t = setInterval(tick, 60_000)
    const vis = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', vis)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', vis)
    }
  }, [now])
  return today
}

/** navigator.onLine，跟著 online／offline 事件更新。 */
function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    addEventListener('online', on)
    addEventListener('offline', off)
    return () => {
      removeEventListener('online', on)
      removeEventListener('offline', off)
    }
  }, [])
  return online
}

/**
 * 本機資料庫的一張「同一時刻」快照：所有表在同一個 Dexie 唯讀交易裡一起讀，再交給 React。
 * 不能每張表各開一個 live query：pull 一次寫好所有表，但各 live query 會各自重跑，
 * 中間會有一個畫面「紀錄已經來了、設定還是預設值」，那就是假數字（預設的 2000 kcal）。
 * （sync-client 的 useItems／useConfig… 是各表獨立的版本，給單一表的畫面用。）
 */
interface Snapshot {
  items: ItemRow[]
  stores: StoreRow[]
  favIds: string[]
  config: ConfigRow
  logs: LogRow[]
  weights: WeightRow[]
  failed: FailedRow[]
  pending: PendingInfo
  /** 本機有伺服器資料（至少成功 pull 過一次；cookie 和資料同一個交易寫入）。 */
  hasServerData: boolean
}

const live = <T extends { deleted_at: string | null }>(r: T): boolean => r.deleted_at === null

async function readSnapshot(db: FoodLogDb, userId: string | null, fromDay: string, toDay: string): Promise<Snapshot> {
  return db.transaction('r', db.allTables, async () => {
    const [items, stores, favs, config, logs, weights, failed, pending, cookie] = await Promise.all([
      db.view('items').toArray(),
      db.view('stores').toArray(),
      db.view('favorites').toArray(),
      db.view('config').get(CONFIG_KEY),
      db.view('logs').where('day').between(fromDay, toDay, true, true).toArray(),
      db.view('weights').orderBy('day').toArray(),
      db.failed.orderBy('mutationId').toArray(),
      db.pending.toArray(),
      db.getMeta<string>('cookie', ''),
    ])
    const info = new Map<string, number>()
    for (const p of pending) {
      for (const k of p.touched) {
        const prev = info.get(k)
        if (prev === undefined || p.clientTs < prev) info.set(k, p.clientTs)
      }
    }
    return {
      items: items.filter(live),
      stores: stores.filter(live),
      favIds: favs.filter(live).map((f) => f.item_id),
      config: config ?? defaultConfigRow(userId ?? 'local'),
      logs: logs.filter(live).sort((a, b) => a.day.localeCompare(b.day) || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)),
      weights: weights.filter(live),
      failed,
      pending: info,
      hasServerData: cookie !== '',
    }
  })
}

const ZERO: Macros4 = { kcal: 0, protein: 0, fat: 0, carb: 0 }

export function DataProvider(props: { children?: ReactNode }) {
  const client = useSyncClient()
  const { now, catalogItems, tracker } = useServices()
  const status = useSyncStatus()
  const session = useSession(tracker)
  const today = useToday(now)

  const fromDay = addDays(today, -LOG_WINDOW_DAYS)
  const snap = useLiveQuery(() => readSnapshot(client.db, client.userId, fromDay, today), [client, fromDay, today])
  const itemRows = snap?.items
  const storeRows = snap?.stores
  const favIds = snap?.favIds
  const configRow = snap?.config
  const logRows = snap?.logs
  const weightRows = snap?.weights
  const failedRows = snap?.failed
  const pendingInfo = snap?.pending

  const ready = snap !== undefined
  const trial = client.mode === 'trial'
  const hasData = trial || snap?.hasServerData === true
  const browserOnline = useBrowserOnline()

  // 錯誤：只看 status.error（NET-0、API-<status>、unauthorized、client_too_old）。
  // 這次打開已經同步成功過、之後只是離線 → 不改成 error-cached，頂列才能顯示「離線 · N 筆待上傳」。
  let error = !trial && status.error !== null ? classifyError(status.error, browserOnline) : null
  if (error?.kind === 'offline' && session.fresh) error = null
  const loadState = deriveLoadState({ booting: !ready, hasData, fresh: session.fresh, error })
  const copy = error ? errorCopy(error.kind, error.code) : null
  const staleToday = !trial && hasData && !session.fresh && status.lastPullAt !== null && taipeiToday(status.lastPullAt) !== today
  const todayKnown = (loadState === 'fresh' || (loadState === 'cached-syncing' && !staleToday)) && !staleToday
  const syncing = status.phase === 'syncing'

  const pending = status.pendingCount
  const backendOk = !((status.phase === 'offline' || status.phase === 'error') && session.failStreak >= WRITE_FAILS_BEFORE_UNREACHABLE)
  const network = networkState({
    browserOnline,
    backendOk,
    pending,
    failStreak: session.failStreak,
    hasCache: hasData,
  })

  // 有待送資料時每秒跳一下，LogRow 才知道什麼時候超過 3 秒要標「待上傳」。
  const [nowTick, setNowTick] = useState(() => now())
  useEffect(() => {
    setNowTick(now())
    if (!pending) return
    const t = setInterval(() => setNowTick(now()), 1000)
    return () => clearInterval(t)
  }, [pending, now])

  const stores = useMemo(() => (storeRows ?? []).map(toStoreRecord), [storeRows])
  const items = useMemo(() => mergeCatalog(catalogItems, itemRows ?? [], favIds ?? [], storeRows ?? []), [catalogItems, itemRows, favIds, storeRows])
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const indexed = useMemo(() => buildIndex(items), [items])
  const logs = useMemo(() => (logRows ?? []).map((l) => toLogRecord(l, pendingInfo, syncing)), [logRows, pendingInfo, syncing])
  const todayLogs = useMemo(() => logs.filter((l) => l.day === today), [logs, today])
  const weights = useMemo(() => (weightRows ?? []).map(toWeightRecord), [weightRows])
  const failed = useMemo(() => failedRows ?? [], [failedRows])
  const { failedTodayLogs, failedByLogId } = useMemo(() => {
    const byId = new Map<string, number>()
    const list: LogRecord[] = []
    for (const f of failed) {
      const rec = failedLogRecord(f)
      if (!rec) continue
      byId.set(rec.id, f.mutationId)
      if (rec.day === today) list.push(rec)
    }
    return { failedTodayLogs: list, failedByLogId: byId as ReadonlyMap<string, number> }
  }, [failed, today])

  const configMap = useMemo<ConfigMap>(() => (hasData && configRow ? toConfigMap(configRow) : {}), [hasData, configRow])
  const targets = useMemo(() => (hasData ? parseTargets(configMap) : ZERO), [hasData, configMap])
  const eaten = useMemo(() => sumLogs(todayLogs), [todayLogs])
  const remain = useMemo(() => remaining(targets, eaten), [targets, eaten])

  const remainLine = todayKnown
    ? `${formatRemain(remain.kcal, 'kcal')} · ${formatRemain(remain.protein, 'g')} 蛋白質`
    : '同步後顯示剩餘'

  const dockChips = useMemo<DockChip[]>(() => {
    const eatenStores = stores
      .filter((s) => !s.deleted && s.last_eaten_at)
      .sort((a, b) => b.last_eaten_at.localeCompare(a.last_eaten_at))
      .slice(0, 3)
    const itemLimit = 6 - eatenStores.length
    const itemList = frequentChips(items.filter((i) => !i.storeId), logs, today, itemLimit)
    return [
      ...eatenStores.map((s) => ({ kind: 'store' as const, id: s.id, name: s.name })),
      ...itemList.map((item) => ({ kind: 'item' as const, item })),
    ]
  }, [stores, items, logs, today])

  const value = useMemo<AppData>(
    () => ({
      today,
      nowTick,
      mode: client.mode,
      ready,
      loadState,
      errorKind: error?.kind ?? null,
      errorReason: copy?.reason ?? null,
      errorCodeLine: copy?.codeLine ?? null,
      staleToday,
      todayKnown,
      retrying: syncing,
      network,
      pending,
      items,
      itemsById,
      indexed,
      stores,
      logs,
      todayLogs,
      failedTodayLogs,
      failedByLogId,
      failed,
      weights,
      config: configMap,
      targets,
      eaten,
      remain,
      remainLine,
      dockChips,
      retry: () => void client.syncNow(),
    }),
    // error/copy 由 status、session 決定
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today, nowTick, client, ready, loadState, error?.kind, error?.code, staleToday, todayKnown, syncing, network, pending, items, itemsById, indexed, stores, logs, todayLogs, failedTodayLogs, failedByLogId, failed, weights, configMap, targets, eaten, remain, remainLine, dockChips],
  )
  return <DataContext.Provider value={value}>{props.children}</DataContext.Provider>
}
