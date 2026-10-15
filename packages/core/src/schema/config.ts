import type { ConfigRow } from './rows'

/** config.set 可以寫的鍵（v1 的 fav_ids 已搬到 favorites 表，不再是設定）。 */
export const CONFIG_KEYS = [
  'target_kcal',
  'target_protein',
  'target_fat',
  'target_carb',
  'tdee',
  'remind_meal_times',
  'remind_weight_time',
] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

export function isConfigKey(k: unknown): k is ConfigKey {
  return typeof k === 'string' && (CONFIG_KEYS as readonly string[]).includes(k)
}

/** 預設值，和 legacy/gas/Schema.gs 的 DEFAULT_CONFIG 相同（tdee、提醒時間為空）。 */
export const DEFAULT_CONFIG_VALUES = {
  target_kcal: 2000,
  target_protein: 150,
  target_fat: 60,
  target_carb: 200,
  tdee: null,
  remind_meal_times: [],
  remind_weight_time: null,
} as const satisfies Partial<ConfigRow>

/** 沒有 config 列時（新使用者）用的預設列。 */
export function defaultConfigRow(userId = '', nowIso = ''): ConfigRow {
  return {
    user_id: userId,
    ...DEFAULT_CONFIG_VALUES,
    remind_meal_times: [],
    version: 0,
    deleted_at: null,
    updated_at: nowIso,
  }
}

/** 轉回 v1 Config 的字串 map（App 舊程式碼、Bot 文件和對照測試用）。 */
export function configToStrings(c: Pick<ConfigRow, ConfigKey>): Record<ConfigKey, string> {
  return {
    target_kcal: String(c.target_kcal),
    target_protein: String(c.target_protein),
    target_fat: String(c.target_fat),
    target_carb: String(c.target_carb),
    tdee: c.tdee == null ? '' : String(c.tdee),
    remind_meal_times: c.remind_meal_times.join(','),
    remind_weight_time: c.remind_weight_time ?? '',
  }
}
