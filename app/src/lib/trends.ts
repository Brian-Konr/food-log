// 改一邊的演算法必須改另一邊。兩個檔案頂端都寫這句。
import type { DaySlot, DayTotals, LogRecord, TrendsView, WeekSummary, WeightRecord, WeightSeries } from '@/types'
import { addDays, weekEnd, weekStart } from './day'
import { parseTargets, sumLogs } from './nutrition'

export function isIncomplete(count: number, kcal: number, targetKcal: number, day: string, today: string): boolean {
  if (day >= today) return false
  return count <= 1 || kcal < 0.5 * targetKcal
}

export function totalsByDay(logs: Iterable<Pick<LogRecord, 'deleted' | 'day' | 'kcal' | 'protein' | 'fat' | 'carb'>>): Map<string, DayTotals> {
  const groups = new Map<string, Pick<LogRecord, 'deleted' | 'kcal' | 'protein' | 'fat' | 'carb'>[]>()
  for (const l of logs) {
    if (!('day' in l) || !(l as { day: string }).day) continue
    const day = (l as { day: string }).day
    const arr = groups.get(day) ?? []
    arr.push(l)
    groups.set(day, arr)
  }
  const out = new Map<string, DayTotals>()
  for (const [day, rows] of groups) out.set(day, sumLogs(rows))
  return out
}

function emptyTotals(): DayTotals {
  return { kcal: 0, protein: 0, fat: 0, carb: 0, count: 0 }
}

export function weekSummary(
  logs: Iterable<Pick<LogRecord, 'deleted' | 'day' | 'kcal' | 'protein' | 'fat' | 'carb'>>,
  config: Record<string, string>,
  today: string,
  weekMonday: string,
): WeekSummary {
  const targets = parseTargets(config)
  const tdeeRaw = (config.tdee ?? '').toString().trim()
  const tdee = tdeeRaw === '' ? null : Number(tdeeRaw)
  const byDay = totalsByDay(logs)
  const days: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekMonday, i)
    if (d <= today) days.push(d)
  }
  const complete: number[] = []
  let proteinHit = 0
  let incompleteDays = 0
  for (const d of days) {
    const t = byDay.get(d) ?? emptyTotals()
    const inc = isIncomplete(t.count, t.kcal, targets.kcal, d, today)
    if (d < today && inc) incompleteDays += 1
    if (d < today && !inc) complete.push(t.kcal)
    if (t.protein >= targets.protein) proteinHit += 1
  }
  const avgKcal = complete.length ? Math.round(complete.reduce((a, b) => a + b, 0) / complete.length) : null
  const avgDeficit = tdee == null || !Number.isFinite(tdee) || avgKcal == null ? null : tdee - avgKcal
  return {
    weekStart: weekMonday,
    weekEnd: weekEnd(weekMonday),
    avgKcal,
    avgDeficit,
    proteinHit,
    proteinDenom: days.length,
    incompleteDays,
  }
}

export function kcalBarSlots(
  logs: Iterable<Pick<LogRecord, 'deleted' | 'day' | 'kcal' | 'protein' | 'fat' | 'carb'>>,
  weights: Iterable<Pick<WeightRecord, 'deleted' | 'day' | 'kg' | 'updated_at'>>,
  config: Record<string, string>,
  today: string,
): DaySlot[] {
  const targets = parseTargets(config)
  const byDay = totalsByDay(logs)
  const kgByDay = latestKgByDay(weights)
  const start = addDays(weekStart(today), -21)
  const slots: DaySlot[] = []
  for (let i = 0; i < 28; i++) {
    const day = addDays(start, i)
    const t = byDay.get(day) ?? emptyTotals()
    let slot: DaySlot['slot']
    if (day > today) slot = 'future'
    else if (day === today) slot = 'today'
    else slot = isIncomplete(t.count, t.kcal, targets.kcal, day, today) ? 'incomplete' : 'complete'
    slots.push({ day, ...t, slot, kg: kgByDay.get(day) ?? null })
  }
  return slots
}

