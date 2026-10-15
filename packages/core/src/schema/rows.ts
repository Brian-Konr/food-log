// 資料列型別（D1、Dexie、記憶體共用）。欄位和 PRD §6.2 / 計畫 §3.3 對齊。
// 共同欄位：user_id、version（伺服器遞增的版本號）、deleted_at（軟刪除；NULL 表示存在）、updated_at（台北 ISO 字串）。
import { z } from 'zod'
import { createdBySchema, kindSchema, logSourceSchema, srcSchema } from './enums'

const common = {
  user_id: z.string(),
  version: z.number().int().nonnegative(),
  deleted_at: z.string().nullable(),
  updated_at: z.string(),
}

export const storeRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** normName(name)；未刪除的列在 (user_id, name_norm) 上唯一。 */
  name_norm: z.string(),
  /** 最近一次吃的時間；只由 logs.add 往後更新，不是 stores.upsert 的參數。 */
  last_eaten_at: z.string().nullable(),
  created_by: createdBySchema,
  ts: z.string(),
  ...common,
})
export type StoreRow = z.infer<typeof storeRowSchema>

export const itemRowSchema = z.object({
  id: z.string(),
  kind: kindSchema,
  base_id: z.string().nullable(),
  src: srcSchema,
  name: z.string(),
  serving: z.string(),
  serving_g: z.number().nullable(),
  kcal: z.number(),
  protein: z.number(),
  fat: z.number(),
  carb: z.number(),
  store_id: z.string().nullable(),
  created_by: createdBySchema,
  ts: z.string(),
  /** 因刪除這家店而連帶刪除時，記下店家 id；stores.restore 只還原這些品項。 */
  cascade_of: z.string().nullable(),
  ...common,
})
export type ItemRow = z.infer<typeof itemRowSchema>

export const logRowSchema = z.object({
  id: z.string(),
  day: z.string(),
  ts: z.string(),
  /** 快速記錄沒有品項。 */
  item_id: z.string().nullable(),
  name: z.string(),
  src: srcSchema,
  qty: z.number(),
  grams: z.number().nullable(),
  kcal: z.number(),
  protein: z.number(),
  fat: z.number(),
  carb: z.number(),
  source: logSourceSchema,
  store_id: z.string().nullable(),
  ...common,
})
export type LogRow = z.infer<typeof logRowSchema>

export const weightRowSchema = z.object({
  id: z.string(),
  day: z.string(),
  ts: z.string(),
  kg: z.number(),
  ...common,
})
export type WeightRow = z.infer<typeof weightRowSchema>

/** 收藏（取代 v1 的 Config.fav_ids 與 items.fav）。主鍵 (user_id, item_id)；取消收藏用 deleted_at，pull 才帶得走。 */
export const favoriteRowSchema = z.object({
  item_id: z.string(),
  ...common,
})
export type FavoriteRow = z.infer<typeof favoriteRowSchema>

/** 設定：每個使用者一列，有型別的欄位（取代 v1 的 key/value 字串）。 */
export const configRowSchema = z.object({
  target_kcal: z.number().int().nonnegative(),
  target_protein: z.number().nonnegative(),
  target_fat: z.number().nonnegative(),
  target_carb: z.number().nonnegative(),
  tdee: z.number().int().nullable(),
  /** HH:mm 字串陣列。 */
  remind_meal_times: z.array(z.string()),
  remind_weight_time: z.string().nullable(),
  ...common,
})
export type ConfigRow = z.infer<typeof configRowSchema>

export const TABLES = ['stores', 'items', 'logs', 'weights', 'favorites', 'config'] as const
export type Table = (typeof TABLES)[number]

export interface RowMap {
  stores: StoreRow
  items: ItemRow
  logs: LogRow
  weights: WeightRow
  favorites: FavoriteRow
  config: ConfigRow
}
export type Row<T extends Table> = RowMap[T]

/** mutator 寫入的內容：user_id 和 version 由 Tx 實作（伺服器或本機）蓋上。 */
export type RowInput<T extends Table> = Omit<Row<T>, 'user_id' | 'version'>

/** 各表的主鍵欄位（config 每個使用者只有一列，沒有 id）。 */
export function rowKey(table: Table, row: { id?: string; item_id?: string }): string {
  if (table === 'favorites') return String(row.item_id)
  if (table === 'config') return 'config'
  return String(row.id)
}

export const rowSchemas = {
  stores: storeRowSchema,
  items: itemRowSchema,
  logs: logRowSchema,
  weights: weightRowSchema,
  favorites: favoriteRowSchema,
  config: configRowSchema,
} as const
