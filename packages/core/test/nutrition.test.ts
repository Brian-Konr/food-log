import { expect, test } from 'vitest'
import { canUseGrams, formatRemain, fromGrams, fromQty, remaining, rescaleLog, roundKcal, roundMacro, sumLogs } from '../src/nutrition'

// v1 形狀的測試列（deleted: boolean）；core 也接受 v2 的 deleted_at。
type LogRecord = {
  id: string; ts: string; deleted: boolean; updated_at: string; day: string; item_id: string; name: string; src: string
  qty: number; grams: number | null; kcal: number; protein: number; fat: number; carb: number; source: string; store: string
}

const per = { kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3 }

function log(partial: Partial<LogRecord>): LogRecord {
  return {
    id: '1', ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-10',
    item_id: 'x', name: 'x', src: '全家', qty: 1, grams: null, kcal: 0, protein: 0, fat: 0, carb: 0, source: 'app', store: '', ...partial,
  }
}

test('1.5 份換算', () => {
  expect(fromQty(per, 1.5)).toEqual({ kcal: 159, protein: 31.2, fat: 2.3, carb: 3.5 })
})

test('50 g 與 30 g 換算', () => {
  expect(fromGrams(per, 50, 100)).toEqual({ qty: 0.5, macros: { kcal: 53, protein: 10.4, fat: 0.8, carb: 1.2 } })
  expect(fromGrams(per, 30, 100)).toEqual({ qty: 0.3, macros: { kcal: 32, protein: 6.2, fat: 0.5, carb: 0.7 } })
})

test('0.5 / 1 / 1.5 / 2 份', () => {
  expect(fromQty(per, 0.5).kcal).toBe(roundKcal(53))
  expect(fromQty(per, 1).kcal).toBe(106)
  expect(fromQty(per, 1.5).kcal).toBe(159)
  expect(fromQty(per, 2).kcal).toBe(212)
})

test('沒有 servingG 不能用克', () => {
  expect(canUseGrams({ servingG: null })).toBe(false)
  expect(canUseGrams({ servingG: 100 })).toBe(true)
})

test('合計用存檔值，不再 round 總和', () => {
  const totals = sumLogs([
    log({ kcal: 159, protein: 31.2, fat: 2.3, carb: 3.5 }),
    log({ kcal: 53, protein: 10.4, fat: 0.8, carb: 1.2 }),
    log({ deleted: true, kcal: 999, protein: 9, fat: 9, carb: 9 }),
  ])
  expect(totals).toEqual({ kcal: 212, protein: 41.6, fat: 3.1, carb: 4.7, count: 2 })
})

test('剩餘與超過不出現負號', () => {
  const rem = remaining({ kcal: 2000, protein: 150, fat: 60, carb: 200 }, { kcal: 2120, protein: 155, fat: 10, carb: 20 })
  expect(rem.kcal).toBe(-120)
  expect(formatRemain(rem.kcal, 'kcal')).toBe('超過 120 kcal')
  expect(formatRemain(rem.protein, 'g')).toBe('超過 5.0 g')
  expect(formatRemain(900, 'kcal')).toBe('900 kcal')
  expect(formatRemain(75, 'g')).toBe('75.0 g')
  expect(formatRemain(900, 'kcal')).not.toMatch(/-/)
})

test('編輯和刪除後剩餘立刻變', () => {
  const targets = { kcal: 2000, protein: 150, fat: 60, carb: 200 }
  const a = log({ id: 'a', kcal: 200, protein: 10, fat: 1, carb: 2 })
  const b = log({ id: 'b', kcal: 300, protein: 20, fat: 2, carb: 4 })
  expect(remaining(targets, sumLogs([a, b])).kcal).toBe(1500)
  const edited = { ...b, ...rescaleLog(b, { kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3 }, 2, null, 100).macros, qty: 2 }
  expect(remaining(targets, sumLogs([a, edited])).kcal).toBe(2000 - 200 - 212)
  expect(remaining(targets, sumLogs([a, { ...b, deleted: true }])).kcal).toBe(1800)
})

test('round helpers', () => {
  expect(roundKcal(31.6)).toBe(32)
  expect(roundMacro(2.25)).toBe(2.3)
})
