import { expect, test } from 'vitest'
import { norm, normName } from '../src/norm'
import { remaining, sumLogs } from '../src/nutrition'
import { summarizeDay } from '../src/summary'

// 由 legacy/test/gas-summary.test.ts 搬來：剩餘 = 目標 − 存檔合計，含一位小數。
test('剩餘 = 目標 − 存檔合計，和 sumLogs 一致，含一位小數', () => {
  const logs = [
    { day: '2026-10-10', kcal: 159, protein: 31.2, fat: 2.3, carb: 3.5, deleted_at: null },
    { day: '2026-10-10', kcal: 53, protein: 10.4, fat: 0.8, carb: 1.2, deleted_at: null },
    { day: '2026-10-09', kcal: 999, protein: 9, fat: 9, carb: 9, deleted_at: null },
    { day: '2026-10-10', kcal: 777, protein: 7, fat: 7, carb: 7, deleted_at: '2026-10-10T20:00:00+08:00' },
  ]
  const cfg = { target_kcal: 2000, target_protein: 150, target_fat: 60, target_carb: 200 }
  const s = summarizeDay(logs, cfg, '2026-10-10')
  const totals = sumLogs(logs.slice(0, 2))
  expect(s.count).toBe(2)
  expect(s.totals).toEqual({ kcal: totals.kcal, protein: totals.protein, fat: totals.fat, carb: totals.carb })
  expect(s.remaining).toEqual(remaining(s.targets, totals))
  expect(s.totals.protein).toBe(41.6)
})

test('summarizeDay：目標為空字串或非數字當 0，剩餘可以是負數；day 欄位只看前 10 碼', () => {
  const s = summarizeDay([{ day: '2026-10-10T00:00:00+08:00', kcal: 100, protein: 1, fat: 1, carb: 1 }], { target_kcal: '', target_protein: 'x' }, '2026-10-10')
  expect(s.targets).toEqual({ kcal: 0, protein: 0, fat: 0, carb: 0 })
  expect(s.remaining.kcal).toBe(-100)
})

// 由 legacy/test/gas-stores.test.ts 搬來：norm 空白標點大小寫。
test('normName 空白、標點、全形、大小寫', () => {
  expect(normName(' 阿財牛肉麵 ')).toBe(normName('阿財・牛肉麵'))
  expect(normName('阿財牛肉麵')).toBe(normName('阿財・牛肉麵'))
  expect(normName('ABC麵')).toBe(normName('abc麵'))
  expect(normName('ＡＢＣ（麵）')).toBe('abc麵')
  expect(norm).toBe(normName)
})
