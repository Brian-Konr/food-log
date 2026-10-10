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
export const PERMANENT_ERRORS = new Set(['bad_json', 'bad_action', 'bad_table', 'bad_record', 'not_found', 'unauthorized', 'bad_response', 'forbidden'])
