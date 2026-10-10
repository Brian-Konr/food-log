// 連線橫幅要不要出現。Apps Script 偶爾冷啟動，背景讀取失敗一次不代表真的連不到，
// 所以只有「手機裡有待送紀錄」或「連續失敗 2 次以上」才顯示「連不到 Google 試算表」。
import type { NetworkState } from '@/types'

export const UNREACHABLE_AFTER_FAILS = 2
/** 背景讀取第一次失敗後，隔多久再確認一次（不用等 2 分鐘的定時讀取） */
export const RECHECK_AFTER_FAIL_MS = 15_000

export function networkState(s: { browserOnline: boolean; backendOk: boolean; pending: number; failStreak: number }): NetworkState {
  if (!s.browserOnline) return 'offline'
  if (s.backendOk) return 'online'
  return s.pending > 0 || s.failStreak >= UNREACHABLE_AFTER_FAILS ? 'unreachable' : 'online'
}
