// 由 legacy/test/gas-validate.test.ts 搬來（案例相同，改成呼叫 core 的 logs.add@1）。
import { expect, test } from 'vitest'
import { logArgs, noonOf, quickLogArgs, TEST_TODAY, TEST_YESTERDAY } from '../src/testing'
import { expectErr, expectOk, live, newServer } from './helpers'

test('缺任一營養素、負數、字串數字 → bad_record；0 可以', async () => {
  const s = newServer()
  const add = (over: object) => s.mutate('logs.add@1', { log: logArgs(over) })
  expectErr(await add({ id: 'a', protein: null }), 'bad_record')
  expectErr(await add({ id: 'b', fat: -1 }), 'bad_record')
  expectErr(await add({ id: 'c', carb: '2.3' }), 'bad_record')
  expectOk(await add({ id: 'd', protein: 0, fat: 0, carb: 0 }))
})

test('day 和 ts 不符 → bad_record', async () => {
  const s = newServer()
  expectErr(await s.mutate('logs.add@1', { log: logArgs({ day: '2026-10-09' }) }), 'bad_record')
})

test('ts 不是台北時間格式 → bad_record（D1 的 CHECK 也會擋，這裡先擋）', async () => {
  const s = newServer()
  expectErr(await s.mutate('logs.add@1', { log: logArgs({ ts: '2026-10-11T04:00:00Z' }) }), 'bad_record')
  expectErr(await s.mutate('logs.add@1', { log: logArgs({ ts: 'garbage' }) }), 'bad_record')
})

test('不能記未來的日期；今天可以', async () => {
  const s = newServer()
  const future = '2026-10-13'
  expectErr(await s.mutate('logs.add@1', { log: logArgs({ day: future, ts: noonOf(future) }) }), 'bad_record')
  expectOk(await s.mutate('logs.add@1', { log: logArgs({ id: 'today', day: TEST_TODAY, ts: noonOf(TEST_TODAY, '11:00') }) }))
})

test('重複 log id 成功且只有一列', async () => {
  const s = newServer()
  expectOk(await s.mutate('logs.add@1', { log: logArgs({ id: 'log-1' }) }))
  const again = expectOk(await s.mutate('logs.add@1', { log: logArgs({ id: 'log-1' }) }))
  expect(again).toEqual({ duplicate: true })
  expect(live(s, 'logs').filter((r) => r.id === 'log-1')).toHaveLength(1)
})

test('快速記錄缺營養素拒收；qty 不是 1 拒收；四項為 0 可以', async () => {
  const s = newServer()
  expectErr(await s.mutate('logs.add@1', { log: quickLogArgs({ protein: null }) }), 'bad_record')
  expectErr(await s.mutate('logs.add@1', { log: quickLogArgs({ id: 'q2', qty: 2 }) }), 'bad_record')
  expectOk(await s.mutate('logs.add@1', { log: quickLogArgs({ id: 'q3', kcal: 0, protein: 0, fat: 0, carb: 0 }) }))
})

test('快速記錄：有 grams、src 不是其他、帶店家都拒收', async () => {
  const s = newServer()
  expectErr(await s.mutate('logs.add@1', { log: quickLogArgs({ id: 'g', grams: 100 }) }), 'bad_record')
  expectErr(await s.mutate('logs.add@1', { log: quickLogArgs({ id: 'f', src: '全家' }) }), 'bad_record')
  expectErr(await s.mutate('logs.add@1', { log: quickLogArgs({ id: 's', store_id: 's:nope' }) }), 'bad_record')
})

test('一般記錄：qty ≤ 0、grams ≤ 0、缺名稱、不認得的 source、店家不存在 → bad_record', async () => {
  const s = newServer()
  const add = (over: object) => s.mutate('logs.add@1', { log: logArgs(over) })
  expectErr(await add({ id: 'a', qty: 0 }), 'bad_record')
  expectErr(await add({ id: 'b', grams: 0 }), 'bad_record')
  expectErr(await add({ id: 'c', name: '  ' }), 'bad_record')
  expectErr(await add({ id: 'd', source: 'weird' }), 'bad_record')
  expectErr(await add({ id: 'e', source: 'kyujin' }), 'bad_record') // owner 不能寫 kyujin
  expectErr(await add({ id: 'f', store_id: 's:nope' }), 'bad_record')
  expectOk(await add({ id: 'g', grams: 150, qty: 1.5, source: 'app' }))
})

test('缺必填欄位（zod 形狀錯誤）→ bad_record，不是例外', async () => {
  const s = newServer()
  expectErr(await s.mutateRaw('logs.add@1', { log: { id: 'x' } }), 'bad_record')
  expectErr(await s.mutateRaw('logs.add@1', {}), 'bad_record')
  expectErr(await s.mutateRaw('logs.add@1', null), 'bad_record')
})

test('同一天的 yesterday 常數正確（測試時鐘是 2026-10-12）', () => {
  expect(TEST_YESTERDAY).toBe('2026-10-11')
})
