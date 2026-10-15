// MemoryTx：記憶體版 Tx，給測試和 MemoryServer 用。
// put 只進緩衝區（和 D1 的 batch 一樣）；寫了之後再讀會直接丟錯，擋住「先寫後讀」的 mutator。
import { badRecord } from '../errors'
import { defaultConfigRow } from '../schema/config'
import { TABLES, rowKey } from '../schema/rows'
import type { ConfigRow, ItemRow, Row, RowInput, RowMap, StoreRow, Table, WeightRow } from '../schema/rows'
import type { Tx } from '../tx'

export type { RowMap }

type Pending = { [T in Table]: { table: T; row: RowInput<T> } }[Table]

/** 全域的 meta：版本號與 epoch。所有使用者共用（和 D1 的 meta 表一樣）。 */
export type MemoryMeta = { version: number; epoch: string }

/** 一個使用者的資料。版本號與 epoch 是全域的（`meta` 由 MemoryServer 的所有使用者共用）。 */
export class MemoryDb {
  readonly tables: { [T in Table]: Map<string, Row<T>> } = {
    stores: new Map(),
    items: new Map(),
    logs: new Map(),
    weights: new Map(),
    favorites: new Map(),
    config: new Map(),
  }
  readonly clients = new Map<string, number>()
  readonly errors: { clientId: string; mutationId: number; name: string; error: string; message: string; details?: Record<string, unknown> | undefined; at: string }[] = []
  /** mutation_outcomes：成功的結果，key = `<clientId>\u0000<mutationId>`，值是 JSON 文字（和 D1 一樣會序列化）。 */
  readonly outcomes = new Map<string, string>()

  constructor(readonly userId = 'u1', readonly meta: MemoryMeta = { version: 0, epoch: 'e1' }) {}

  get version(): number {
    return this.meta.version
  }
  set version(v: number) {
    this.meta.version = v
  }
  get epoch(): string {
    return this.meta.epoch
  }
  set epoch(v: string) {
    this.meta.epoch = v
  }

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

  /**
   * 模擬 D1 的部分唯一索引：套用寫入之後，每天最多一筆未刪除的體重、每個 name_norm 最多一家未刪除的店。
   * 違反就丟 MutationError('bad_record')（和契約一致：guard 通過後的唯一索引違反不是並行衝突）。
   */
  assertUnique(db: MemoryDb): void {
    const weights = new Map(db.tables.weights)
    const stores = new Map(db.tables.stores)
    for (const p of this.pending) {
      if (p.table === 'weights') weights.set(p.row.id, p.row as never)
      if (p.table === 'stores') stores.set(p.row.id, p.row as never)
    }
    const days = new Set<string>()
    for (const w of weights.values()) {
      if (w.deleted_at !== null) continue
      if (days.has(w.day)) throw badRecord('這天已經有一筆體重（唯一索引）')
      days.add(w.day)
    }
    const norms = new Set<string>()
    for (const st of stores.values()) {
      if (st.deleted_at !== null) continue
      if (norms.has(st.name_norm)) throw badRecord('店名重複（唯一索引）')
      norms.add(st.name_norm)
    }
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
