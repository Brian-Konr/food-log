// MemoryTx：記憶體版 Tx，給測試和 MemoryServer 用。
// put 只進緩衝區（和 D1 的 batch 一樣）；寫了之後再讀會直接丟錯，擋住「先寫後讀」的 mutator。
import { defaultConfigRow } from '../schema/config'
import { TABLES, rowKey } from '../schema/rows'
import type { ConfigRow, ItemRow, Row, RowInput, RowMap, StoreRow, Table, WeightRow } from '../schema/rows'
import type { Tx } from '../tx'

export type { RowMap }

type Pending = { [T in Table]: { table: T; row: RowInput<T> } }[Table]

export class MemoryDb {
  readonly tables: { [T in Table]: Map<string, Row<T>> } = {
    stores: new Map(),
    items: new Map(),
    logs: new Map(),
    weights: new Map(),
    favorites: new Map(),
    config: new Map(),
  }
  version = 0
  epoch = 'e1'
  readonly clients = new Map<string, number>()
  readonly errors: { clientId: string; mutationId: number; name: string; error: string; message: string; details?: Record<string, unknown> | undefined; at: string }[] = []

  constructor(readonly userId = 'u1') {}

  /** 測試用：直接放一列（不經過 mutator）。version 預設用目前的全域版本號。 */
  seed<T extends Table>(table: T, row: RowInput<T> & { version?: number }): void {
    const full = { user_id: this.userId, version: this.version, ...row } as Row<T>
    ;(this.tables[table] as Map<string, Row<T>>).set(rowKey(table, full as never), full)
  }

  all<T extends Table>(table: T): Row<T>[] {
    return [...(this.tables[table] as Map<string, Row<T>>).values()]
  }
}

export class MemoryTx implements Tx {
  private pending: Pending[] = []

  constructor(private readonly db: MemoryDb) {}

  private assertNoWrites(op: string): void {
    if (this.pending.length > 0) {
      throw new Error(`MemoryTx: 先寫後讀（${op}）。mutator 的讀取必須全部在第一個 put 之前（D1 的寫入是緩衝的，讀不到）。`)
    }
  }

  async get<T extends Table>(t: T, id: string): Promise<Row<T> | undefined> {
    this.assertNoWrites(`get ${t}`)
    const key = t === 'config' ? 'config' : id
    const row = (this.db.tables[t] as Map<string, Row<T>>).get(key)
    return row === undefined ? undefined : structuredClone(row)
  }

  async liveWeightOnDay(day: string): Promise<WeightRow | undefined> {
    this.assertNoWrites('liveWeightOnDay')
    for (const w of this.db.tables.weights.values()) if (w.day === day && w.deleted_at === null) return structuredClone(w)
    return undefined
  }

  async liveStoreByNorm(norm: string, exceptId?: string): Promise<StoreRow | undefined> {
    this.assertNoWrites('liveStoreByNorm')
    for (const s of this.db.tables.stores.values()) {
      if (s.deleted_at === null && s.name_norm === norm && s.id !== exceptId) return structuredClone(s)
    }
    return undefined
  }

  async itemsOfStore(storeId: string): Promise<ItemRow[]> {
    this.assertNoWrites('itemsOfStore')
    return [...this.db.tables.items.values()].filter((i) => i.store_id === storeId).map((i) => structuredClone(i))
  }

  async getConfig(): Promise<ConfigRow> {
    this.assertNoWrites('getConfig')
    const row = this.db.tables.config.get('config')
    return row ? structuredClone(row) : defaultConfigRow(this.db.userId)
  }

  put<T extends Table>(t: T, row: RowInput<T>): void {
    this.pending.push({ table: t, row: structuredClone(row) } as Pending)
  }

  hasWrites(): boolean {
    return this.pending.length > 0
  }

  /** 緩衝的寫入（測試用）。 */
  writes(): readonly Pending[] {
    return this.pending
  }

  /** 把緩衝的寫入套進資料庫，每列蓋上 user_id 與這個 version。 */
  applyTo(db: MemoryDb, version: number): void {
    for (const p of this.pending) {
      const full = { ...p.row, user_id: db.userId, version } as Row<typeof p.table>
      ;(db.tables[p.table] as Map<string, unknown>).set(rowKey(p.table, full as never), full)
    }
    this.pending = []
  }

  /** 單獨使用（不經過 MemoryServer）：把寫入提交，全域版本號 +1。沒有寫入就不動。回傳目前版本號。 */
  commit(): number {
    if (this.pending.length > 0) {
      this.db.version += 1
      this.applyTo(this.db, this.db.version)
    }
    return this.db.version
  }
}

export const ALL_TABLES = TABLES
