import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'
import { addDays, taipeiToday } from '@/lib/day'

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

test('read 的 Weights 含 −89 天、不含 −90 天，weightDays 是 90', () => {
  const env = readyGas()
  const today = taipeiToday(Date.now())
  const d89 = addDays(today, -89)
  const d90 = addDays(today, -90)
  env.call({ action: 'upsertWeight', record: { day: d89, kg: 72.0, id: 'w89', ts: `${d89}T08:00:00+08:00` } })
  env.call({ action: 'upsertWeight', record: { day: d90, kg: 73.0, id: 'w90', ts: `${d90}T08:00:00+08:00` } })
  const r = env.call({ action: 'read' })
  const days = r.weights.map((w: { day: string }) => String(w.day).slice(0, 10))
  expect(days).toContain(d89)
  expect(days).not.toContain(d90)
  expect(r.weightDays).toBe(90)
})

test('read 的 Logs 含 −34 天、不含 −35 天', () => {
  const env = readyGas()
  const today = taipeiToday(Date.now())
  const d34 = addDays(today, -34)
  const d35 = addDays(today, -35)
  env.call({
    action: 'append', table: 'Logs', record: {
      id: 'l34', ts: `${d34}T12:00:00+08:00`, day: d34, item_id: 'x', name: 'x', src: '全家',
      qty: 1, kcal: 100, protein: 1, fat: 1, carb: 1,
    },
  })
  env.call({
    action: 'append', table: 'Logs', record: {
      id: 'l35', ts: `${d35}T12:00:00+08:00`, day: d35, item_id: 'y', name: 'y', src: '全家',
      qty: 1, kcal: 100, protein: 1, fat: 1, carb: 1,
    },
  })
  const days = env.call({ action: 'read' }).logs.map((l: { day: string }) => String(l.day).slice(0, 10))
  expect(days).toContain(d34)
  expect(days).not.toContain(d35)
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
