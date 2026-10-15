// 連線橫幅：瀏覽器 navigator.onLine === false 立刻顯示「連不到伺服器」。
// 同步失敗一次不顯示（退避 2／5／15 秒再試）；本機沒有伺服器資料且連續失敗 2 次才顯示。
// 本機有資料時的同步失敗不顯示橫幅，用頂列 SyncBadge。
// 寫入的 NetworkError（含 15 秒逾時）一次不把 online 設成 false、不顯示橫幅；
// 同一筆留在待送佇列，依序再等 2 秒、5 秒、15 秒各試一次，三次都失敗才顯示橫幅。
// 不要因為佇列裡有紀錄就把一次寫入失敗當成斷線。
import type { NetworkState } from '@/types'

export const UNREACHABLE_AFTER_FAILS = 2
/** 同步退避用盡的次數（sync-client 的 BACKOFF_MS 有 3 段）：寫入連續失敗這麼多次才算連不到。 */
export const WRITE_FAILS_BEFORE_UNREACHABLE = 3

export function networkState(s: {
  browserOnline: boolean
  backendOk: boolean
  pending: number
  failStreak: number
  hasCache: boolean
}): NetworkState {
  if (!s.browserOnline) return 'offline'
  if (!s.backendOk && s.pending > 0) return 'unreachable'
  if (s.hasCache) return 'online'
  if (s.failStreak >= UNREACHABLE_AFTER_FAILS) return 'unreachable'
  return 'online'
}
