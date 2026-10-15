// localStorage 只放「每支手機自己的小偏好」（主題、體重區間、是否試用模式、登入過的 userId）。
// 資料都在 Dexie。private mode 或被封鎖時讀寫會丟例外，所以一律包 try/catch，讀不到就當沒有。
export const KEYS = {
  theme: 'foodlog.theme',
  weightRange: 'foodlog.weightRange',
  /** 'trial'：這支手機選了「先在這支手機試用」。 */
  mode: 'foodlog.mode',
  /** 最後一次登入成功的 userId：離線打開時用它直接開本機資料庫，不必等 session 檢查。 */
  userId: 'foodlog.userId',
  /** 已經 toast 過的失敗列（mutationId），重開不再跳。 */
  failedNotified: 'foodlog.failedNotified',
} as const

/** v1（Apps Script 版）留下來的鍵：啟動時清掉一次。共享密鑰不該繼續留在手機上。 */
export const LEGACY_KEYS = [
  'foodlog.gasUrl',
  'foodlog.secret',
  'foodlog.mock',
  'foodlog.mockdb',
  'foodlog.mockDelayMs',
  'foodlog.mockFailReads',
  'foodlog.mockFailWrites',
] as const

export function readLocal(key: string, storage?: Storage): string | null {
  try {
    return (storage ?? localStorage).getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string, storage?: Storage): void {
  try {
    ;(storage ?? localStorage).setItem(key, value)
  } catch {
    /* 沒有儲存空間：這次不記住，不影響功能 */
  }
}

export function removeLocal(key: string, storage?: Storage): void {
  try {
    ;(storage ?? localStorage).removeItem(key)
  } catch {
    /* ignore */
  }
}

/** 一次性清理 v1 的 localStorage 鍵（foodlog.gasUrl／secret／mock…）。回傳實際清掉的鍵，給測試看。 */
export function cleanupLegacyKeys(storage?: Storage): string[] {
  const removed: string[] = []
  for (const k of LEGACY_KEYS) {
    if (readLocal(k, storage) !== null) {
      removeLocal(k, storage)
      removed.push(k)
    }
  }
  return removed
}
