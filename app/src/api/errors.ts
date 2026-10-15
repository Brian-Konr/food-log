/** 連不到伺服器（離線、逾時）。寫入會留在待送佇列，之後自動補送。 */
export class NetworkError extends Error {
  /** 原因：timeout（等太久被中斷，後端可能已寫入）／fetch（連線失敗）／http-<code> */
  kind: string
  constructor(message = '目前連不上，已先存在這支手機，上線後會自動補送', kind = 'fetch') { super(message); this.name = 'NetworkError'; this.kind = kind }
}
/** 伺服器回 { ok:false }。 */
export class ServerError extends Error {
  code: string
  constructor(code: string, message?: string) { super(message || code); this.name = 'ServerError'; this.code = code }
}
/** 這些錯誤重送也不會好：移出佇列並提示使用者。其他（busy、server_error）稍後重試。 */
export const PERMANENT_ERRORS = new Set(['bad_json', 'bad_action', 'bad_table', 'bad_record', 'not_found', 'unauthorized', 'bad_response', 'forbidden', 'duplicate_name', 'schema_outdated', 'read_only'])
/** 後端 READ_ONLY=1（已搬到新網址）。後端會附上同樣的文案；這份是萬一沒帶 message 時的備用。 */
export const READ_ONLY_MSG = 'food-log 已搬到新網址，這裡只能讀'
