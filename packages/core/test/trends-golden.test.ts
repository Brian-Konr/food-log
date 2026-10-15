import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { weekSummary } from '../src/trends'

// 黃金案例：apps/food-log/test/fixtures/trends-cases.json 的副本。
// 舊 Trends.gs 與 TS 版本對同一份案例的結果相同（legacy/test/gas-trends-parity.test.ts 另外驗證）；
// 這裡確認 core 的 weekSummary 也得到 fixture 的期望值。
const fixture = JSON.parse(readFileSync(new URL('./fixtures/trends-cases.json', import.meta.url), 'utf8'))

for (const c of fixture.cases) {
  test(`golden: ${c.name}`, () => {
    const s = weekSummary(c.logs, fixture.config, fixture.today, c.weekMonday)
    expect(s.avgKcal).toBe(c.expect.avgKcal)
    expect(s.avgDeficit).toBe(c.expect.avgDeficit)
    expect(s.proteinDenom).toBe(c.expect.proteinDenom)
    expect(s.proteinHit).toBe(c.expect.proteinHit)
    expect(s.incompleteDays).toBe(c.expect.incompleteDays)
  })
}

test('v2 列形狀（deleted_at、數字型 config）與 v1 形狀得到相同結果', () => {
  const c = fixture.cases[0]
  const v2Logs = c.logs.map((l: { day: string; kcal: number; protein: number; fat: number; carb: number }) => ({ ...l, deleted_at: null }))
  const cfg = { target_kcal: 2000, target_protein: 150, target_fat: 60, target_carb: 200, tdee: 2650 }
  expect(weekSummary(v2Logs, cfg, fixture.today, c.weekMonday)).toEqual(weekSummary(c.logs, fixture.config, fixture.today, c.weekMonday))
  const withDeleted = [...v2Logs, { day: '2026-10-05', kcal: 5000, protein: 50, fat: 0, carb: 0, deleted_at: '2026-10-06T00:00:00+08:00' }]
  expect(weekSummary(withDeleted, cfg, fixture.today, c.weekMonday).avgKcal).toBe(1980)
})
