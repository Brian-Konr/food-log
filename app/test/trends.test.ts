import { expect, test } from 'vitest'
import { addDays, weekStart } from '@/lib/day'
import { isIncomplete, kcalBarSlots, latestKgByDay, avg7, weekSummary, weightSeries, trendsView, weightYTicks, parseWeightRange } from '@/lib/trends'
import type { LogRecord, WeightRecord } from '@/types'

const TODAY = '2026-10-10'
const CFG = { target_kcal: '2000', target_protein: '150', target_fat: '60', target_carb: '200', tdee: '2650' }

function L(day: string, kcal: number, protein = 0, extra: Partial<LogRecord> = {}): LogRecord {
  return {
    id: extra.id ?? `${day}-${kcal}-${Math.random()}`, ts: `${day}T12:00:00+08:00`, deleted: false, updated_at: `${day}T12:00:00+08:00`,
    day, item_id: 'x', name: 'x', src: '全家', qty: 1, grams: null, kcal, protein, fat: 0, carb: 0, source: 'app', store: '', ...extra,
  }
}
function W(day: string, kg: number, updated_at = `${day}T08:00:00+08:00`, extra: Partial<WeightRecord> = {}): WeightRecord {
  return { id: extra.id ?? `w-${day}-${updated_at}`, day, ts: `${day}T08:00:00+08:00`, deleted: false, updated_at, kg, ...extra }
}

test('1. 週一起算，含 10/11 仍屬 10/5；10/1 的週一是 9/28', () => {
  expect(weekStart('2026-10-10')).toBe('2026-10-05')
  expect(weekStart('2026-10-11')).toBe('2026-10-05')
  expect(weekStart('2026-10-01')).toBe('2026-09-28')
})

test('2. 今天只有 1 筆，不是不完整', () => {
  expect(isIncomplete(1, 300, 2000, TODAY, TODAY)).toBe(false)
})

test('3. 昨天只有 1 筆，即使 3000 kcal 也是不完整', () => {
  expect(isIncomplete(1, 3000, 2000, '2026-10-09', TODAY)).toBe(true)
})

test('4. 昨天 2 筆且 999 不完整；2 筆且 1000 完整', () => {
  expect(isIncomplete(2, 999, 2000, '2026-10-09', TODAY)).toBe(true)
  expect(isIncomplete(2, 1000, 2000, '2026-10-09', TODAY)).toBe(false)
})

test('5. 昨天 0 筆是不完整', () => {
  expect(isIncomplete(0, 0, 2000, '2026-10-09', TODAY)).toBe(true)
})

test('6. 週平均跳過不完整日；全都不完整則平均是 null', () => {
  const logs = [
    L('2026-10-05', 3000, 160), // 1 筆 → 不完整
    L('2026-10-06', 500, 40),
    L('2026-10-06', 499, 40), // 2 筆 999 → 不完整
  ]
  const s = weekSummary(logs, CFG, TODAY, '2026-10-05')
  expect(s.avgKcal).toBeNull()
  const complete = [
    L('2026-10-05', 1000, 160, { id: 'a' }),
    L('2026-10-05', 980, 10, { id: 'b' }),
    L('2026-10-06', 500, 80, { id: 'c' }),
  ]
  // 10/6 只有 1 筆 → 不完整，平均只有 10/5 的 1980
  expect(weekSummary(complete, CFG, TODAY, '2026-10-05').avgKcal).toBe(1980)
})

test('7. 平均 1980 → 赤字 670；平均 2800 → 超過 150', () => {
  const mk = (kcal: number) => {
    const logs: LogRecord[] = []
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']) {
      logs.push(L(d, kcal / 2, 160, { id: d + 'a' }), L(d, kcal / 2, 10, { id: d + 'b' }))
    }
    return weekSummary(logs, CFG, TODAY, '2026-10-05')
  }
  expect(mk(1980).avgKcal).toBe(1980)
  expect(mk(1980).avgDeficit).toBe(670)
  expect(mk(2800).avgDeficit).toBe(-150)
})

