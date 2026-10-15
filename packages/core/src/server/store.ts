// ServerStore：process-push 與 pull 看到的儲存介面。D1 版（workers/api）與記憶體版（testing/memory-server）各實作一份。
//
// D1 沒有互動式交易，所以流程是樂觀並行控制：
//   begin()  讀目前版本號 V 和這台裝置的 lastMutationId，回傳一個 ServerTx（讀取看 V 的快照，put 只進緩衝區）。
//   commit() 用一個 batch 提交：先比對 meta.version 仍是 V（CAS guard），再 +1、寫入緩衝的列（version=V+1）、
//            更新 sync_clients（條件：last_mutation_id 還是先前讀到的值）。比對失敗回 false，呼叫端重讀重試。
import type { Row, Table } from '../schema/rows'
import type { Tx } from '../tx'

export type VersionedRow = { [T in Table]: { table: T; row: Row<T> } }[Table]

export type ErrorInput = {
  name: string
  error: string
  message: string
  details?: Record<string, unknown> | undefined
  at: string
}

export type RecordedError = ErrorInput & { clientId: string; mutationId: number }

export type CommitInput = {
  /** 這筆 mutation 的 id；提交後 lastMutationId 推進到它。 */
  mutationId: number
  /** 有值：業務錯誤。寫入緩衝丟掉、記錄 mutation_errors、版本號不變、lastMutationId 照樣前進。 */
  error?: ErrorInput | undefined
}

export interface ServerTx {
  /** 給 mutator 用：讀取是快照，put 只進緩衝區。 */
  readonly tx: Tx
  /** begin 時讀到的全域版本號 V。 */
  readonly version: number
  /** begin 時讀到的這台裝置已處理到的 mutationId（沒有紀錄是 0）。 */
  readonly lastMutationId: number
  /** 緩衝區有沒有寫入。沒有（ignored、duplicate、no-op）就只推進 lastMutationId，版本號不變。 */
  hasWrites(): boolean
  /** 提交。false = CAS 失敗（版本號或 lastMutationId 已被別人推進），要從 begin() 重來。 */
  commit(input: CommitInput): Promise<boolean>
}

export interface ServerStore {
  begin(clientId: string): Promise<ServerTx>
  /** 全域版本號與 epoch（從備份還原或重新匯入時換新）。 */
  readMeta(): Promise<{ epoch: string; version: number }>
  /**
   * version > afterVersion 的列，依 version 遞增排序，最多 limit 列。
   * 實作可以從任何地方截斷；pull 會自己把頁切在版本號之間。
   */
  rowsAfter(afterVersion: number, limit: number): Promise<VersionedRow[]>
  /** 某個版本號的全部列（單一版本超過一頁時用）。 */
  rowsAtVersion(version: number): Promise<VersionedRow[]>
  getLastMutationId(clientId: string): Promise<number>
  /** 重送已處理過的 mutation 時，回傳當時記錄的業務錯誤（沒有表示當時成功）。 */
  getMutationError(clientId: string, mutationId: number): Promise<RecordedError | undefined>
  /** 這台裝置 mutationId > afterMutationId 的業務錯誤，依 mutationId 遞增。 */
  listErrors(clientId: string, afterMutationId: number): Promise<RecordedError[]>
}
