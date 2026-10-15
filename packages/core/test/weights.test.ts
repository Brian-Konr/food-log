// 由 legacy/test/gas-weights.test.ts 搬來（read 視窗的案例屬於 Bot API，不在 core），加上計畫 §3.2 的 weights 規則。
import { expect, test } from 'vitest'
import { noonOf, TEST_YESTERDAY, weightArgs } from '../src/testing'
import { expectErr, expectOk, live, newServer, row } from './helpers'

const day = '2026-10-10'
const ts = noonOf(day, '08:00')
const w = (id: string, kg: number) => weightArgs({ id, day, kg, ts })

test('同日第二次新 id 後只有一筆未刪除、kg 是新的、列的 id 仍是第一筆；回 {rowId, overwritten, prevKg}', async () => {
  const s = newServer()
  const first = expectOk(await s.mutate('weights.upsert@1', w('w1', 72.0)))
  expect(first).toEqual({ rowId: 'w1', overwritten: false, prevKg: null })
  const second = expectOk(await s.mutate('weights.upsert@1', w('w2', 72.8)))
  expect(second).toEqual({ rowId: 'w1', overwritten: true, prevKg: 72 })
  const rows = live(s, 'weights')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.kg).toBe(72.8)
  expect(rows[0]!.id).toBe('w1')
})

test('重送第一個 id 不會把 kg 改回去（duplicate）', async () => {
  const s = newServer()
  await s.mutate('weights.upsert@1', w('w1', 72.0))
  await s.mutate('weights.upsert@1', w('w2', 72.8))
  const dup = expectOk(await s.mutate('weights.upsert@1', w('w1', 72.0)))
  expect(dup).toEqual({ duplicate: true })
  expect(row(s, 'weights', 'w1').kg).toBe(72.8)
})

test('重送目前這次的新 id 若已不在列上，結果仍是一筆且 kg 不變', async () => {
  const s = newServer()
  await s.mutate('weights.upsert@1', w('w1', 72.0))
  await s.mutate('weights.upsert@1', w('w2', 72.8))
  expectOk(await s.mutate('weights.upsert@1', w('w2', 72.8)))
  const rows = live(s, 'weights')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.kg).toBe(72.8)
})

test('未來日期、29.9、250.1、72.44 拒收；30 和 250 可以', async () => {
  const s = newServer()
  expectErr(await s.mutate('weights.upsert@1', weightArgs({ id: 'f', day: '2099-01-01', ts: '2099-01-01T08:00:00+08:00' })), 'bad_record')
  expectErr(await s.mutate('weights.upsert@1', w('a', 29.9)), 'bad_record')
  expectErr(await s.mutate('weights.upsert@1', w('b', 250.1)), 'bad_record')
  expectErr(await s.mutate('weights.upsert@1', w('c', 72.44)), 'bad_record')
  expectErr(await s.mutate('weights.upsert@1', weightArgs({ id: 'd', day: '2026-10-09', ts })), 'bad_record') // day 和 ts 不符
  expectOk(await s.mutate('weights.upsert@1', weightArgs({ id: 'lo', day: '2026-10-01', kg: 30, ts: noonOf('2026-10-01', '08:00') })))
  expectOk(await s.mutate('weights.upsert@1', weightArgs({ id: 'hi', day: '2026-10-02', kg: 250, ts: noonOf('2026-10-02', '08:00') })))
})

test('軟刪除後同一天可以再新增（不算覆寫）', async () => {
  const s = newServer()
  await s.mutate('weights.upsert@1', w('w1', 72.0))
  expectOk(await s.mutate('weights.delete@1', { id: 'w1' }))
  const again = expectOk(await s.mutate('weights.upsert@1', w('w3', 73.1)))
  expect(again).toEqual({ rowId: 'w3', overwritten: false, prevKg: null })
  const rows = live(s, 'weights')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe('w3')
  expect(rows[0]!.kg).toBe(73.1)
})

test('復原時如果那天已經有一筆 → bad_record；沒有就復原成功', async () => {
  const s = newServer()
  await s.mutate('weights.upsert@1', w('w1', 72.0))
  await s.mutate('weights.delete@1', { id: 'w1' })
  await s.mutate('weights.upsert@1', w('w3', 73.1))
  expectErr(await s.mutate('weights.restore@1', { id: 'w1' }), 'bad_record')
  expect(row(s, 'weights', 'w1').deleted_at).not.toBeNull()
  await s.mutate('weights.delete@1', { id: 'w3' })
  expectOk(await s.mutate('weights.restore@1', { id: 'w1' }))
  expect(row(s, 'weights', 'w1').deleted_at).toBeNull()
})

test('delete／restore：找不到 → not_found；已刪除再刪、未刪除就復原 → ignored（不寫入、版本號不變）', async () => {
  const s = newServer()
  expectErr(await s.mutate('weights.delete@1', { id: 'nope' }), 'not_found')
  expectErr(await s.mutate('weights.restore@1', { id: 'nope' }), 'not_found')
  await s.mutate('weights.upsert@1', weightArgs({ id: 'w1', day: TEST_YESTERDAY }))
  const v = s.db.version
  expect(expectOk(await s.mutate('weights.restore@1', { id: 'w1' }))).toEqual({ ignored: 'not_deleted' })
  await s.mutate('weights.delete@1', { id: 'w1' })
  expect(expectOk(await s.mutate('weights.delete@1', { id: 'w1' }))).toEqual({ ignored: 'deleted' })
  expect(s.db.version).toBe(v + 1) // 只有第一次 delete 寫入
})

test('Kyujin 可以 upsert 體重，不能刪除或復原', async () => {
  const s = newServer()
  expectOk(await s.asKyujin('weights.upsert@1', w('w1', 72.4)))
  expectErr(await s.asKyujin('weights.delete@1', { id: 'w1' }), 'forbidden')
  expectErr(await s.asKyujin('weights.restore@1', { id: 'w1' }), 'forbidden')
  expectErr(await s.asKyujin('weights.delete@1', { id: 'nope' }), 'forbidden') // forbidden 先於 not_found
})
