// Tx：mutator 看到的唯一儲存介面。Dexie（LocalTx）、D1（d1-tx）、記憶體（MemoryTx）三種實作共用。
//
// 先讀後寫：mutator 的讀取必須全部在第一個 put 之前。D1 版的 put 只是放進緩衝區，最後用一個 batch 提交，
// 所以寫了之後再讀會讀到舊值；MemoryTx 在測試裡會直接丟錯擋住這種寫法。
import type { ConfigRow, FavoriteRow, ItemRow, LogRow, Row, RowInput, StoreRow, Table, WeightRow } from './schema/rows'

export type { Row, RowInput, Table }
export type { ConfigRow, FavoriteRow, ItemRow, LogRow, StoreRow, WeightRow }

export interface Tx {
  /** 依主鍵讀一列（含已軟刪除的）。favorites 的 id 是 item_id；config 只有一列，id 被忽略。 */
  get<T extends Table>(t: T, id: string): Promise<Row<T> | undefined>
  /** 某一天未刪除的體重（最多一筆）。 */
  liveWeightOnDay(day: string): Promise<WeightRow | undefined>
  /** 未刪除、name_norm 相同的店家；exceptId 是要排除的店家（自己）。 */
  liveStoreByNorm(norm: string, exceptId?: string): Promise<StoreRow | undefined>
  /** 某家店的所有品項（含已刪除的；呼叫端自己過濾）。 */
  itemsOfStore(storeId: string): Promise<ItemRow[]>
  /** 設定列；使用者還沒有設定時回預設值。 */
  getConfig(): Promise<ConfigRow>
  /** 寫入（整列取代）。只放進緩衝區；user_id 與 version 由實作蓋上。 */
  put<T extends Table>(t: T, row: RowInput<T>): void
}
