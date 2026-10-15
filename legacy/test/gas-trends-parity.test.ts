import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadGas } from './gas-fakes'
import { weekSummary, weightSeries } from '@/lib/trends'
import { formatKg } from '@/lib/format'

const fixture = JSON.parse(readFileSync(new URL('../../apps/food-log/test/fixtures/trends-cases.json', import.meta.url), 'utf8'))

test('TS 與 Trends.gs 同一份案例一致', () => {
  const { g } = loadGas()
  const today = fixture.today
  const config = fixture.config
  for (const c of fixture.cases) {
    const ts = weekSummary(c.logs, config, today, c.weekMonday)
    const gs = g.weekSummary_(c.logs, config, today, c.weekMonday)
    expect(gs.avgKcal, c.name).toBe(ts.avgKcal)
    expect(gs.avgDeficit, c.name).toBe(ts.avgDeficit)
    expect(gs.proteinHit, c.name).toBe(ts.proteinHit)
    expect(gs.proteinDenom, c.name).toBe(ts.proteinDenom)
    expect(gs.incompleteDays, c.name).toBe(ts.incompleteDays)
    expect(ts.avgKcal).toBe(c.expect.avgKcal)
    expect(ts.avgDeficit).toBe(c.expect.avgDeficit)
  }
})

test('體重序列公斤絕對誤差 < 1e-6，顯示到一位小數相同', () => {
  const { g } = loadGas()
  const today = '2026-10-10'
  const config = fixture.config
  const logs: unknown[] = []
  const weights = [
    { day: '2026-09-12', kg: 74, deleted: false, updated_at: '2026-09-12T08:00:00+08:00' },
    { day: '2026-09-13', kg: 74, deleted: false, updated_at: '2026-09-13T08:00:00+08:00' },
    { day: '2026-09-14', kg: 74, deleted: false, updated_at: '2026-09-14T08:00:00+08:00' },
  ]
  const ts = weightSeries(logs as never, weights as never, config, today)
  const gs = g.weightSeries_(logs, weights, config, today)
  expect(gs.expected.length).toBe(ts.expected.length)
  for (let i = 0; i < ts.expected.length; i++) {
    expect(Math.abs(gs.expected[i].kg - ts.expected[i].kg)).toBeLessThan(1e-6)
    expect(formatKg(gs.expected[i].kg)).toBe(formatKg(ts.expected[i].kg))
  }
})

test('spanDays = 90 時 TS 與 Trends.gs 預期線一致', () => {
  const { g } = loadGas()
  const today = '2026-10-10'
  const config = fixture.config
  const logs: unknown[] = []
  const weights = [
    { day: '2026-07-14', kg: 74, deleted: false, updated_at: '2026-07-14T08:00:00+08:00' },
    { day: '2026-07-15', kg: 74, deleted: false, updated_at: '2026-07-15T08:00:00+08:00' },
    { day: '2026-07-16', kg: 74, deleted: false, updated_at: '2026-07-16T08:00:00+08:00' },
  ]
  const ts = weightSeries(logs as never, weights as never, config, today, 90)
  const gs = g.weightSeries_(logs, weights, config, today, 90)
  expect(gs.expected.length).toBe(ts.expected.length)
  expect(gs.startDay).toBe(ts.startDay)
  for (let i = 0; i < ts.expected.length; i++) {
    expect(Math.abs(gs.expected[i].kg - ts.expected[i].kg)).toBeLessThan(1e-6)
    expect(formatKg(gs.expected[i].kg)).toBe(formatKg(ts.expected[i].kg))
  }
})
