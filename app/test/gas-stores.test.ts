import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'
import { norm } from '@/data/search'

const store = {
  id: 's:1', ts: '2026-10-10T12:00:00+08:00', name: '阿財牛肉麵', created_by: 'app',
}
const item = {
  id: 'u:beef', ts: '2026-10-10T12:00:00+08:00', kind: '自建', base_id: '', src: '其他', name: '牛肉麵',
  serving: '1 份', serving_g: null, kcal: 520, protein: 28, fat: 18, carb: 62, fav: false, created_by: 'app', store: 's:1',
}

test('norm 空白標點大小寫與 search.ts 相同', () => {
  const env = readyGas()
  expect(env.g.normName_(' 阿財牛肉麵 ')).toBe(env.g.normName_('阿財・牛肉麵'))
  expect(env.g.normName_('阿財牛肉麵')).toBe(env.g.normName_('阿財・牛肉麵'))
  expect(env.g.normName_('ABC麵')).toBe(env.g.normName_('abc麵'))
  expect(env.g.normName_(' 阿財牛肉麵 ')).toBe(norm('阿財・牛肉麵'))
})

test('重複店名（含標點／空白）回 duplicate_name；已刪除的名字可以再用', () => {
  const env = readyGas()
  expect(env.call({ action: 'upsertStore', record: store }).ok).toBe(true)
  const dup = env.call({ action: 'upsertStore', record: { id: 's:2', name: ' 阿財・牛肉麵 ', ts: store.ts } })
  expect(dup.error).toBe('duplicate_name')
  expect(dup.existingId).toBe('s:1')
  expect(dup.existingName).toBe('阿財牛肉麵')
  expect(env.call({ action: 'softDelete', table: 'Stores', id: 's:1' }).ok).toBe(true)
  expect(env.call({ action: 'upsertStore', record: { id: 's:3', name: '阿財牛肉麵', ts: store.ts } }).ok).toBe(true)
})

test('軟刪店家連帶品項；restore 只還原同一 updated_at；Logs 不動', () => {
  const env = readyGas()
  env.call({ action: 'upsertStore', record: store })
  env.call({ action: 'upsertItem', record: item })
  env.call({ action: 'upsertItem', record: { ...item, id: 'u:old', name: '早刪的' } })
  env.call({ action: 'softDelete', table: 'Items', id: 'u:old' })
  env.call({ action: 'append', table: 'Logs', record: {
    id: 'l1', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: 'u:beef', name: '牛肉麵', src: '其他',
    qty: 1, kcal: 520, protein: 28, fat: 18, carb: 62, store: 's:1',
  }})
  const before = env.call({ action: 'read' })
  const logRow = before.logs.find((r: { id: string }) => r.id === 'l1')
  expect(env.call({ action: 'softDelete', table: 'Stores', id: 's:1' }).ok).toBe(true)
  const mid = env.call({ action: 'read' })
  expect(mid.stores.find((s: { id: string }) => s.id === 's:1').deleted).toBe(true)
  expect(mid.items.find((i: { id: string }) => i.id === 'u:beef').deleted).toBe(true)
  expect(mid.items.find((i: { id: string }) => i.id === 'u:old').deleted).toBe(true)
  expect(mid.logs.find((r: { id: string }) => r.id === 'l1')).toEqual(logRow)
  expect(env.call({ action: 'restore', table: 'Stores', id: 's:1' }).ok).toBe(true)
  const after = env.call({ action: 'read' })
  expect(after.stores.find((s: { id: string }) => s.id === 's:1').deleted).toBe(false)
  expect(after.items.find((i: { id: string }) => i.id === 'u:beef').deleted).toBe(false)
  expect(after.items.find((i: { id: string }) => i.id === 'u:old').deleted).toBe(true)
  expect(after.logs.find((r: { id: string }) => r.id === 'l1').kcal).toBe(520)
})

test('last_eaten_at 取較新的 ts；往回補記不把時間撥回', () => {
  const env = readyGas()
  env.call({ action: 'upsertStore', record: store })
  env.call({ action: 'append', table: 'Logs', record: {
    id: 'l1', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: 'x', name: 'x', src: '其他',
    qty: 1, kcal: 1, protein: 1, fat: 1, carb: 1, store: 's:1',
  }})
  let st = env.call({ action: 'read' }).stores.find((s: { id: string }) => s.id === 's:1')
  expect(st.last_eaten_at).toBe('2026-10-10T12:00:00+08:00')
  env.call({ action: 'append', table: 'Logs', record: {
    id: 'l0', ts: '2026-10-10T08:00:00+08:00', day: '2026-10-10', item_id: 'x', name: 'x', src: '其他',
    qty: 1, kcal: 1, protein: 1, fat: 1, carb: 1, store: 's:1',
  }})
  st = env.call({ action: 'read' }).stores.find((s: { id: string }) => s.id === 's:1')
  expect(st.last_eaten_at).toBe('2026-10-10T12:00:00+08:00')
  env.call({ action: 'append', table: 'Logs', record: {
    id: 'l2', ts: '2026-10-10T18:00:00+08:00', day: '2026-10-10', item_id: 'x', name: 'x', src: '其他',
    qty: 1, kcal: 1, protein: 1, fat: 1, carb: 1, store: 's:1',
  }})
  st = env.call({ action: 'read' }).stores.find((s: { id: string }) => s.id === 's:1')
  expect(st.last_eaten_at).toBe('2026-10-10T18:00:00+08:00')
})

test('upsertItem 改 kcal 之後 Logs 那一列逐欄相等', () => {
  const env = readyGas()
  env.call({ action: 'upsertStore', record: store })
  env.call({ action: 'upsertItem', record: item })
  env.call({ action: 'append', table: 'Logs', record: {
    id: 'l1', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: 'u:beef', name: '牛肉麵', src: '其他',
    qty: 1, kcal: 520, protein: 28, fat: 18, carb: 62, store: 's:1',
  }})
  const before = JSON.stringify(env.call({ action: 'read' }).logs.find((r: { id: string }) => r.id === 'l1'))
  expect(env.call({ action: 'upsertItem', record: { ...item, kcal: 600 } }).ok).toBe(true)
  const after = JSON.stringify(env.call({ action: 'read' }).logs.find((r: { id: string }) => r.id === 'l1'))
  expect(after).toBe(before)
})
