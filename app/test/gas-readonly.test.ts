import { expect, test } from 'vitest'
import { readyGas } from './gas-fakes'

const TS = '2026-10-10T12:00:00+08:00'
const MSG = 'food-log 已搬到新網址，這裡只能讀'

const store = { id: 's:1', name: '店', ts: TS }
const item = { id: 'u:1', ts: TS, kind: '自建', base_id: '', src: '其他', name: '麵', serving: '1 份', serving_g: null, kcal: 100, protein: 1, fat: 1, carb: 1, fav: false, created_by: 'app', store: '' }
const log = { id: 'l1', ts: TS, day: '2026-10-10', item_id: 'u:1', name: '麵', src: '其他', qty: 1, kcal: 100, protein: 1, fat: 1, carb: 1 }
const weight = { id: 'w1', day: '2026-10-10', ts: TS, kg: 70 }

function seeded() {
  const env = readyGas()
  expect(env.call({ action: 'upsertStore', record: store }).ok).toBe(true)
  expect(env.call({ action: 'upsertItem', record: item }).ok).toBe(true)
  expect(env.call({ action: 'append', table: 'Logs', record: log }).ok).toBe(true)
  expect(env.call({ action: 'upsertWeight', record: weight }).ok).toBe(true)
  const dump = () => JSON.stringify([...env.sheets.entries()].map(([n, s]) => [n, s.data]))
  return { ...env, dump }
}

const writes: Record<string, unknown>[] = [
  { action: 'append', table: 'Logs', record: { ...log, id: 'l2' } },
  { action: 'update', table: 'Logs', id: 'l1', patch: { qty: 2, kcal: 200 } },
  { action: 'softDelete', table: 'Logs', id: 'l1' },
  { action: 'restore', table: 'Logs', id: 'l1' },
  { action: 'upsertItem', record: { ...item, id: 'u:2', name: '飯' } },
  { action: 'upsertStore', record: { id: 's:2', name: '另一家', ts: TS } },
  { action: 'upsertWeight', record: { id: 'w2', day: '2026-10-11', ts: TS, kg: 71 } },
  { action: 'setConfig', key: 'target_kcal', value: '1800' },
]

test('READ_ONLY=1：每個寫入 action 回 read_only，Sheet 不變', () => {
  const env = seeded()
  env.props.set('READ_ONLY', '1')
  for (const w of writes) {
    const before = env.dump()
    expect(env.call(w), String(w.action)).toEqual({ ok: false, error: 'read_only', message: MSG })
    expect(env.dump(), String(w.action)).toBe(before)
  }
  // Kyujin 也一樣
  expect(env.call({ ...writes[0], client: 'kyujin' })).toMatchObject({ ok: false, error: 'read_only' })
})

test('READ_ONLY=1：不取鎖（鎖被占住也回 read_only，不是 busy）', () => {
  const env = readyGas({ lockBusy: true })
  env.props.set('READ_ONLY', '1')
  expect(env.call(writes[0])).toMatchObject({ ok: false, error: 'read_only' })
})

test('READ_ONLY=1：read、history、summary、trends 和 GET 健康檢查照常', () => {
  const env = seeded()
  env.props.set('READ_ONLY', '1')
  const snap = env.call({ action: 'read' })
  expect(snap.ok).toBe(true)
  expect(snap.logs.map((r: { id: string }) => r.id)).toContain('l1')
  expect(env.call({ action: 'history', table: 'Logs', before: '2026-10-11' }).ok).toBe(true)
  expect(env.call({ action: 'summary', day: '2026-10-10' }).ok).toBe(true)
  expect(env.call({ action: 'trends', weekStart: '2026-10-05' }).ok).toBe(true)
  expect(env.get({})).toMatchObject({ ok: true, service: 'food-log' })
  expect(env.get({ secret: env.secret }).ok).toBe(true)
})

test('READ_ONLY=1：讀取不跑 ensureTextCols_（不寫 Sheet、不設旗標），關掉後才補跑', () => {
  const env = seeded()
  env.props.delete('text_cols_version')
  env.props.set('READ_ONLY', '1')
  const before = env.dump()
  expect(env.call({ action: 'read' }).ok).toBe(true)
  expect(env.call({ action: 'summary', day: '2026-10-10' }).ok).toBe(true)
  expect(env.props.has('text_cols_version')).toBe(false)
  expect(env.dump()).toBe(before)
  env.props.delete('READ_ONLY')
  expect(env.call({ action: 'read' }).ok).toBe(true)
  expect(env.props.has('text_cols_version')).toBe(true)
})

test('READ_ONLY=1：密鑰錯誤仍是 unauthorized，未知 action 仍是 bad_action', () => {
  const env = seeded()
  env.props.set('READ_ONLY', '1')
  expect(env.post({ secret: 'nope', action: 'append' })).toMatchObject({ ok: false, error: 'unauthorized' })
  expect(env.call({ action: 'nope' })).toMatchObject({ ok: false, error: 'bad_action' })
})

test('關掉開關（設 0、刪除屬性、其他值）後寫入恢復', () => {
  const env = seeded()
  env.props.set('READ_ONLY', '1')
  expect(env.call(writes[0]).error).toBe('read_only')
  env.props.set('READ_ONLY', '0')
  expect(env.call(writes[0]).ok).toBe(true)
  env.props.set('READ_ONLY', '1')
  expect(env.call(writes[1]).error).toBe('read_only')
  env.props.delete('READ_ONLY')
  expect(env.call(writes[1]).ok).toBe(true)
  env.props.set('READ_ONLY', 'true')
  expect(env.call(writes[2]).ok).toBe(true)
  const snap = env.call({ action: 'read' })
  expect(snap.logs.find((r: { id: string }) => r.id === 'l2')).toBeTruthy()
  expect(snap.logs.find((r: { id: string }) => r.id === 'l1').deleted).toBe(true)
})
