import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'

test('提醒時間寫入後讀回來還是 HH:mm（試算表不會把它變成日期）', () => {
  const { call } = readyGas()
  expect(call({ action: 'setConfig', key: 'remind_meal_times', value: '12:30,19:00' }).ok).toBe(true)
  expect(call({ action: 'setConfig', key: 'remind_weight_time', value: '07:15' }).ok).toBe(true)
  expect(call({ action: 'setConfig', key: 'remind_weight_time', value: '07:30' }).ok).toBe(true)
  const cfg = call({ action: 'read' }).config
  expect(cfg.remind_meal_times).toBe('12:30,19:00')
  expect(cfg.remind_weight_time).toBe('07:30')
})
