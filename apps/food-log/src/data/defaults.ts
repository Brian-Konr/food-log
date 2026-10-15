/**
 * v1 的預設 Config（逐字等於 legacy/gas/Schema.gs 的 DEFAULT_CONFIG，值都是字串）。
 * App 已經不用它：v2 的預設在 packages/core 的 DEFAULT_CONFIG_VALUES。
 * 只留給 legacy/test/gas-defaults.test.ts 比對，切換滿 30 天後隨 legacy 一起刪。
 */
export const DEFAULT_CONFIG: Record<string, string> = {
  target_kcal: '2000',
  target_protein: '150',
  target_fat: '60',
  target_carb: '200',
  tdee: '',
  remind_meal_times: '',
  remind_weight_time: '',
  fav_ids: '',
}

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG)

export const SRC_SHEET = ['7-11', '全家', '其他'] as const
export type SheetSrc = (typeof SRC_SHEET)[number]
