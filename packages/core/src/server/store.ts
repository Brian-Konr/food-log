// ServerStore：process-push 與 pull 看到的儲存介面。D1 版（workers/api）與記憶體版（testing/memory-server）各實作一份。
// 這個檔案是契約的唯一來源：workers/api 照這裡實作，不另外發明介面。
//
// ── 使用者範圍 ──────────────────────────────────────────────────────────────────────────────
// 所有資料（六張表、sync_clients、mutation_outcomes、mutation_errors）都屬於某個使用者。
// 契約不讓「忘了帶 userId」發生：`ServerStore` 只有一個方法 `forUser(userId)`，回傳綁定該使用者的 `UserStore`；
// process-push 和 pull 只吃 `UserStore`。實作的每一句 SQL 都必須以綁定的 userId 過濾（讀）或寫入該 userId（寫）。
// 全域的只有 `meta`（version、epoch）：版本號是整個資料庫共用的一個計數器（單一寫入者的 CAS 目標）。
//
// ── 樂觀並行控制（和 spike/v2-auth-sync 在 D1 上驗證過的設計一致）──────────────────────────
// D1 沒有互動式交易，只有 db.batch([...])（整批原子）。所以每次嘗試：
//   begin()  一個 batch 讀「全域版本號 V」和「這台裝置的 cursor C（lastMutationId）」，回傳 ServerTx：
//            讀取走資料庫（看到已提交的狀態），put 只進緩衝區（先寫後讀會讀到舊值，所以 mutator 一律先讀後寫）。
//   commit() 一個 batch：
//            guard1  meta.version 仍然是 V
//            guard2  這台裝置的 cursor 仍然是 C（沒有別的請求替它推進過）
//            （任一 guard 失敗 → 整批回滾 → 回傳 'conflict'，呼叫端從 begin() 重來）
//            [meta.version += 1；緩衝的列用新版本號寫入]    ← 只有 ok 且有寫入時
//            [寫 mutation_outcomes（成功結果）或 mutation_errors（業務錯誤）]
//            upsert sync_clients：cursor 推進到這筆 mutationId
//   兩個 guard 都要：只 CAS 版本號擋不住「同一台裝置的同一筆 mutation 被兩個請求同時處理」；
//   只 CAS cursor 擋不住「別的裝置先改了資料」。
//
// ── 唯一索引違反 ≠ 暫時性衝突 ──────────────────────────────────────────────────────────────
// D1 有部分唯一索引（未刪除的店名、未刪除的同一天體重）。guard 通過之後才撞到唯一索引，代表沒有別人動過資料，
// 是 mutator 自己要寫出違反不變條件的列：重試只會再撞一次。所以實作**不可以**把它當成 'conflict'（會變成無限重試 →
// CAS 用盡 → 503 暫時性錯誤，前端永遠退避重送），而是要丟出 `MutationError('bad_record', …)`；
// process-push 會接住它，改用業務錯誤提交（寫入丟掉、記錄錯誤、cursor 前進）。
// 判斷方式：guard 失敗的錯誤訊息（例如 CHECK constraint 的 cas_ok）→ 'conflict'；其他 UNIQUE 違反 → bad_record。
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

/**
 * 一筆已處理的 mutation 的結果。重送同一個 mutationId 時，process-push 回傳這個，而不是重新執行（也不是只回 {replayed:true}）。
 * result 必須能 JSON 序列化（D1 存成 JSON 文字）。
 */
export type MutationOutcome = { ok: true; result: unknown } | { ok: false; error: RecordedError }

/**
 * 成功結果（mutation_outcomes）只保留每台裝置最近 MUTATION_OUTCOME_RETENTION 筆 mutationId：
 * 提交時順便刪掉 mutationId <= 這筆 - RETENTION 的。超過保留範圍的重送，process-push 退回 `{replayed:true}`
 * （仍然知道「已經生效」，只是拿不到原本的結果）。業務錯誤另存 mutation_errors，不受這個限制（前端靠它提示使用者）。
 */
export const MUTATION_OUTCOME_RETENTION = 200

export type CommitInput =
  | {
      ok: true
      /** 這筆 mutation 的 id；提交後 cursor 推進到它。 */
      mutationId: number
      /** mutator 的回傳值，原樣存進 mutation_outcomes，重送時回傳。 */
      result: unknown
    }
  | {
      ok: false
      mutationId: number
      /** 業務錯誤。緩衝的寫入丟掉、記錄 mutation_errors、版本號不變、cursor 照樣前進。 */
      error: ErrorInput
    }

export interface ServerTx {
  /** 給 mutator 用：讀取看已提交的狀態，put 只進緩衝區。 */
  readonly tx: Tx
  /** begin 時讀到的全域版本號 V。 */
  readonly version: number
  /** begin 時讀到的這台裝置已處理到的 mutationId（沒有紀錄是 0）。 */
  readonly lastMutationId: number
  /** 緩衝區有沒有寫入。沒有（ignored、duplicate、no-op）就只推進 cursor，版本號不變。 */
  hasWrites(): boolean
  /**
   * 提交（一個 batch，見檔案開頭）。
   *  - true：已提交。
   *  - false：CAS 失敗（版本號或 cursor 已被別人推進），什麼都沒寫，要從 begin() 重來。
   *  - 丟出 MutationError('bad_record')：guard 通過但違反唯一索引；什麼都沒寫，呼叫端改用 `ok:false` 再 commit 一次。
   */
  commit(input: CommitInput): Promise<boolean>
}

/** 綁定一個使用者的儲存。所有方法都只看得到、只寫得到這個使用者的資料。 */
export interface UserStore {
  readonly userId: string
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
  /**
   * 重送已處理過的 mutation 時，回傳當時的結果：成功（在保留範圍內）或業務錯誤。
   * 沒有紀錄（超過保留範圍、或根本沒處理過）回 undefined。
   */
  getMutationOutcome(clientId: string, mutationId: number): Promise<MutationOutcome | undefined>
  /** 這台裝置 mutationId > afterMutationId 的業務錯誤，依 mutationId 遞增。 */
  listErrors(clientId: string, afterMutationId: number): Promise<RecordedError[]>
}

export interface ServerStore {
  /** 取得綁定 userId 的儲存。userId 來自驗證過的 session 或 bot token，絕不來自請求內容。 */
  forUser(userId: string): UserStore
}