test('8. tdee 空 → 赤字 null、預期線空', () => {
  const logs = [L('2026-10-05', 1000, 160, { id: 'a' }), L('2026-10-05', 980, 10, { id: 'b' })]
  const s = weekSummary(logs, { ...CFG, tdee: '' }, TODAY, '2026-10-05')
  expect(s.avgDeficit).toBeNull()
  const w = weightSeries(logs, [W('2026-09-12', 74), W('2026-09-13', 74), W('2026-09-14', 74)], { ...CFG, tdee: '' }, TODAY)
  expect(w.expected).toEqual([])
})

test('9. 蛋白質分母是 6；不完整日達標仍進分子與分母；週日不算', () => {
  const logs = [
    L('2026-10-05', 1000, 160, { id: 'a' }), L('2026-10-05', 1000, 10, { id: 'b' }), // complete, hit
    L('2026-10-09', 3000, 160, { id: 'c' }), // 1 筆 incomplete, hit
  ]
  const s = weekSummary(logs, CFG, TODAY, '2026-10-05')
  expect(s.proteinDenom).toBe(6)
  expect(s.proteinHit).toBe(2)
})

test('10. 長條 28 格，起點本週一減 21 天；本週日 future；今天是 today', () => {
  const slots = kcalBarSlots([], [], CFG, TODAY)
  expect(slots).toHaveLength(28)
  expect(slots[0].day).toBe(addDays(weekStart(TODAY), -21))
  expect(slots[0].day).toBe('2026-09-14')
  expect(slots.at(-1)!.day).toBe('2026-10-11')
  expect(slots.at(-1)!.slot).toBe('future')
  const today = slots.find((s) => s.day === TODAY)!
  expect(today.slot).toBe('today')
  expect(today.slot).not.toBe('incomplete')
})

test('11. 同日兩筆體重只貢獻一個點，值是後一次', () => {
  const map = latestKgByDay([
    W('2026-10-09', 72.0, '2026-10-09T08:00:00+08:00', { id: 'old' }),
    W('2026-10-09', 72.8, '2026-10-09T09:00:00+08:00', { id: 'new' }),
  ])
  expect(map.get('2026-10-09')).toBe(72.8)
  expect(map.size).toBe(1)
})

test('12. 7 日窗口 2 筆沒有平均；3 筆有平均', () => {
  const two = latestKgByDay([W('2026-10-08', 72), W('2026-10-10', 73)])
  expect(avg7(two, TODAY)).toBeNull()
  const three = latestKgByDay([W('2026-10-08', 72), W('2026-10-09', 73), W('2026-10-10', 74)])
  expect(avg7(three, TODAY)).toBe((72 + 73 + 74) / 3)
})

test('13. 不完整日預期步伐是 (2650-2000)/7700；今天不產生新點', () => {
  const weights = [W('2026-09-12', 74), W('2026-09-13', 74), W('2026-09-14', 74)]
  const w = weightSeries([], weights, CFG, TODAY)
  expect(w.startDay).toBe('2026-09-14')
  expect(w.expected[0]?.day).toBe('2026-09-14')
  expect(w.expected.some((p) => p.day === TODAY)).toBe(false)
  const step = (2650 - 2000) / 7700
  expect(w.expected[1]?.kg).toBeCloseTo(74 - step, 8)
})

test('14. 完整日少於 3 的旗標為真', () => {
  const slots = kcalBarSlots([L(TODAY, 100)], [], CFG, TODAY)
  const complete = slots.filter((s) => s.slot === 'complete').length
  expect(complete).toBeLessThan(3)
})

test('15. 五天各 1 筆 Kyujin：loggedDays 5、不足為假、五格 incomplete', () => {
  const start = addDays(weekStart(TODAY), -21)
  const logs = Array.from({ length: 5 }, (_, i) => L(addDays(start, i), 3000, 0, { source: 'kyujin' }))
  const v = trendsView(logs, [], CFG, TODAY, weekStart(TODAY))
  expect(v.insufficient).toBe(false)
  expect(v.loggedDays).toBe(5)
  for (let i = 0; i < 5; i++) {
    expect(v.slots.find((s) => s.day === addDays(start, i))?.slot).toBe('incomplete')
  }
})

