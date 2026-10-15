// 載入五態（v1.5 規則，v2 照舊）：
//   skeleton        還在開本機資料庫，或帳號模式還沒有任何伺服器資料 → 灰條，不顯示任何數字
//   cached-syncing  本機已有資料、這次打開還沒同步成功 → 畫本機資料，頂列顯示「同步中」
//   fresh           這次打開已同步成功（試用模式：本機資料就是正本）
//   error-cached    同步失敗，但本機有資料 → 畫本機資料，頂列顯示「沒有同步 · 重試」
//   error-empty     同步失敗，而且本機沒有伺服器資料 → 「讀不到今天的資料」，沒有數字
// 「不顯示假數字」：config 還沒從伺服器來（hasData = false）時，不能用預設的 2000 kcal 去畫剩餘。
import { AuthError, HttpError, NetworkError, TooOldError } from '@food-log/sync-client'

export type LoadState = 'skeleton' | 'cached-syncing' | 'fresh' | 'error-cached' | 'error-empty'
export type ErrorKind = 'offline' | 'server' | 'auth'

export function deriveLoadState(input: {
  /** 本機資料庫還沒讀出來（live query 還是 undefined）。 */
  booting: boolean
  /** 本機有可以顯示的資料：帳號模式 = 至少成功 pull 過一次；試用模式 = 永遠是 true。 */
  hasData: boolean
  /** 這次打開已經同步成功過。 */
  fresh: boolean
  error: { kind: ErrorKind; code: string } | null
}): LoadState {
  if (input.booting) return 'skeleton'
  // fresh 要本機真的讀得到那次同步的資料才算（快照比同步狀態晚幾毫秒更新時，這一瞬間還是骨架）
  if (input.fresh && input.hasData && !input.error) return 'fresh'
  if (input.error && input.hasData) return 'error-cached'
  if (input.error && !input.hasData) return 'error-empty'
  if (input.hasData && !input.fresh && !input.error) return 'cached-syncing'
  return 'skeleton'
}

export function errorCopy(kind: ErrorKind, code: string): { reason: string; codeLine: string } {
  if (kind === 'offline') return { reason: '沒有網路連線', codeLine: `錯誤代碼 ${code || 'NET-0'}` }
  if (kind === 'auth') return { reason: '登入過期，請重新登入', codeLine: `錯誤代碼 ${code || 'unauthorized'}` }
  return { reason: '伺服器沒有回應，可能是暫時的問題', codeLine: `錯誤代碼 ${code || 'API-503'}` }
}

/**
 * 同步失敗 → 畫面用的分類。接受 sync-client 丟出的錯誤物件，或 SyncStatus.error 存的代碼字串。
 * 代碼：NET-0（連不上、逾時）、API-<status>（伺服器回非 2xx）、unauthorized（401）、client_too_old（409）。
 */
export function classifyError(err: unknown, browserOnline: boolean): { kind: ErrorKind; code: string } {
  if (!browserOnline) return { kind: 'offline', code: 'NET-0' }
  if (err instanceof NetworkError) return { kind: 'offline', code: 'NET-0' }
  if (err instanceof AuthError) return { kind: 'auth', code: 'unauthorized' }
  if (err instanceof HttpError) return { kind: 'server', code: `API-${err.status}` }
  if (err instanceof TooOldError) return { kind: 'server', code: 'client_too_old' }
  const code = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
  if (code === 'NET-0') return { kind: 'offline', code }
  if (code === 'unauthorized') return { kind: 'auth', code }
  if (/^API-\d+$/.test(code) || code === 'client_too_old') return { kind: 'server', code }
  return { kind: 'server', code: code || 'API-503' }
}
