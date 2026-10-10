import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'

const ts = '2026-10-10T08:00:00+08:00'

test('同日第二次新 id 後只有一筆未刪除、kg 是新的、列的 id 仍是第一筆', () => {
  const env = readyGas()
  env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.0, id: 'w1', ts } })
  const second = env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.8, id: 'w2', ts } })
  expect(second.overwritten).toBe(true)
  const live = env.call({ action: 'read' }).weights.filter((w: { deleted: boolean }) => !w.deleted)
  expect(live).toHaveLength(1)
  expect(live[0].kg).toBe(72.8)
  expect(live[0].id).toBe('w1')
})

test('重送第一個 id 不會把 kg 改回去', () => {
  const env = readyGas()
  env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.0, id: 'w1', ts } })
  env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.8, id: 'w2', ts } })
  const dup = env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.0, id: 'w1', ts } })
  expect(dup.duplicate).toBe(true)
  expect(env.call({ action: 'read' }).weights.find((w: { id: string }) => w.id === 'w1').kg).toBe(72.8)
})

test('重送目前這次的新 id 若已不在列上，結果仍是一筆且 kg 不變', () => {
  const env = readyGas()
  env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.0, id: 'w1', ts } })
  env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.8, id: 'w2', ts } })
  const again = env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.8, id: 'w2', ts } })
  expect(again.ok).toBe(true)
  const live = env.call({ action: 'read' }).weights.filter((w: { deleted: boolean }) => !w.deleted)
  expect(live).toHaveLength(1)
  expect(live[0].kg).toBe(72.8)
})

test('未來日期、29.9、250.1、72.44 拒收', () => {
  const env = readyGas()
  expect(env.call({ action: 'upsertWeight', record: { day: '2099-01-01', kg: 72, id: 'f', ts: '2099-01-01T08:00:00+08:00' } }).error).toBe('bad_record')
  expect(env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 29.9, id: 'a', ts } }).error).toBe('bad_record')
  expect(env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 250.1, id: 'b', ts } }).error).toBe('bad_record')
  expect(env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.44, id: 'c', ts } }).error).toBe('bad_record')
})

test('軟刪除後同一天可以再 append', () => {
  const env = readyGas()
  env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 72.0, id: 'w1', ts } })
  env.call({ action: 'softDelete', table: 'Weights', id: 'w1' })
  const again = env.call({ action: 'upsertWeight', record: { day: '2026-10-10', kg: 73.1, id: 'w3', ts } })
  expect(again.ok).toBe(true)
  expect(again.overwritten).toBeFalsy()
  const live = env.call({ action: 'read' }).weights.filter((w: { deleted: boolean }) => !w.deleted)
  expect(live).toHaveLength(1)
  expect(live[0].id).toBe('w3')
  expect(live[0].kg).toBe(73.1)
})