export function latestKgByDay(weights: Iterable<Pick<WeightRecord, 'deleted' | 'day' | 'kg' | 'updated_at'>>): Map<string, number> {
  const best = new Map<string, { kg: number; updated: string }>()
  for (const w of weights) {
    if (w.deleted) continue
    const prev = best.get(w.day)
    if (!prev || w.updated_at > prev.updated) best.set(w.day, { kg: w.kg, updated: w.updated_at })
  }
  const out = new Map<string, number>()
  for (const [d, v] of best) out.set(d, v.kg)
  return out
}

export function avg7(kgByDay: Map<string, number>, day: string): number | null {
  let sum = 0
  let n = 0
  for (let i = 0; i <= 6; i++) {
    const kg = kgByDay.get(addDays(day, i - 6))
    if (kg != null) {
      sum += kg
      n += 1
    }
  }
  return n >= 3 ? sum / n : null
}

export function weightSeries(
  logs: Iterable<Pick<LogRecord, 'deleted' | 'day' | 'kcal' | 'protein' | 'fat' | 'carb'>>,
  weights: Iterable<Pick<WeightRecord, 'deleted' | 'day' | 'kg' | 'updated_at'>>,
  config: Record<string, string>,
  today: string,
  spanDays?: number,
): WeightSeries {
  const targets = parseTargets(config)
  const tdeeRaw = (config.tdee ?? '').toString().trim()
  const tdee = tdeeRaw === '' ? null : Number(tdeeRaw)
  const kgByDay = latestKgByDay(weights)
  const byDay = totalsByDay(logs)
  const points: { day: string; kg: number }[] = []
  const avg7pts: { day: string; kg: number }[] = []
  const span = spanDays == null || !Number.isFinite(spanDays) || spanDays < 2 ? 29 : Math.floor(spanDays)
  const windowStart = addDays(today, -(span - 1))
  for (let d = windowStart; d <= today; d = addDays(d, 1)) {
    const kg = kgByDay.get(d)
    if (kg != null) points.push({ day: d, kg })
    const a = avg7(kgByDay, d)
    if (a != null) avg7pts.push({ day: d, kg: a })
  }
  const empty: WeightSeries = {
    points, avg7: avg7pts, expected: [],
    startDay: null, startAvg: null, endAvg: null, endDay: null,
    deltaKg: null, expectedDeltaKg: null,
  }
  const todayAvg = avg7(kgByDay, today)
  let endDay: string | null = todayAvg != null ? today : null
  let endAvg: number | null = todayAvg
  if (endAvg == null) {
    for (let d = addDays(today, -1); d >= windowStart; d = addDays(d, -1)) {
      const a = avg7(kgByDay, d)
      if (a != null) { endDay = d; endAvg = a; break }
    }
  }
  empty.endDay = endDay
  empty.endAvg = endAvg

  if (tdee == null || !Number.isFinite(tdee)) {
    if (endAvg != null) {
      // 沒有預期線時仍可算實際差值：需要起點
      let startDay: string | null = null
      let startAvg: number | null = null
      for (let d = windowStart; d <= today; d = addDays(d, 1)) {
        const a = avg7(kgByDay, d)
        if (a != null) { startDay = d; startAvg = a; break }
      }
      empty.startDay = startDay
      empty.startAvg = startAvg
      if (startAvg != null && endAvg != null) empty.deltaKg = endAvg - startAvg
    }
    return empty
  }

  let startDay: string | null = null
  let startAvg: number | null = null
  for (let d = windowStart; d <= today; d = addDays(d, 1)) {
    const a = avg7(kgByDay, d)
    if (a != null) { startDay = d; startAvg = a; break }
  }
  if (startDay == null || startAvg == null) return { ...empty, startDay, startAvg }

  const expected: { day: string; kg: number }[] = [{ day: startDay, kg: startAvg }]
  let prev = startAvg
  for (let d = addDays(startDay, 1); d < today; d = addDays(d, 1)) {
    const t = byDay.get(d) ?? emptyTotals()
    const inc = isIncomplete(t.count, t.kcal, targets.kcal, d, today)
    const deficit = inc ? tdee - targets.kcal : tdee - t.kcal
    prev = prev - deficit / 7700
    expected.push({ day: d, kg: prev })
  }
  const lastExp = expected[expected.length - 1]?.kg ?? null
  return {
    points,
    avg7: avg7pts,
    expected,
    startDay,
    startAvg,
    endAvg,
    endDay,
    deltaKg: endAvg != null ? endAvg - startAvg : null,
    expectedDeltaKg: lastExp != null ? lastExp - startAvg : null,
  }
}

