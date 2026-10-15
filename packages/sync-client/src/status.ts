// 同步狀態：給 UI（NetworkBanner、SyncBadge、設定頁）用的小型 store，搭配 useSyncExternalStore。
//   phase        idle 閒置 | syncing 同步中 | offline 連不上（退避中） | error 伺服器暫時性錯誤或未知錯誤
//                | auth 要重新登入（pending 保留） | too_old 有新版本 | local 本機試用模式（不同步）
//   pendingCount 還沒被伺服器確認的 mutation 數
//   failed       failed 表的筆數（明細用 useFailed）
//   lastPullAt   最近一次完整 pull 完成的時間（epoch ms）；從沒成功過是 null
//   error        上一次失敗的代碼：NET-0、API-<status>、unauthorized、client_too_old；沒有失敗是 null
//   hasServerData 本機有伺服器資料（至少成功 pull 過一次）。false 時畫面不能顯示假數字（loadstate 的規則）。
import type { FoodLogDb } from './db'

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error' | 'auth' | 'too_old' | 'local'

export interface SyncStatus {
  phase: SyncPhase
  pendingCount: number
  failed: number
  lastPullAt: number | null
  error: string | null
  hasServerData: boolean
}

export const initialStatus = (phase: SyncPhase = 'idle'): SyncStatus => ({
  phase,
  pendingCount: 0,
  failed: 0,
  lastPullAt: null,
  error: null,
  hasServerData: false,
})

export class StatusStore {
  private status: SyncStatus
  private readonly listeners = new Set<() => void>()

  constructor(initial: SyncStatus = initialStatus()) {
    this.status = initial
  }

  /** useSyncExternalStore 的 getSnapshot：內容沒變就回同一個物件。 */
  getSnapshot = (): SyncStatus => this.status

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  set(patch: Partial<SyncStatus>): void {
    const next = { ...this.status, ...patch }
    if ((Object.keys(next) as (keyof SyncStatus)[]).every((k) => next[k] === this.status[k])) return
    this.status = next
    for (const l of [...this.listeners]) l()
  }

  /** 從 Dexie 重新數 pending、failed，並讀 cookie 與 lastPullAt。 */
  async refresh(db: FoodLogDb): Promise<void> {
    const [pendingCount, failed, cookie, lastPullAt] = await Promise.all([
      db.pending.count(),
      db.failed.count(),
      db.getMeta<string>('cookie', ''),
      db.getMeta<number | null>('lastPullAt', null),
    ])
    this.set({ pendingCount, failed, hasServerData: cookie !== '', lastPullAt })
  }
}
