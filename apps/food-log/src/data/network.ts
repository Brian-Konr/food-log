// 連線橫幅：瀏覽器 navigator.onLine === false 立刻顯示「連不到 Google 試算表」。
// 背景讀取失敗一次不顯示，15 秒後重讀；沒有快取且連續失敗 2 次才顯示。
// 有快取的讀取失敗不顯示橫幅，用頂列 SyncBadge。
// 寫入的 NetworkError（含 55 秒逾時）一次不把 online 設成 false、不顯示橫幅；
// 同一筆留在佇列，依序再等 2 秒、5 秒、15 秒各試一次，三次都失敗才顯示橫幅。
// 不要因為佇列裡有紀錄就把一次寫入失敗當成斷線。
import type { NetworkState } from '@/types'

export const UNREACHABLE_AFTER_FAILS = 2
/** 背景讀取第一次失敗後，隔多久再確認一次（不用等 2 分鐘的定時讀取） */
export const RECHECK_AFTER_FAIL_MS = 15_000

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
