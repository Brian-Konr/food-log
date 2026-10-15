// Dexie 資料庫（計畫 §3.5）。
//
//   food-log-<userId>   登入後的資料庫；每個使用者一個，登出時整個刪掉。
//   food-log-local      本機試用模式（沒有登入）。資料永遠不會上傳，登入也不會把它搬進帳號。
//
// 表：
//   srv_<table>   伺服器最後確認的狀態（pull 套進來的列，含軟刪除的 tombstone）
//   <table>       畫面讀的內容 = srv_<table> + 重播還沒確認的 pending
//   pending       待送的 mutation：{ mutationId, name, args, clientTs, touched[] }
//   failed        業務錯誤，給 UI 重試或捨棄
//   meta          { key, value }：clientId、nextMutationId、cookie、lastMutationId、userId、mode、lastPullAt、pullRun（多頁 pull 進行中：{reset, dirty[]}）
//
// touched 的格式是 `<table>:<主鍵>`（例如 `logs:abc`、`stores:s:1`、`config:config`）。`pending.touched` 是 multiEntry 索引，
// usePendingKeys 靠它知道「哪些列還沒被伺服器確認」；rebase 靠它算髒鍵。
import Dexie from 'dexie'
import type { Table as DexieTable } from 'dexie'
import { TABLES, rowKey } from '@food-log/core'
import type { ConfigRow, FavoriteRow, ItemRow, LogRow, Row, StoreRow, Table, WeightRow } from '@food-log/core'

export const LOCAL_DB_NAME = 'food-log-local'
export const dbNameFor = (userId: string | null): string => (userId === null ? LOCAL_DB_NAME : `food-log-${userId}`)

export type Mode = 'trial' | 'account'

/** 待送的 mutation。args 存原始（JSON 化後的）參數：伺服器收到的和本機重播用的是同一份。 */
export interface PendingRow {
  mutationId: number
  name: string
  args: unknown
  /** 產生 mutation 的時間（epoch ms）。本機每次重播都用它當 ctx.now，所以重播結果是確定的。 */
  clientTs: number
  /**
   * 這個 mutation 在本機執行時寫過的所有鍵（`<table>:<key>`），歷次重播取聯集（只增不減）。
   * rebase 的髒鍵 = 收到的變更 ∪ 所有 pending（包含這一輪剛確認或丟掉的）的 touched。
   */
  touched: string[]
}

/** 業務錯誤。source=local：本機重播時就失敗了（pending 還留在佇列，等伺服器回答）；source=server：伺服器回的。 */
export interface FailedRow {
  mutationId: number
  name: string
  args: unknown
  error: string
  message: string
  details?: Record<string, unknown> | undefined
  at: string
  source: 'local' | 'server'
}

export interface MetaRow {
  key: string
  value: unknown
}

export type MetaKey = 'clientId' | 'nextMutationId' | 'cookie' | 'lastMutationId' | 'userId' | 'mode' | 'lastPullAt' | 'pullRun'

type Rows = { [T in Table]: Row<T> }
type AnyTable = DexieTable<unknown, string>

/** 每張表的 Dexie 綁定：config 只有一列，用外部主鍵 'config'。 */
const STORES = {
  stores: 'id, name_norm',
  items: 'id, store_id',
  logs: 'id, day',
  weights: 'id, day',
  favorites: 'item_id',
  config: '',
} as const satisfies Record<Table, string>

export const CONFIG_KEY = 'config'

export const touchKey = (table: Table, key: string): string => `${table}:${key}`
export function parseTouchKey(k: string): { table: Table; key: string } {
  const i = k.indexOf(':')
  return { table: k.slice(0, i) as Table, key: k.slice(i + 1) }
}