export function trendsView(
  logs: Iterable<Pick<LogRecord, 'deleted' | 'day' | 'kcal' | 'protein' | 'fat' | 'carb'>>,
  weights: Iterable<Pick<WeightRecord, 'deleted' | 'day' | 'kg' | 'updated_at'>>,
  config: Record<string, string>,
  today: string,
  weekMonday: string,
  weightSpanDays?: number,
): TrendsView {
  const slots = kcalBarSlots(logs, weights, config, today)
  const completeDays = slots.filter((s) => s.slot === 'complete').length
  const loggedDays = slots.filter((s) => s.slot !== 'future' && s.count > 0).length
  const incomplete = slots.filter((s) => s.slot === 'incomplete')
  const overGoal = Number(config.target_kcal) || 0
  const scored = slots.filter((s) => s.slot !== 'future')
  const completeKcal = slots.filter((s) => s.slot === 'complete').map((s) => s.kcal)
  return {
    summary: weekSummary(logs, config, today, weekMonday),
    slots,
    weight: weightSeries(logs, weights, config, today, weightSpanDays),
    completeDays,
    loggedDays,
    insufficient: loggedDays < 3,
    chartIncompleteN: incomplete.length,
    chartIncompleteDays: incomplete.map((s) => s.day),
    overGoalDays: scored.filter((s) => s.kcal > overGoal).length,
    chartAvgKcal: completeKcal.length ? Math.round(completeKcal.reduce((a, b) => a + b, 0) / completeKcal.length) : null,
  }
}

export type WeightRange = '1W' | '1M' | '3M'
export const WEIGHT_RANGE_DAYS: Record<WeightRange, number> = { '1W': 7, '1M': 30, '3M': 90 }

export function parseWeightRange(raw: string | null | undefined): WeightRange {
  return raw === '1W' || raw === '1M' || raw === '3M' ? raw : '1M'
}

/** 三條 y 刻度，全部是 0.5 kg 的倍數，包住資料且上下至少各 0.5 kg。 */
export function weightYTicks(values: number[]): { min: number; max: number; ticks: [number, number, number] } {
  const toU = (kg: number) => Math.round(kg * 100) // 0.01 kg
  const dMin = Math.min(...values.map(toU))
  const dMax = Math.max(...values.map(toU))
  const lo = dMin - 50
  const hi = dMax + 50
  let step = 50 // 0.5 kg
  while (step * 2 < hi - lo) step += 50
  const mid0 = Math.round(((dMin + dMax) / 2) / 50) * 50
  for (let guard = 0; guard < 12; guard++) {
    const bottom = mid0 - step
    const top = mid0 + step
    if (bottom <= lo && top >= hi) {
      const ticks = [bottom, mid0, top].map((u) => u / 100) as [number, number, number]
      return { min: ticks[0], max: ticks[2], ticks }
    }
    step += 50
  }
  const ticks = [mid0 - step, mid0, mid0 + step].map((u) => u / 100) as [number, number, number]
  return { min: ticks[0], max: ticks[2], ticks }
}
