/** 必須和 gas/Schema.gs 的 DEFAULT_CONFIG 逐字相同。值都是字串。theme 不進 Sheet。 */
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
