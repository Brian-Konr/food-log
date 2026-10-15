// 營養計算。由 apps/food-log/src/lib/nutrition.ts 搬來，輸入型別縮成需要的欄位。
// 軟刪除同時接受 v1 的 `deleted: boolean` 與 v2 的 `deleted_at`。

export type Macros = { kcal: number; protein: number; fat: number; carb: number }
export type DayTotals = Macros & { count: number }
export type Targets = Macros

/** v1 列是 `deleted: boolean`；v2 列是 `deleted_at: string | null`。 */
export type Deletable = { deleted?: boolean | undefined; deleted_at?: string | null | undefined }

export function isDeleted(r: Deletable): boolean {
  return r.deleted === true || (r.deleted_at != null && r.deleted_at !== '')
}

export const roundKcal = (n: number) => Math.round(n)
export const roundMacro = (n: number) => Math.round(n * 10) / 10

/** 空字串、逗號、負數、NaN 回 null；0 可以。 */
export function parseNonNeg(s: string): number | null {
  if (s.trim() === '') return null
  if (s.includes(',')) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

export function needsFill(item: { protein: number | null; fat: number | null; carb: number | null }): boolean {
  return item.protein == null || item.fat == null || item.carb == null
}

export function scaleMacros(perServing: Macros, factor: number): Macros {
  return {
    kcal: roundKcal(perServing.kcal * factor),
    protein: roundMacro(perServing.protein * factor),
    fat: roundMacro(perServing.fat * factor),
    carb: roundMacro(perServing.carb * factor),
  }
}

export function fromQty(perServing: Macros, qty: number): Macros {
  return scaleMacros(perServing, qty)
}

export function fromGrams(perServing: Macros, grams: number, servingG: number): { qty: number; macros: Macros } {
  const qty = grams / servingG
  return { qty, macros: scaleMacros(perServing, qty) }
}

export function canUseGrams(item: { servingG: number | null }): boolean {
  return item.servingG != null && item.servingG > 0
}

export function lastPortion(
  logs: Iterable<Deletable & { item_id: string | null; ts: string; qty: number; grams: number | null }>,
  itemId: string,
): { mode: 'qty' | 'grams'; qty: number; grams: number | null } {
  const last = [...logs].filter((l) => !isDeleted(l) && l.item_id === itemId).sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)
  if (!last) return { mode: 'qty', qty: 1, grams: null }
  if (last.grams != null && last.grams > 0) return { mode: 'grams', qty: last.qty, grams: last.grams }
  return { mode: 'qty', qty: last.qty, grams: null }
}

/** 合計用存檔值：蛋白質、脂肪、碳水以 0.1 為單位累加，不再 round 總和。已刪除的列不計。 */
export function sumLogs(logs: Iterable<Deletable & Macros>): DayTotals {
  let kcal = 0
  let proteinTenth = 0
  let fatTenth = 0
  let carbTenth = 0
  let count = 0
  for (const l of logs) {
    if (isDeleted(l)) continue
    count += 1
    kcal += l.kcal
    proteinTenth += Math.round(l.protein * 10)
    fatTenth += Math.round(l.fat * 10)
    carbTenth += Math.round(l.carb * 10)
  }
  return {
    kcal,
    protein: proteinTenth / 10,
    fat: fatTenth / 10,
    carb: carbTenth / 10,
    count,
  }
}

export function remaining(targets: Targets, totals: Macros): Macros {
  return {
    kcal: targets.kcal - totals.kcal,
    protein: targets.protein - totals.protein,
    fat: targets.fat - totals.fat,
    carb: targets.carb - totals.carb,
  }
}

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')
const fmtMacro = (n: number) => (Math.round(n * 10) / 10).toFixed(1)

export function formatRemain(n: number, unit: 'kcal' | 'g'): string {
  const abs = unit === 'kcal' ? Math.round(Math.abs(n)) : roundMacro(Math.abs(n))
  const body = unit === 'kcal' ? `${fmtInt(abs)} kcal` : `${fmtMacro(abs)} g`
  return n < 0 ? `超過 ${body}` : body
}

/** 目標值：字串（v1 Config）或數字（v2 config 列）都接受；空、非數字都當 0。 */
export type TargetsConfig = {
  target_kcal?: string | number | null | undefined
  target_protein?: string | number | null | undefined
  target_fat?: string | number | null | undefined
  target_carb?: string | number | null | undefined
}

export function parseTargets(config: TargetsConfig): Targets {
  return {
    kcal: Number(config.target_kcal) || 0,
    protein: Number(config.target_protein) || 0,
    fat: Number(config.target_fat) || 0,
    carb: Number(config.target_carb) || 0,
  }
}

export function itemMacros(item: { kcal: number; protein: number | null; fat: number | null; carb: number | null }): Macros | null {
  if (item.protein == null || item.fat == null || item.carb == null) return null
  return { kcal: item.kcal, protein: item.protein, fat: item.fat, carb: item.carb }
}

/** 編輯紀錄：品項還在就用現在的每份 × 新份量；否則用新 qty / 舊 qty 縮放已存數字。 */
export function rescaleLog(
  log: { qty: number } & Macros,
  item: { kcal: number; protein: number | null; fat: number | null; carb: number | null } | null,
  newQty: number,
  grams: number | null,
  servingG: number | null,
): { qty: number; grams: number | null; macros: Macros } {
  const qty = grams != null && servingG != null && servingG > 0 ? grams / servingG : newQty
  const per = item ? itemMacros(item) : null
  if (per) return { qty, grams, macros: scaleMacros(per, qty) }
  const factor = log.qty > 0 ? qty / log.qty : qty
  return {
    qty,
    grams,
    macros: scaleMacros({ kcal: log.kcal, protein: log.protein, fat: log.fat, carb: log.carb }, factor),
  }
}
