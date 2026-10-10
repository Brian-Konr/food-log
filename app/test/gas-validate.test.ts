import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'

const rec = {
  id: 'log-1', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: 'fm:1', name: '雞胸', src: '全家',
  qty: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}

test('缺任一營養素、負數、字串數字 → bad_record；0 可以', () => {
  const { call } = readyGas()
  expect(call({ action: 'append', table: 'Logs', record: { ...rec, id: 'a', protein: null } }).error).toBe('bad_record')
  expect(call({ action: 'append', table: 'Logs', record: { ...rec, id: 'b', fat: -1 } }).error).toBe('bad_record')
  expect(call({ action: 'append', table: 'Logs', record: { ...rec, id: 'c', carb: '2.3' } }).error).toBe('bad_record')
  expect(call({ action: 'append', table: 'Logs', record: { ...rec, id: 'd', protein: 0, fat: 0, carb: 0 } }).ok).toBe(true)
})

test('day 和 ts 不符 → bad_record', () => {
  const { call } = readyGas()
  expect(call({ action: 'append', table: 'Logs', record: { ...rec, day: '2026-10-09' } }).error).toBe('bad_record')
})

test('重複 log id 成功且只有一列', () => {
  const env = readyGas()
  expect(env.call({ action: 'append', table: 'Logs', record: rec }).ok).toBe(true)
  const again = env.call({ action: 'append', table: 'Logs', record: rec })
  expect(again.ok).toBe(true)
  expect(again.duplicate).toBe(true)
  const data = env.call({ action: 'read' })
  expect(data.logs.filter((r: { id: string }) => r.id === 'log-1')).toHaveLength(1)
})
