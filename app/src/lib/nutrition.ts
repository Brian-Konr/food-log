import type { CatalogItem, DayTotals, LogRecord, Macros, MergedItem, Targets } from '@/types'
import { formatInt, formatMacro } from './format'

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

export function needsFill(item: Pick<CatalogItem, 'protein' | 'fat' | 'carb'>): boolean {
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

export function canUseGrams(item: Pick<CatalogItem, 'servingG'>): boolean {
  return item.servingG != null && item.servingG > 0
}

export function lastPortion(logs: LogRecord[], itemId: string): { mode: 'qty' | 'grams'; qty: number; grams: number | null } {
  const last = [...logs].filter((l) => !l.deleted && l.item_id === itemId).sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)
  if (!last) return { mode: 'qty', qty: 1, grams: null }
  if (last.grams != null && last.grams > 0) return { mode: 'grams', qty: last.qty, grams: last.grams }
  return { mode: 'qty', qty: last.qty, grams: null }
}

export function sumLogs(logs: Iterable<Pick<LogRecord, 'deleted' | 'kcal' | 'protein' | 'fat' | 'carb'>>): DayTotals {
  let kcal = 0
  let proteinTenth = 0
  let fatTenth = 0
  let carbTenth = 0
  let count = 0
  for (const l of logs) {
    if (l.deleted) continue
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

export function formatRemain(n: number, unit: 'kcal' | 'g'): string {
  const abs = unit === 'kcal' ? Math.round(Math.abs(n)) : roundMacro(Math.abs(n))
  const body = unit === 'kcal' ? `${formatInt(abs)} kcal` : `${formatMacro(abs)} g`
  return n < 0 ? `超過 ${body}` : body
}

export function parseTargets(config: Record<string, string>): Targets {
  return {
    kcal: Number(config.target_kcal) || 0,
    protein: Number(config.target_protein) || 0,
    fat: Number(config.target_fat) || 0,
    carb: Number(config.target_carb) || 0,
  }
}

export function itemMacros(item: Pick<MergedItem, 'kcal' | 'protein' | 'fat' | 'carb'>): Macros | null {
  if (item.protein == null || item.fat == null || item.carb == null) return null
  return { kcal: item.kcal, protein: item.protein, fat: item.fat, carb: item.carb }
}

/** 編輯紀錄：品項還在就用現在的每份 × 新份量；否則用新 qty / 舊 qty 縮放已存數字。 */
export function rescaleLog(
  log: Pick<LogRecord, 'qty' | 'kcal' | 'protein' | 'fat' | 'carb'>,
  item: Pick<MergedItem, 'kcal' | 'protein' | 'fat' | 'carb'> | null,
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