test('16. 只有今天和昨天各 1 筆（昨天 quick）：loggedDays 2、不足為真', () => {
  const logs = [L(TODAY, 100), L(addDays(TODAY, -1), 100, 0, { source: 'quick' })]
  const v = trendsView(logs, [], CFG, TODAY, weekStart(TODAY))
  expect(v.loggedDays).toBe(2)
  expect(v.insufficient).toBe(true)
})

test('17. 同一天只有軟刪除紀錄不計入 loggedDays', () => {
  const logs = [
    L(TODAY, 100),
    L(addDays(TODAY, -1), 500, 0, { deleted: true }),
  ]
  expect(trendsView(logs, [], CFG, TODAY, weekStart(TODAY)).loggedDays).toBe(1)
})

test('18. 窗口起點再往前 1 天的紀錄不計入', () => {
  const before = addDays(addDays(weekStart(TODAY), -21), -1)
  const logs = [L(before, 2000)]
  expect(trendsView(logs, [], CFG, TODAY, weekStart(TODAY)).loggedDays).toBe(0)
})

test('19. 三個有紀錄的日子（可不完整）不足為假', () => {
  const logs = [L(TODAY, 100), L(addDays(TODAY, -1), 100), L(addDays(TODAY, -2), 100)]
  expect(trendsView(logs, [], CFG, TODAY, weekStart(TODAY)).insufficient).toBe(false)
})

test('20. weightSeries(..., 7) 的點只落在窗口，更早的體重仍可暖身 avg7', () => {
  const start = addDays(TODAY, -6)
  const w = weightSeries([], [
    W(addDays(start, -2), 70),
    W(addDays(start, -1), 71),
    W(start, 72),
  ], CFG, TODAY, 7)
  expect(w.points.every((p) => p.day >= start && p.day <= TODAY)).toBe(true)
  expect(w.points.map((p) => p.day)).toEqual([start])
  expect(w.avg7.some((p) => p.day === start)).toBe(true)
})

test('21. weightSeries 30／90／預設窗口起點', () => {
  const s30 = addDays(TODAY, -29)
  const w30 = weightSeries([], [W(s30, 70), W(addDays(s30, -1), 71)], CFG, TODAY, 30)
  expect(w30.points.map((p) => p.day)).toEqual([s30])
  const s90 = addDays(TODAY, -89)
  const w90 = weightSeries([], [W(s90, 70), W(addDays(s90, -1), 71)], CFG, TODAY, 90)
  expect(w90.points.map((p) => p.day)).toEqual([s90])
  const s29 = addDays(TODAY, -28)
  const wDef = weightSeries([], [W(s29, 70), W(addDays(s29, -1), 71)], CFG, TODAY)
  expect(wDef.points.map((p) => p.day)).toEqual([s29])
})

test('22. weightYTicks 四例且皆為 0.5 的倍數', () => {
  const cases: [number[], [number, number, number]][] = [
    [[72.4], [71.5, 72.5, 73.5]],
    [[72, 73], [71.5, 72.5, 73.5]],
    [[72.4, 72.9], [71.5, 72.5, 73.5]],
    [[70, 80], [69.5, 75, 80.5]],
  ]
  for (const [input, want] of cases) {
    const { ticks } = weightYTicks(input)
    expect(ticks).toEqual(want)
    for (const t of ticks) expect(Math.abs(t * 2 - Math.round(t * 2)) < 1e-9).toBe(true)
  }
})

test('23. parseWeightRange', () => {
  expect(parseWeightRange('1W')).toBe('1W')
  expect(parseWeightRange('1M')).toBe('1M')
  expect(parseWeightRange('3M')).toBe('3M')
  expect(parseWeightRange(null)).toBe('1M')
  expect(parseWeightRange('')).toBe('1M')
  expect(parseWeightRange('1Y')).toBe('1M')
})
