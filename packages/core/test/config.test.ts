// 由 legacy/test/gas-config-time.test.ts 搬來，加上 setConfig_ 的驗證規則。config 是有型別的欄位。
import { expect, test } from 'vitest'
import { configToStrings, defaultConfigRow, DEFAULT_CONFIG_VALUES } from '../src/schema/config'
import { MemoryTx } from '../src/testing'
import { expectErr, expectOk, newServer, row } from './helpers'

function cfg(s: ReturnType<typeof newServer>) {
  return new MemoryTx(s.db).getConfig()
}

test('提醒時間寫入後讀回來還是 HH:mm（存成字串陣列／字串，不是日期）', async () => {
  const s = newServer()
  expectOk(await s.mutate('config.set@1', { key: 'remind_meal_times', value: '12:30,19:00' }))
  expectOk(await s.mutate('config.set@1', { key: 'remind_weight_time', value: '07:15' }))
  expectOk(await s.mutate('config.set@1', { key: 'remind_weight_time', value: '07:30' }))
  const c = await cfg(s)
  expect(c.remind_meal_times).toEqual(['12:30', '19:00'])
  expect(c.remind_weight_time).toBe('07:30')
  const strings = configToStrings(c)
  expect(strings.remind_meal_times).toBe('12:30,19:00')
  expect(strings.remind_weight_time).toBe('07:30')
})

test('預設值和 v1 的 DEFAULT_CONFIG 相同；沒有 config 列時 getConfig 回預設', async () => {
  const s = newServer()
  const c = await cfg(s)
  expect(configToStrings(c)).toEqual({
    target_kcal: '2000', target_protein: '150', target_fat: '60', target_carb: '200', tdee: '', remind_meal_times: '', remind_weight_time: '',
  })
  expect(defaultConfigRow('u').target_kcal).toBe(DEFAULT_CONFIG_VALUES.target_kcal)
})

test('tdee：空字串清除；1200–5000 的整數；其他 bad_record', async () => {
  const s = newServer()
  expectOk(await s.mutate('config.set@1', { key: 'tdee', value: 2650 }))
  expect((await cfg(s)).tdee).toBe(2650)
  expectOk(await s.mutate('config.set@1', { key: 'tdee', value: '' }))
  expect((await cfg(s)).tdee).toBeNull()
  expectOk(await s.mutate('config.set@1', { key: 'tdee', value: null }))
  for (const bad of ['1199', '5001', '2650.5', 'abc', '-1']) expectErr(await s.mutate('config.set@1', { key: 'tdee', value: bad }), 'bad_record')
})

test('target_kcal 必須是 ≥ 0 的整數；蛋白質、脂肪、碳水目標 ≥ 0 的數字（可小數）', async () => {
  const s = newServer()
  expectOk(await s.mutate('config.set@1', { key: 'target_kcal', value: '1800' }))
  expect((await cfg(s)).target_kcal).toBe(1800)
  for (const bad of ['', '18.5', '-5', 'x']) expectErr(await s.mutate('config.set@1', { key: 'target_kcal', value: bad }), 'bad_record')
  expectOk(await s.mutate('config.set@1', { key: 'target_protein', value: '150.5' }))
  expect((await cfg(s)).target_protein).toBe(150.5)
  expectOk(await s.mutate('config.set@1', { key: 'target_fat', value: 0 }))
  for (const key of ['target_protein', 'target_fat', 'target_carb'] as const) {
    for (const bad of ['', '-1', 'abc', 'Infinity']) expectErr(await s.mutate('config.set@1', { key, value: bad }), 'bad_record')
  }
})

test('提醒時間格式：非 HH:mm 拒收；空字串清除', async () => {
  const s = newServer()
  for (const bad of ['7:30', '24:00', '12:60', 'noon', '12:30,xx']) {
    expectErr(await s.mutate('config.set@1', { key: 'remind_meal_times', value: bad }), 'bad_record')
  }
  expectErr(await s.mutate('config.set@1', { key: 'remind_weight_time', value: '25:00' }), 'bad_record')
  expectOk(await s.mutate('config.set@1', { key: 'remind_meal_times', value: ['08:00', '12:30'] }))
  expect((await cfg(s)).remind_meal_times).toEqual(['08:00', '12:30'])
  expectOk(await s.mutate('config.set@1', { key: 'remind_meal_times', value: '' }))
  expectOk(await s.mutate('config.set@1', { key: 'remind_weight_time', value: '' }))
  const c = await cfg(s)
  expect(c.remind_meal_times).toEqual([])
  expect(c.remind_weight_time).toBeNull()
})

test('不能寫的鍵（含 v1 的 fav_ids、schema_version）→ bad_record；Kyujin 先 forbidden（連壞鍵也是）', async () => {
  const s = newServer()
  expectErr(await s.mutate('config.set@1', { key: 'fav_ids', value: 'a,b' }), 'bad_record')
  expectErr(await s.mutate('config.set@1', { key: 'schema_version', value: '9' }), 'bad_record')
  expectErr(await s.asKyujin('config.set@1', { key: 'fav_ids', value: 'a' }), 'forbidden')
  expectErr(await s.asKyujin('config.set@1', { key: 'target_kcal', value: '1' }), 'forbidden')
})

test('config 列有 version，pull 帶得走', async () => {
  const s = newServer()
  await s.mutate('config.set@1', { key: 'target_kcal', value: '1900' })
  const r = await s.pull({ clientId: 'c' })
  expect(r.changes.config).toHaveLength(1)
  expect(r.changes.config[0]!.target_kcal).toBe(1900)
  expect(row(s, 'config', 'config').version).toBeGreaterThan(0)
})
