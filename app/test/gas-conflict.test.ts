import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'

test('刪除後 update／upsertItem／upsertStore 回 ignored:deleted 且儲存格不變', () => {
  const env = readyGas()
  env.call({ action: 'upsertStore', record: { id: 's:1', name: '店', ts: '2026-10-10T12:00:00+08:00' } })
  env.call({ action: 'upsertItem', record: {
    id: 'u:1', ts: '2026-10-10T12:00:00+08:00', kind: '自建', base_id: '', src: '其他', name: '麵', serving: '1 份',
    serving_g: null, kcal: 100, protein: 1, fat: 1, carb: 1, fav: false, created_by: 'app', store: '',
  }})
  env.call({ action: 'append', table: 'Logs', record: {
    id: 'l1', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: 'u:1', name: '麵', src: '其他',
    qty: 1, kcal: 100, protein: 1, fat: 1, carb: 1,
  }})
  env.call({ action: 'softDelete', table: 'Logs', id: 'l1' })
  env.call({ action: 'softDelete', table: 'Items', id: 'u:1' })
  env.call({ action: 'softDelete', table: 'Stores', id: 's:1' })
  const snap = env.call({ action: 'read' })
  const logCell = JSON.stringify(snap.logs.find((r: { id: string }) => r.id === 'l1'))
  const itemCell = JSON.stringify(snap.items.find((r: { id: string }) => r.id === 'u:1'))
  const storeCell = JSON.stringify(snap.stores.find((r: { id: string }) => r.id === 's:1'))
  expect(env.call({ action: 'update', table: 'Logs', id: 'l1', patch: { qty: 2, kcal: 200 } })).toMatchObject({ ok: true, ignored: 'deleted' })
  expect(env.call({ action: 'upsertItem', record: {
    id: 'u:1', ts: '2026-10-10T12:00:00+08:00', kind: '自建', base_id: '', src: '其他', name: '改', serving: '1 份',
    serving_g: null, kcal: 9, protein: 1, fat: 1, carb: 1, fav: false, created_by: 'app', store: '',
  }})).toMatchObject({ ok: true, ignored: 'deleted' })
  expect(env.call({ action: 'upsertStore', record: { id: 's:1', name: '改名', ts: '2026-10-10T12:00:00+08:00' } })).toMatchObject({ ok: true, ignored: 'deleted' })
  const after = env.call({ action: 'read' })
  expect(JSON.stringify(after.logs.find((r: { id: string }) => r.id === 'l1'))).toBe(logCell)
  expect(JSON.stringify(after.items.find((r: { id: string }) => r.id === 'u:1'))).toBe(itemCell)
  expect(JSON.stringify(after.stores.find((r: { id: string }) => r.id === 's:1'))).toBe(storeCell)
})
