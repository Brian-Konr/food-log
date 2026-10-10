import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'
import { remaining, sumLogs } from '@/lib/nutrition'

test('剩餘 = 目標 − 存檔合計，和 sumLogs 一致，含一位小數', () => {
  const env = readyGas()
  env.call({
    action: 'append', table: 'Logs', record: {
      id: 'a', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: 'x', name: 'x', src: '全家',
      qty: 1, kcal: 159, protein: 31.2, fat: 2.3, carb: 3.5,
    },
  })
  env.call({
    action: 'append', table: 'Logs', record: {
      id: 'b', ts: '2026-10-10T13:00:00+08:00', day: '2026-10-10', item_id: 'y', name: 'y', src: '7-11',
      qty: 1, kcal: 53, protein: 10.4, fat: 0.8, carb: 1.2,
    },
  })
  const s = env.call({ action: 'summary', day: '2026-10-10' })
  const logs = env.call({ action: 'read' }).logs
  const totals = sumLogs(logs)
  expect(s.totals).toEqual({ kcal: totals.kcal, protein: totals.protein, fat: totals.fat, carb: totals.carb })
  expect(s.remaining).toEqual(remaining(s.targets, totals))
  expect(s.totals.protein).toBe(41.6)
})
