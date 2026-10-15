// 各 mutation 的參數 schema（zod）。
// 這一層只檢查「形狀與型別」，失敗一律是 bad_record。業務規則（範圍、格式、權限、台北日）
// 留在 mutator 裡，照 legacy/gas/Code.gs 的檢查順序跑，這樣 Kyujin 的 forbidden 和 bad_record 的先後才會一樣。
// 例外：`source` 刻意用寬鬆的字串，因為 Code.gs 對 Kyujin 先回 forbidden、才檢查 source 是否合法。
import { z } from 'zod'
import { kindSchema, srcSchema } from './enums'

const nutrition = {
  kcal: z.number(),
  protein: z.number(),
  fat: z.number(),
  carb: z.number(),
}

/** logs.add 的 log：快速記錄的 item_id 空、qty=1、grams 空、src=其他、沒有店家。 */
export const logInputSchema = z.object({
  id: z.string(),
  ts: z.string(),
  day: z.string(),
  item_id: z.string().nullish(),
  name: z.string().nullish(),
  src: srcSchema,
  qty: z.number(),
  grams: z.number().nullish(),
  ...nutrition,
  source: z.string().nullish(),
  store_id: z.string().nullish(),
})
export type LogInput = z.infer<typeof logInputSchema>

/** items.upsert 的 item。created_by 不是參數：新建時依 actor，之後不變。v1 的 fav 已移除（改用 favorites.set）。 */
export const itemInputSchema = z.object({
  id: z.string(),
  kind: kindSchema,
  base_id: z.string().nullish(),
  src: srcSchema,
  name: z.string(),
  serving: z.string(),
  serving_g: z.number().nullish(),
  ...nutrition,
  store_id: z.string().nullish(),
  ts: z.string().nullish(),
})
export type ItemInput = z.infer<typeof itemInputSchema>

export const logsAddArgs = z.object({
  log: logInputSchema,
  /** 補填或自建的品項：在同一個交易裡先寫，取代 v1 的 groupId。 */
  item: itemInputSchema.optional(),
})
export type LogsAddArgs = z.infer<typeof logsAddArgs>

/** 可以改的欄位白名單；`source` 只用來偵測「想改 source」（回 bad_record），不會被寫入。 */
export const logPatchSchema = z.object({
  qty: z.number().optional(),
  grams: z.number().nullable().optional(),
  kcal: z.number().optional(),
  protein: z.number().optional(),
  fat: z.number().optional(),
  carb: z.number().optional(),
  ts: z.string().optional(),
  day: z.string().optional(),
  name: z.string().nullable().optional(),
  source: z.string().nullish(),
})
export type LogPatch = z.infer<typeof logPatchSchema>

export const logsUpdateArgs = z.object({ id: z.string(), patch: logPatchSchema })
export type LogsUpdateArgs = z.infer<typeof logsUpdateArgs>

export const idArgs = z.object({ id: z.string() })
export type IdArgs = z.infer<typeof idArgs>

export const itemsUpsertArgs = itemInputSchema
export type ItemsUpsertArgs = ItemInput

/** last_eaten_at 不是參數；created_by 依 actor。 */
export const storesUpsertArgs = z.object({
  id: z.string(),
  name: z.string(),
  ts: z.string().nullish(),
})
export type StoresUpsertArgs = z.infer<typeof storesUpsertArgs>

export const weightsUpsertArgs = z.object({
  id: z.string(),
  day: z.string(),
  ts: z.string(),
  kg: z.number(),
})
export type WeightsUpsertArgs = z.infer<typeof weightsUpsertArgs>

export const favoritesSetArgs = z.object({ item_id: z.string(), fav: z.boolean() })
export type FavoritesSetArgs = z.infer<typeof favoritesSetArgs>

/** value 可以是字串、數字、null；remind_meal_times 也可以給字串陣列。驗證規則照 setConfig_。 */
export const configSetArgs = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number(), z.null(), z.array(z.string())]).optional(),
})
export type ConfigSetArgs = z.infer<typeof configSetArgs>
