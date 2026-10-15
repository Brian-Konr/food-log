/** 前端的版本（整數）。每次 mutation 參數格式或同步協定有不相容的改動就 +1。 */
export const CLIENT_VERSION = 1

/** push／pull 請求帶的標頭。 */
export const CLIENT_VERSION_HEADER = 'X-FoodLog-Client'

/** 沒帶、不是整數、或小於 minClientVersion 都算太舊（Worker 回 409 client_too_old）。 */
export function isClientTooOld(clientVersion: number | null | undefined, minClientVersion: number): boolean {
  if (clientVersion == null || !Number.isInteger(clientVersion)) return true
  return clientVersion < minClientVersion
}

export function parseClientVersionHeader(value: string | null | undefined): number | null {
  if (value == null || !/^\d+$/.test(value.trim())) return null
  return Number(value.trim())
}
