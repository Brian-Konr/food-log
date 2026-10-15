import { describe, expect, test } from 'vitest'
import { emitSql } from '../src/emit-sql.ts'
import { transform } from '../src/transform.ts'
import { formatReport, verifySnapshot } from '../src/verify.ts'
import type { D1Dump } from '../src/types.ts'
import { OWNER, T, d1Sqlite, dumpOf, seedFakeGas, sheetItem, sheetLog, sheetStore, sheetWeight, snap } from './helpers.ts'
import { fetchSheet } from '../src/fetch-sheet.ts'

function load(s: ReturnType<typeof snap>): D1Dump {
  const db = d1Sqlite()
  for (const f of emitSql(transform(s, { userId: OWNER }))) db.exec(f.sql)
  return dumpOf(db)
}

const base = () =>
  snap({
    stores: [sheetStore(), sheetStore({ id: 's:gone', name: 'Gone', deleted: true })],
    items: [sheetItem({ fav: true }), sheetItem({ id: 'u:b', name: 'B', deleted: true })],
    logs: [
      sheetLog({ id: 'a', kcal: 100.5, protein: 10.25 }),
      sheetLog({ id: 'b', kcal: 200, ts: T('2026-10-10', '19:00') }),
      sheetLog({ id: 'c', kcal: 50, day: '2026-10-11', ts: T('2026-10-11') }),
      sheetLog({ id: 'd', kcal: 999, deleted: true }),
    ],
    weights: [sheetWeight({ id: 'w1', kg: 70.5 }), sheetWeight({ id: 'w2', day: '2026-10-11', ts: T('2026-10-11', '07:00'), kg: 70.1 })],
    config: { target_kcal: '1900', tdee: '2300', remind_meal_times: '08:00,18:00', remind_weight_time: '07:30', fav_ids: 'fm:1,711:2' },
  })

describe('verify', () => {
  test('a faithful import verifies OK', () => {
    const s = base()
    const rep = verifySnapshot(s, load(s), { userId: OWNER })
    expect(rep.ok, formatReport(rep)).toBe(true)
    expect(rep.checks.some((c) => c.name.startsWith('config: remind_meal_times'))).toBe(true)
    expect(formatReport(rep)).toContain('VERIFY OK')
  })

  test('each kind of damage in D1 is detected', () => {
    const s = base()
    const damage: [string, (d: D1Dump) => void, RegExp][] = [
      ['a missing log', (d) => void d.tables.logs.splice(0, 1), /logs: (live rows|ids)/],
      ['an extra log', (d) => void d.tables.logs.push({ ...d.tables.logs[0]!, id: 'extra' }), /logs: (live rows|ids)/],
      ['a changed kcal', (d) => void (d.tables.logs[0]!.kcal = 101), /per-day/],
      ['a log moved to another day', (d) => void (d.tables.logs[0]!.day = '2026-10-12'), /per-day/],
      ['a deleted log resurrected', (d) => void (d.tables.logs.find((l) => l.id === 'd')!.deleted_at = null), /logs: (live|deleted) rows/],
      ['a live log deleted', (d) => void (d.tables.logs[0]!.deleted_at = 'x'), /logs: (live|deleted) rows/],
      ['a changed kg', (d) => void (d.tables.weights[0]!.kg = 71), /weights: kg per day/],
      ['a missing weight', (d) => void d.tables.weights.pop(), /weights: /],
      ['a changed config value', (d) => void (d.tables.config[0]!.target_kcal = 1800), /config: target_kcal/],
      ['changed reminder times', (d) => void (d.tables.config[0]!.remind_meal_times = ['08:00']), /config: remind_meal_times/],
      ['a lost favourite', (d) => void d.tables.favorites.pop(), /favorites/],
      ['an extra favourite', (d) => void d.tables.favorites.push({ ...d.tables.favorites[0]!, item_id: 'fm:77' }), /favorites/],
      ['a missing store', (d) => void d.tables.stores.pop(), /stores: /],
      ['a missing item', (d) => void d.tables.items.pop(), /items: /],
      ['a missing config row', (d) => void (d.tables.config.length = 0), /config: row/],
    ]
    for (const [label, hurt, expected] of damage) {
      const dump = load(s)
      hurt(dump)
      const rep = verifySnapshot(s, dump, { userId: OWNER })
      expect(rep.ok, label).toBe(false)
      expect(rep.checks.filter((c) => !c.ok).map((c) => c.name).join('\n'), label).toMatch(expected)
      expect(formatReport(rep), label).toContain('VERIFY FAILED')
    }
  })

  test('anomalies are subtracted: dropped rows, fixed days, superseded weights and rounded kg are expected, not failures', () => {
    const s = snap({
      logs: [
        sheetLog({ id: 'fixday', day: '2026-10-09', kcal: 120 }), // day wrong in the Sheet
        sheetLog({ id: 'text', kcal: '80', protein: 'x' }), // text number, unreadable protein
        sheetLog({ id: 'nodate', ts: '', day: '' }), // dropped
        sheetLog({ id: 'dupid', kcal: 1, updated_at: T('2026-10-10', '08:00') }),
        sheetLog({ id: 'dupid', kcal: 2, updated_at: T('2026-10-10', '09:00') }),
      ],
      weights: [
        sheetWeight({ id: '', kg: 70.4 }),
        sheetWeight({ id: 'late', ts: T('2026-10-10', '22:00'), kg: 71.36 }),
        sheetWeight({ id: 'bad', day: '2026-10-12', ts: T('2026-10-12'), kg: 5 }),
      ],
      stores: [sheetStore({ id: 's:1', name: 'Same' }), sheetStore({ id: 's:2', name: 'same', ts: T('2026-10-05') })],
    })
    const rep = verifySnapshot(s, load(s), { userId: OWNER })
    expect(rep.ok, formatReport(rep)).toBe(true)
    expect(Object.keys(rep.anomalies).length).toBeGreaterThan(4)
  })

  test('a silent transform bug (no anomaly recorded) would still be caught: the expectation comes from the raw Sheet', () => {
    const s = base()
    const dump = load(s)
    // simulate "transform changed kcal of log a without recording it": D1 differs from the raw Sheet and no anomaly explains it
    dump.tables.logs.find((l) => l.id === 'a')!.kcal = 55
    expect(verifySnapshot(s, dump, { userId: OWNER }).ok).toBe(false)
  })

  test('rows of another user in the dump are ignored but counted', () => {
    const s = base()
    const dump = load(s)
    dump.tables.logs.push({ ...dump.tables.logs[0]!, id: 'theirs', user_id: 'someone-else' })
    const rep = verifySnapshot(s, dump, { userId: OWNER })
    expect(rep.ok).toBe(true)
    expect(rep.otherUsersRows).toBe(1)
  })

  test('a realistic Sheet with quirks (fake Apps Script) round-trips through fetch → transform → D1 SQL → verify', async () => {
    const g = seedFakeGas()
    const s = await fetchSheet(g.client)
    const rep = verifySnapshot(s, load(s), { userId: OWNER })
    expect(rep.ok, formatReport(rep)).toBe(true)
    // the quirks were seen and accounted for
    const codes = Object.keys(rep.anomalies).join(' ')
    expect(codes).toContain('weight_id_assigned')
    expect(codes).toContain('weight_superseded')
    expect(codes).toContain('day_from_ts')
    expect(codes).toContain('number_from_string')
  })
})
