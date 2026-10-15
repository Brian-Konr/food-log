import { expect, test } from 'vitest'
import { logArgs, noonOf, quickLogArgs, TEST_YESTERDAY } from '../src/testing'
import { expectErr, expectOk, newServer, row } from './helpers'

test('logs.add 成功：source 預設 app、item_id 空字串存成 null、name 去頭尾空白、day/ts 照存', async () => {
  const s = newServer()
  expectOk(await s.mutate('logs.add@1', { log: logArgs({ id: 'a', name: ' 雞胸 ' }) }))
  const r = row(s, 'logs', 'a')
  expect(r.source).toBe('app')
  expect(r.name).toBe('雞胸')
  expect(r.deleted_at).toBeNull()
  expectOk(await s.mutate('logs.add@1', { log: quickLogArgs({ id: 'q' }) }))
  expect(row(s, 'logs', 'q').item_id).toBeNull()
  expect(row(s, 'logs', 'q').source).toBe('quick')
})

test('logs.update：白名單欄位可改；不能改 source；用合併後的列重新驗證', async () => {
  const s = newServer()
  await s.mutate('logs.add@1', { log: logArgs({ id: 'a' }) })
  expectOk(await s.mutate('logs.update@1', { id: 'a', patch: { qty: 2, kcal: 212, name: ' 新名 ' } }))
  expect(row(s, 'logs', 'a')).toMatchObject({ qty: 2, kcal: 212, name: '新名' })
  expectErr(await s.mutate('logs.update@1', { id: 'a', patch: { source: 'quick' } }), 'bad_record')
  expectErr(await s.mutate('logs.update@1', { id: 'a', patch: { source: 'kyujin' } }), 'bad_record')
  expectOk(await s.mutate('logs.update@1', { id: 'a', patch: { source: 'app', kcal: 213 } })) // 同值不算改
  expectErr(await s.mutate('logs.update@1', { id: 'a', patch: { kcal: -5 } }), 'bad_record')
  expectErr(await s.mutate('logs.update@1', { id: 'a', patch: { day: '2026-10-09' } }), 'bad_record') // day ≠ ts 的台北日
  expectErr(await s.mutate('logs.update@1', { id: 'a', patch: { day: '2026-10-13', ts: noonOf('2026-10-13') } }), 'bad_record') // 未來
  expectErr(await s.mutate('logs.update@1', { id: 'a', patch: { qty: 0 } }), 'bad_record')
  expectOk(await s.mutate('logs.update@1', { id: 'a', patch: { grams: 150 } }))
  expectOk(await s.mutate('logs.update@1', { id: 'a', patch: { grams: null } }))
  expect(row(s, 'logs', 'a').grams).toBeNull()
  expectOk(await s.mutate('logs.update@1', { id: 'a', patch: { day: '2026-10-10', ts: noonOf('2026-10-10') } }))
  expect(row(s, 'logs', 'a').day).toBe('2026-10-10')
})

test('logs.update 不能改 id 以外的非白名單欄位（item_id、src、store_id 被忽略）', async () => {
  const s = newServer()
  await s.mutate('logs.add@1', { log: logArgs({ id: 'a' }) })
  expectOk(await s.mutateRaw('logs.update@1', { id: 'a', patch: { item_id: 'x', src: '其他', store_id: 's:1', id: 'zzz', kcal: 1 } }))
  expect(row(s, 'logs', 'a')).toMatchObject({ item_id: 'fm:1', src: '全家', store_id: null, id: 'a', kcal: 1 })
})

test('快速記錄（或沒有品項的紀錄）編輯時 qty 仍須是 1、不能有 grams', async () => {
  const s = newServer()
  await s.mutate('logs.add@1', { log: quickLogArgs({ id: 'q' }) })
  expectErr(await s.mutate('logs.update@1', { id: 'q', patch: { qty: 2 } }), 'bad_record')
  expectErr(await s.mutate('logs.update@1', { id: 'q', patch: { grams: 100 } }), 'bad_record')
  expectOk(await s.mutate('logs.update@1', { id: 'q', patch: { kcal: 350 } }))
})

test('logs.delete／restore：undo 是反向 mutation；重複送是 ignored', async () => {
  const s = newServer()
  await s.mutate('logs.add@1', { log: logArgs({ id: 'a' }) })
  expectOk(await s.mutate('logs.delete@1', { id: 'a' }))
  expect(row(s, 'logs', 'a').deleted_at).not.toBeNull()
  expect(expectOk(await s.mutate('logs.delete@1', { id: 'a' }))).toEqual({ ignored: 'deleted' })
  expectOk(await s.mutate('logs.restore@1', { id: 'a' }))
  expect(row(s, 'logs', 'a').deleted_at).toBeNull()
  expect(expectOk(await s.mutate('logs.restore@1', { id: 'a' }))).toEqual({ ignored: 'not_deleted' })
  expectErr(await s.mutate('logs.delete@1', { id: 'nope' }), 'not_found')
  expectErr(await s.mutate('logs.restore@1', { id: 'nope' }), 'not_found')
})

test('刪除後再用同 id 重送 logs.add 仍是 duplicate（不會復活）', async () => {
  const s = newServer()
  await s.mutate('logs.add@1', { log: logArgs({ id: 'a' }) })
  await s.mutate('logs.delete@1', { id: 'a' })
  expect(expectOk(await s.mutate('logs.add@1', { log: logArgs({ id: 'a' }) }))).toEqual({ duplicate: true })
  expect(row(s, 'logs', 'a').deleted_at).not.toBeNull()
})

test('日期常數', () => {
  expect(noonOf(TEST_YESTERDAY)).toBe('2026-10-11T12:00:00+08:00')
})
