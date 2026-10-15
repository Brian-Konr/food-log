// GET /sync/pull?cookie=<epoch>:<version>&clientId=…&afterMutationId=…（計畫 §3.4）
//   200：{ cookie, more, reset, lastMutationId, minClientVersion, changes:{…六張表}, errors:[本裝置的業務錯誤] }
import type { ConfigRow, FavoriteRow, ItemRow, LogRow, StoreRow, WeightRow } from '../schema/rows'

/** 每頁約 2,000 列（Workers 免費方案每個請求只有 10 ms CPU）。頁只在版本號之間切。 */
export const PULL_PAGE_ROWS = 2000

export type Changes = {
  stores: StoreRow[]
  items: ItemRow[]
  logs: LogRow[]
  weights: WeightRow[]
  favorites: FavoriteRow[]
  config: ConfigRow[]
}

export function emptyChanges(): Changes {
  return { stores: [], items: [], logs: [], weights: [], favorites: [], config: [] }
}

/** 這台裝置被記錄下來的業務錯誤（給 UI 提示、重試或捨棄）。 */
export type PullError = {
  mutationId: number
  name: string
  error: string
  message: string
  details?: Record<string, unknown>
  at: string
}

export type PullQuery = {
  /** `<epoch>:<version>`；第一次（沒有 cookie）給空字串或 "0"。 */
  cookie: string
  clientId: string
  afterMutationId: number
}

export type PullResponse = {
  /** 下一次要帶的 cookie。 */
  cookie: string
  /** 還有下一頁：前端套用後立刻用新的 cookie 再 pull。 */
  more: boolean
  /** epoch 不同（從備份還原或重新匯入）：前端清掉伺服器狀態再套用這一頁（之後的頁不再帶 reset）。 */
  reset: boolean
  lastMutationId: number
  minClientVersion: number
  changes: Changes
  errors: PullError[]
}

export type ParsedCookie = { epoch: string | null; version: number }

/** 空字串、"0"、無法解析都視為「從頭開始」（epoch 為 null，不算 reset）。 */
export function parseCookie(cookie: string | null | undefined): ParsedCookie {
  if (!cookie || cookie === '0') return { epoch: null, version: 0 }
  const i = cookie.lastIndexOf(':')
  if (i <= 0) return { epoch: null, version: 0 }
  const version = Number(cookie.slice(i + 1))
  if (!Number.isInteger(version) || version < 0) return { epoch: null, version: 0 }
  return { epoch: cookie.slice(0, i), version }
}

export function formatCookie(epoch: string, version: number): string {
  return `${epoch}:${version}`
}
