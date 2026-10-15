// D1 implementation of core's Tx (the interface mutators see).
// Reads go to D1 (they see the committed state); put() only fills a buffer that D1Store.commit turns into one batch.
// Every statement is scoped by the bound userId. Like MemoryTx, a read after the first put() throws:
// the buffered rows are invisible to D1, so a mutator that reads after writing would silently read stale data.
import { defaultConfigRow, taipeiIso } from '@food-log/core'
import type { ConfigRow, ItemRow, Row, RowInput, StoreRow, Table, Tx, WeightRow } from '@food-log/core'
import { PK, fromDb, selectList } from './tables.ts'

export type BufferedWrite = { [T in Table]: { table: T; row: RowInput<T> } }[Table]

export class D1Tx implements Tx {
  private pending: BufferedWrite[] = []

  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
    private readonly now: () => number = Date.now,
  ) {}

  private assertNoWrites(op: string): void {
    if (this.pending.length > 0) {
      throw new Error(`D1Tx: 先寫後讀（${op}）。mutator 的讀取必須全部在第一個 put 之前（寫入是緩衝的，D1 讀不到）。`)
    }
  }

  async get<T extends Table>(t: T, id: string): Promise<Row<T> | undefined> {
    this.assertNoWrites(`get ${t}`)
    const where = t === 'config' ? 'user_id = ?' : `user_id = ? AND ${PK[t][0]} = ?`
    const stmt = this.db.prepare(`SELECT ${selectList(t)} FROM ${t} WHERE ${where}`)
    const r = await (t === 'config' ? stmt.bind(this.userId) : stmt.bind(this.userId, id)).first<Record<string, unknown>>()
    return r ? fromDb(t, r) : undefined
  }

  async liveWeightOnDay(day: string): Promise<WeightRow | undefined> {
    this.assertNoWrites('liveWeightOnDay')
    const r = await this.db
      .prepare(`SELECT ${selectList('weights')} FROM weights WHERE user_id = ? AND day = ? AND deleted_at IS NULL`)
      .bind(this.userId, day)
      .first<Record<string, unknown>>()
    return r ? fromDb('weights', r) : undefined
  }

  async liveStoreByNorm(norm: string, exceptId?: string): Promise<StoreRow | undefined> {
    this.assertNoWrites('liveStoreByNorm')
    const r = await this.db
      .prepare(`SELECT ${selectList('stores')} FROM stores WHERE user_id = ? AND name_norm = ? AND deleted_at IS NULL AND id <> ?`)
      .bind(this.userId, norm, exceptId ?? '')
      .first<Record<string, unknown>>()
    return r ? fromDb('stores', r) : undefined
  }

  async itemsOfStore(storeId: string): Promise<ItemRow[]> {
    this.assertNoWrites('itemsOfStore')
    const rs = await this.db
      .prepare(`SELECT ${selectList('items')} FROM items WHERE user_id = ? AND store_id = ? ORDER BY id`)
      .bind(this.userId, storeId)
      .all<Record<string, unknown>>()
    return rs.results.map((r) => fromDb('items', r))
  }

  async getConfig(): Promise<ConfigRow> {
    this.assertNoWrites('getConfig')
    const r = await this.db
      .prepare(`SELECT ${selectList('config')} FROM config WHERE user_id = ?`)
      .bind(this.userId)
      .first<Record<string, unknown>>()
    return r ? fromDb('config', r) : defaultConfigRow(this.userId, taipeiIso(this.now()))
  }

  put<T extends Table>(t: T, row: RowInput<T>): void {
    this.pending.push({ table: t, row: structuredClone(row) } as BufferedWrite)
  }

  get hasWrites(): boolean {
    return this.pending.length > 0
  }

  writes(): readonly BufferedWrite[] {
    return this.pending
  }
}