export class FoodLogDb extends Dexie {
  srv_stores!: DexieTable<StoreRow, string>
  srv_items!: DexieTable<ItemRow, string>
  srv_logs!: DexieTable<LogRow, string>
  srv_weights!: DexieTable<WeightRow, string>
  srv_favorites!: DexieTable<FavoriteRow, string>
  srv_config!: DexieTable<ConfigRow, string>
  stores!: DexieTable<StoreRow, string>
  items!: DexieTable<ItemRow, string>
  logs!: DexieTable<LogRow, string>
  weights!: DexieTable<WeightRow, string>
  favorites!: DexieTable<FavoriteRow, string>
  config!: DexieTable<ConfigRow, string>
  pending!: DexieTable<PendingRow, number>
  failed!: DexieTable<FailedRow, number>
  meta!: DexieTable<MetaRow, string>

  constructor(name: string, options?: ConstructorParameters<typeof Dexie>[1]) {
    super(name, options)
    const schema: Record<string, string> = {
      pending: 'mutationId, *touched',
      failed: 'mutationId',
      meta: 'key',
    }
    for (const t of TABLES) {
      schema[t] = STORES[t]
      schema[`srv_${t}`] = STORES[t]
    }
    this.version(1).stores(schema)
  }

  /** 畫面讀的表。 */
  view<T extends Table>(t: T): DexieTable<Rows[T], string> {
    return this.table(t) as unknown as DexieTable<Rows[T], string>
  }
  /** 伺服器最後確認的表。 */
  srv<T extends Table>(t: T): DexieTable<Rows[T], string> {
    return this.table(`srv_${t}`) as unknown as DexieTable<Rows[T], string>
  }

  async getMeta<T>(key: MetaKey, fallback: T): Promise<T> {
    const r = await this.meta.get(key)
    return r === undefined ? fallback : (r.value as T)
  }
  async setMeta(key: MetaKey, value: unknown): Promise<void> {
    await this.meta.put({ key, value })
  }

  /** 全部資料表（交易用）。 */
  get allTables(): DexieTable[] {
    return this.tables
  }
}

/** 寫入（取代整列）。config 是外部主鍵。 */
export async function putRows<T extends Table>(tbl: DexieTable<Rows[T], string>, table: T, rows: readonly Rows[T][]): Promise<void> {
  if (rows.length === 0) return
  if (table === 'config') {
    for (const r of rows) await (tbl as unknown as AnyTable).put(r, CONFIG_KEY)
    return
  }
  await tbl.bulkPut(rows as Rows[T][])
}

export async function deleteRows(tbl: DexieTable<never, string>, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  await tbl.bulkDelete(keys as string[])
}

/** 依鍵讀列（config 的鍵一律是 'config'）。 */
export async function getRows<T extends Table>(tbl: DexieTable<Rows[T], string>, table: T, keys: readonly string[]): Promise<(Rows[T] | undefined)[]> {
  if (table === 'config') return Promise.all(keys.map(() => tbl.get(CONFIG_KEY)))
  return tbl.bulkGet(keys as string[])
}

/** 列的主鍵。 */
export function keyOfRow<T extends Table>(table: T, row: Rows[T]): string {
  return rowKey(table, row as { id?: string; item_id?: string })
}

/** 開資料庫並補齊 meta（clientId、nextMutationId、userId、mode）。 */
export async function openDb(
  userId: string | null,
  opts: { dexie?: ConstructorParameters<typeof Dexie>[1]; newId?: () => string } = {},
): Promise<FoodLogDb> {
  const db = new FoodLogDb(dbNameFor(userId), opts.dexie)
  await db.open()
  await db.transaction('rw', db.meta, async () => {
    if ((await db.meta.get('clientId')) === undefined) await db.setMeta('clientId', (opts.newId ?? (() => crypto.randomUUID()))())
    if ((await db.meta.get('nextMutationId')) === undefined) await db.setMeta('nextMutationId', 1)
    if ((await db.meta.get('userId')) === undefined) await db.setMeta('userId', userId ?? 'local')
    if ((await db.meta.get('mode')) === undefined) await db.setMeta('mode', userId === null ? 'trial' : 'account')
  })
  return db
}
