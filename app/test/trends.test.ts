import { expect, test } from 'vitest'
import { addDays, weekStart } from '@/lib/day'
import { isIncomplete, kcalBarSlots, latestKgByDay, avg7, weekSummary, weightSeries } from '@/lib/trends'
import type { LogRecord, WeightRecord } from '@/types'

const TODAY = '2026-10-10'
const CFG = { target_kcal: '2000', target_protein: '150', target_fat: '60', target_carb: '200', tdee: '2650' }

function L(day: string, kcal: number, protein = 0, extra: Partial<LogRecord> = {}): LogRecord {
  return {
    id: extra.id ?? `${day}-${kcal}-${Math.random()}`, ts: `${day}T12:00:00+08:00`, deleted: false, updated_at: `${day}T12:00:00+08:00`,
    day, item_id: 'x', name: 'x', src: '全家', qty: 1, grams: null, kcal, protein, fat: 0, carb: 0, ...extra,
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
