import { describe, expect, test } from 'vitest'
import { normName } from '@food-log/core'
import { canonicalTs, sheetNumber, transform } from '../src/transform.ts'
import type { Anomaly } from '../src/types.ts'
import { OWNER, T, sheetItem, sheetLog, sheetStore, sheetWeight, snap } from './helpers.ts'

const run = (parts: Parameters<typeof snap>[0]) => transform(snap(parts), { userId: OWNER })
const codes = (a: Anomaly[], table?: string) => a.filter((x) => !table || x.table === table).map((x) => `${x.table}:${x.kind}:${x.code}`)

describe('canonicalTs', () => {
  test('canonical stays; Z and offsets are converted; no zone = Taipei; date only = Taipei midnight; garbage = null', () => {
    expect(canonicalTs('2026-10-10T12:00:00+08:00')).toBe('2026-10-10T12:00:00+08:00')
    expect(canonicalTs('2026-10-10T04:00:00Z')).toBe('2026-10-10T12:00:00+08:00')
    expect(canonicalTs('2026-10-10T04:00:00.987Z')).toBe('2026-10-10T12:00:00+08:00')
    expect(canonicalTs('2026-10-09T23:30:00-05:00')).toBe('2026-10-10T12:30:00+08:00')
    expect(canonicalTs('2026-10-10T12:00')).toBe('2026-10-10T12:00:00+08:00')
    expect(canonicalTs('2026-10-10 12:00:30')).toBe('2026-10-10T12:00:30+08:00')
    expect(canonicalTs('2026-10-10')).toBe('2026-10-10T00:00:00+08:00')
    expect(canonicalTs('')).toBeNull()
    expect(canonicalTs(null)).toBeNull()
    expect(canonicalTs('yesterday')).toBeNull()
    expect(canonicalTs('2026-13-45T10:00:00+08:00')).toBeNull()
    expect(canonicalTs(1760000000000)).toBeNull()
  })
  test('the result does not depend on the machine time zone (no zone is read as Taipei)', () => {
    const before = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      expect(canonicalTs('2026-10-10T12:00:00')).toBe('2026-10-10T12:00:00+08:00')
      process.env.TZ = 'Asia/Tokyo'
      expect(canonicalTs('2026-10-10T12:00:00')).toBe('2026-10-10T12:00:00+08:00')
    } finally {
      if (before === undefined) delete process.env.TZ
      else process.env.TZ = before
    }
  })
})

test('sheetNumber', () => {
  expect(sheetNumber(3)).toBe(3)
  expect(sheetNumber('3.5')).toBe(3.5)
  expect(sheetNumber(' 7 ')).toBe(7)
  expect(sheetNumber('')).toBeUndefined()
  expect(sheetNumber(null)).toBeUndefined()
  expect(sheetNumber('abc')).toBeUndefined()
  expect(sheetNumber(NaN)).toBeUndefined()
  expect(sheetNumber(Infinity)).toBeUndefined()
})

describe('a clean Sheet transforms without anomalies', () => {
  const r = run({
    stores: [sheetStore({ last_eaten_at: T('2026-10-09') })],
    items: [sheetItem({ fav: true, serving_g: 250 }), sheetItem({ id: 'u:store', store: 's:a', name: 'Store thing' })],
    logs: [sheetLog(), sheetLog({ id: 'l2', item_id: '', qty: 1, grams: '', name: 'Quick', source: 'quick', ts: T('2026-10-10', '15:00') })],
    weights: [sheetWeight()],
    config: { fav_ids: 'fm:1,711:2', remind_meal_times: '08:00,12:30', remind_weight_time: '07:30', tdee: '2300' },
  })
  test('no anomalies', () => expect(r.anomalies).toEqual([]))
  test('keeps the owner id as a parameter; rows carry no user id', () => {
    expect(r.userId).toBe(OWNER)
    expect(JSON.stringify(r.logs)).not.toContain(OWNER)
    expect(() => transform(snap(), { userId: '' })).toThrow(/userId/)
  })
  test("''→NULL, store→store_id, deleted→deleted_at, name_norm, cascade_of NULL", () => {
    expect(r.stores[0]).toMatchObject({ id: 's:a', name: 'Corner Shop', name_norm: normName('Corner Shop'), last_eaten_at: T('2026-10-09'), deleted_at: null, created_by: 'app' })
    const item = r.items.find((i) => i.id === 'u:store')!
    expect(item).toMatchObject({ store_id: 's:a', base_id: null, serving_g: null, cascade_of: null, deleted_at: null })
    expect(r.items.find((i) => i.id === 'u:soy')!.serving_g).toBe(250)
    const quick = r.logs.find((l) => l.id === 'l2')!
    expect(quick).toMatchObject({ item_id: null, grams: null, store_id: null, source: 'quick' })
    expect(r.logs.find((l) => l.id === 'l1')).toMatchObject({ item_id: 'u:soy', grams: null, store_id: null, source: 'app' })
  })
  test('favorites: u: items by items.fav, official ids by fav_ids', () => {
    expect(r.favorites.map((f) => f.item_id)).toEqual(['711:2', 'fm:1', 'u:soy'])
    expect(r.favorites.every((f) => f.deleted_at === null)).toBe(true)
  })
  test('config strings become typed values', () => {
    expect(r.config).toEqual({
      target_kcal: 2000, target_protein: 150, target_fat: 60, target_carb: 200, tdee: 2300,
      remind_meal_times: ['08:00', '12:30'], remind_weight_time: '07:30', deleted_at: null, updated_at: T('2026-10-15', '09:00').replace('12:00', '09:00'),
    })
  })
  test('counts', () => expect(r.counts).toEqual({ stores: { in: 1, out: 1 }, items: { in: 2, out: 2 }, logs: { in: 2, out: 2 }, weights: { in: 1, out: 1 } }))
})

describe('deleted → deleted_at (= updated_at)', () => {
  test('boolean true and the text TRUE; FALSE and false stay live', () => {
    const r = run({
      stores: [sheetStore({ id: 's:d', deleted: true, updated_at: T('2026-10-05', '10:00'), name: 'D' }), sheetStore({ id: 's:e', deleted: 'TRUE', updated_at: T('2026-10-05', '11:00'), name: 'E' }), sheetStore({ id: 's:f', deleted: 'FALSE', name: 'F' })],
      logs: [sheetLog({ deleted: true, updated_at: T('2026-10-11', '09:09') })],
      weights: [sheetWeight({ deleted: true, updated_at: T('2026-10-11', '07:07') })],
      items: [sheetItem({ deleted: true, updated_at: T('2026-10-12', '08:08') })],
    })
    expect(r.stores.find((s) => s.id === 's:d')!.deleted_at).toBe(T('2026-10-05', '10:00'))
    expect(r.stores.find((s) => s.id === 's:e')!.deleted_at).toBe(T('2026-10-05', '11:00'))
    expect(r.stores.find((s) => s.id === 's:f')!.deleted_at).toBeNull()
    expect(r.logs[0]!.deleted_at).toBe(T('2026-10-11', '09:09'))
    expect(r.weights[0]!.deleted_at).toBe(T('2026-10-11', '07:07'))
    expect(r.items[0]!.deleted_at).toBe(T('2026-10-12', '08:08'))
    expect(r.anomalies).toEqual([])
  })
})

describe('timestamps and days', () => {
  test('ts is canonicalised and recorded; Date-like Z strings become Taipei', () => {
    const r = run({ logs: [sheetLog({ ts: '2026-10-10T04:00:00Z', updated_at: '2026-10-10T04:01:00.000Z' })] })
    expect(r.logs[0]).toMatchObject({ ts: T('2026-10-10'), updated_at: T('2026-10-10', '12:01'), day: '2026-10-10' })
    expect(r.anomalies.map((a) => a.code).sort()).toEqual(['ts_canonical', 'updated_at_canonical'])
    expect(r.anomalies.find((a) => a.code === 'ts_canonical')!.changes).toEqual({ ts: { from: '2026-10-10T04:00:00Z', to: T('2026-10-10') } })
  })
  test('day ≠ taipeiDay(ts) is corrected and recorded with before/after (the day of ts wins)', () => {
    const r = run({ logs: [sheetLog({ day: '2026-10-09' })], weights: [sheetWeight({ day: '2026-10-11' })] })
    expect(r.logs[0]!.day).toBe('2026-10-10')
    expect(r.weights[0]!.day).toBe('2026-10-10')
    expect(r.anomalies.filter((a) => a.code === 'day_from_ts').map((a) => [a.table, a.changes!.day])).toEqual([
      ['logs', { from: '2026-10-09', to: '2026-10-10' }],
      ['weights', { from: '2026-10-11', to: '2026-10-10' }],
    ])
  })
  test('late-evening UTC timestamps land on the NEXT Taipei day', () => {
    const r = run({ logs: [sheetLog({ ts: '2026-10-10T17:30:00Z', day: '2026-10-10' })] })
    expect(r.logs[0]).toMatchObject({ ts: '2026-10-11T01:30:00+08:00', day: '2026-10-11' })
    expect(codes(r.anomalies)).toContain('logs:fixed:day_from_ts')
  })
  test('missing ts falls back to noon of day; neither usable drops the row', () => {
    const r = run({ logs: [sheetLog({ ts: '', id: 'a' }), sheetLog({ ts: 'garbage', day: '', id: 'b' })], weights: [sheetWeight({ ts: '' })] })
    expect(r.logs.map((l) => [l.id, l.ts])).toEqual([['a', T('2026-10-10')]])
    expect(r.weights[0]!.ts).toBe(T('2026-10-10'))
    expect(r.anomalies.find((a) => a.id === 'b')).toMatchObject({ kind: 'dropped', code: 'unusable_time' })
    expect(r.counts.logs).toEqual({ in: 2, out: 1 })
  })
  test('stores and items: ts / updated_at filled when missing', () => {
    const r = run({ stores: [sheetStore({ ts: '', updated_at: '' })], items: [sheetItem({ updated_at: '' })] })
    expect(r.stores[0]!.updated_at).toBe('2026-10-15T09:00:00+08:00')
    expect(r.stores[0]!.ts).toBe('2026-10-15T09:00:00+08:00')
    expect(r.items[0]!.updated_at).toBe(T('2026-10-01'))
    expect(codes(r.anomalies, 'stores')).toEqual(['stores:fixed:updated_at_filled', 'stores:fixed:ts_filled'])
  })
})

describe('weights', () => {
  test('missing id → w:<day> (recorded)', () => {
    const r = run({ weights: [sheetWeight({ id: '' }), sheetWeight({ id: undefined, day: '2026-10-11', ts: T('2026-10-11', '07:00') })] })
    expect(r.weights.map((w) => w.id)).toEqual(['w:2026-10-10', 'w:2026-10-11'])
    expect(r.anomalies.filter((a) => a.code === 'weight_id_assigned')).toHaveLength(2)
    expect(r.anomalies[0]!.changes!.id).toEqual({ from: '', to: 'w:2026-10-10' })
  })
  test('several live weights on one day: the newest (ts) stays live, the others are marked deleted at their updated_at', () => {
    const r = run({
      weights: [
        sheetWeight({ id: 'a', ts: T('2026-10-10', '07:00'), updated_at: T('2026-10-10', '07:01'), kg: 70 }),
        sheetWeight({ id: 'b', ts: T('2026-10-10', '21:00'), updated_at: T('2026-10-10', '21:01'), kg: 71 }),
        sheetWeight({ id: 'c', ts: T('2026-10-10', '12:00'), updated_at: T('2026-10-10', '12:01'), kg: 72 }),
        sheetWeight({ id: 'd', day: '2026-10-11', ts: T('2026-10-11', '07:00'), kg: 69 }),
      ],
    })
    const live = r.weights.filter((w) => w.deleted_at === null)
    expect(live.map((w) => [w.day, w.id, w.kg])).toEqual([['2026-10-10', 'b', 71], ['2026-10-11', 'd', 69]])
    expect(r.weights.find((w) => w.id === 'a')!.deleted_at).toBe(T('2026-10-10', '07:01'))
    expect(r.weights.find((w) => w.id === 'c')!.deleted_at).toBe(T('2026-10-10', '12:01'))
    expect(r.anomalies.filter((a) => a.code === 'weight_superseded').map((a) => [a.id, a.changes!.deleted])).toEqual([
      ['a', { from: false, to: true }],
      ['c', { from: false, to: true }],
    ])
  })
  test('an already deleted duplicate is not an anomaly; ties on ts are broken by updated_at then position', () => {
    const r = run({
      weights: [
        sheetWeight({ id: 'a', deleted: true }),
        sheetWeight({ id: 'b', kg: 70, updated_at: T('2026-10-10', '08:00') }),
        sheetWeight({ id: 'c', kg: 71, updated_at: T('2026-10-10', '09:00') }),
      ],
    })
    expect(r.weights.filter((w) => !w.deleted_at).map((w) => w.id)).toEqual(['c'])
    expect(r.anomalies.map((a) => a.id)).toEqual(['b'])
  })
  test('kg: text numbers, extra decimals rounded, out of range dropped', () => {
    const r = run({ weights: [sheetWeight({ id: 'a', kg: '70.4' }), sheetWeight({ id: 'b', day: '2026-10-11', ts: T('2026-10-11'), kg: 70.46 }), sheetWeight({ id: 'c', day: '2026-10-12', ts: T('2026-10-12'), kg: 20 }), sheetWeight({ id: 'd', day: '2026-10-13', ts: T('2026-10-13'), kg: 'x' })] })
    expect(r.weights.map((w) => [w.id, w.kg])).toEqual([['a', 70.4], ['b', 70.5]])
    expect(codes(r.anomalies)).toEqual(['weights:fixed:number_from_string', 'weights:fixed:kg_rounded', 'weights:dropped:kg_out_of_range', 'weights:dropped:kg_invalid'])
  })
  test('the same id twice: the newest updated_at is kept', () => {
    const r = run({ weights: [sheetWeight({ kg: 70, updated_at: T('2026-10-10', '08:00') }), sheetWeight({ kg: 71, updated_at: T('2026-10-10', '09:00') })] })
    expect(r.weights).toHaveLength(1)
    expect(r.weights[0]!.kg).toBe(71)
    expect(r.anomalies).toHaveLength(1)
    expect(r.anomalies[0]).toMatchObject({ kind: 'dropped', code: 'duplicate_id', index: 0 })
  })
})

describe('stores', () => {
  test('name_norm uses core normName (NFKC, case, punctuation, spaces)', () => {
    const r = run({ stores: [sheetStore({ id: 's:x', name: 'Ｃafe  ·Mocha（本店）' })] })
    expect(r.stores[0]!.name_norm).toBe(normName('Ｃafe  ·Mocha（本店）'))
    expect(r.stores[0]!.name_norm).toBe('cafemocha本店')
  })
  test('two live stores with the same normalised name: the oldest survives, the other is deleted and its items / logs follow', () => {
    const r = run({
      stores: [sheetStore({ id: 's:b', name: 'Cafe Mocha', ts: T('2026-10-03') }), sheetStore({ id: 's:a', name: 'cafe-mocha', ts: T('2026-10-01') })],
      items: [sheetItem({ id: 'u:1', store: 's:b' })],
      logs: [sheetLog({ store: 's:b' })],
    })
    expect(r.stores.filter((s) => s.deleted_at === null).map((s) => s.id)).toEqual(['s:a'])
    expect(r.items[0]!.store_id).toBe('s:a')
    expect(r.logs[0]!.store_id).toBe('s:a')
    expect(codes(r.anomalies).sort()).toEqual(['items:fixed:store_merged', 'logs:fixed:store_merged', 'stores:fixed:store_duplicate_name'])
  })
  test('a deleted store with the same name is not a duplicate', () => {
    const r = run({ stores: [sheetStore({ id: 's:a', name: 'Cafe' }), sheetStore({ id: 's:b', name: 'cafe', deleted: true })] })
    expect(r.anomalies).toEqual([])
  })
  test('dropped: no id, wrong prefix, blank name; created_by repaired; bad last_eaten_at cleared', () => {
    const r = run({
      stores: [sheetStore({ id: '' }), sheetStore({ id: 'x:1' }), sheetStore({ id: 's:blank', name: '  ' }), sheetStore({ id: 's:ok', name: 'Ok', created_by: 'robot', last_eaten_at: 'soon' })],
    })
    expect(r.stores.map((s) => s.id)).toEqual(['s:ok'])
    expect(r.stores[0]).toMatchObject({ created_by: 'app', last_eaten_at: null })
    expect(codes(r.anomalies)).toEqual(['stores:dropped:no_id', 'stores:dropped:bad_id_prefix', 'stores:dropped:blank_name', 'stores:fixed:last_eaten_invalid', 'stores:fixed:created_by_invalid'])
  })
})

describe('items', () => {
  test('ov: items get kind 補填 and base_id from the id; u: items get 自建 and no base_id', () => {
    const r = run({ items: [sheetItem({ id: 'ov:fm:100', kind: '自建', base_id: '' }), sheetItem({ id: 'u:a', kind: '補填', base_id: 'fm:1' })] })
    expect(r.items.find((i) => i.id === 'ov:fm:100')).toMatchObject({ kind: '補填', base_id: 'fm:100' })
    expect(r.items.find((i) => i.id === 'u:a')).toMatchObject({ kind: '自建', base_id: null })
    expect(codes(r.anomalies)).toEqual(['items:fixed:kind_fixed', 'items:fixed:base_id_fixed', 'items:fixed:kind_fixed', 'items:fixed:base_id_fixed'])
  })
  test('official ids and unknown prefixes are dropped (D1 would reject them)', () => {
    const r = run({ items: [sheetItem({ id: 'fm:1' }), sheetItem({ id: '711:9' }), sheetItem({ id: 'zz:1' }), sheetItem({ id: 'u:' }), sheetItem({ id: '' })] })
    expect(r.items).toEqual([])
    expect(codes(r.anomalies)).toEqual(['items:dropped:official_id', 'items:dropped:official_id', 'items:dropped:bad_id_prefix', 'items:dropped:bad_id_prefix', 'items:dropped:no_id'])
  })
  test('a store item always has src 其他; src outside the three values becomes 其他', () => {
    const r = run({ items: [sheetItem({ id: 'u:a', store: 's:a', src: '全家' }), sheetItem({ id: 'u:b', src: 'costco' })], stores: [sheetStore()] })
    expect(r.items.map((i) => i.src)).toEqual(['其他', '其他'])
    expect(codes(r.anomalies).sort()).toEqual(['items:fixed:src_invalid', 'items:fixed:store_item_src'])
  })
  test('blank name / serving, bad serving_g, bad nutrition are repaired and recorded', () => {
    const r = run({ items: [sheetItem({ name: '', serving: '', serving_g: -5, kcal: 'abc', protein: -1, fat: '3.5' })] })
    expect(r.items[0]).toMatchObject({ name: '(未命名)', serving: '1 份', serving_g: null, kcal: 0, protein: 0, fat: 3.5 })
    expect(r.anomalies.map((a) => a.code).sort()).toEqual(['name_filled', 'number_from_string', 'nutrition_invalid', 'serving_filled', 'serving_g_invalid'])
    expect(r.anomalies.find((a) => a.code === 'nutrition_invalid')!.changes).toEqual({ kcal: { from: 'abc', to: 0 }, protein: { from: -1, to: 0 } })
  })
  test('a store that is not in the Stores sheet is noted, not changed', () => {
    const r = run({ items: [sheetItem({ store: 's:ghost' })] })
    expect(r.items[0]!.store_id).toBe('s:ghost')
    expect(r.anomalies).toEqual([expect.objectContaining({ kind: 'note', code: 'dangling_store_ref' })])
  })
  test('the same id twice keeps the newest', () => {
    const r = run({ items: [sheetItem({ name: 'old', updated_at: T('2026-10-01', '08:00') }), sheetItem({ name: 'new', updated_at: T('2026-10-02', '08:00') })] })
    expect(r.items.map((i) => i.name)).toEqual(['new'])
  })
})

describe('favorites', () => {
  test('u: items with fav=true (also deleted ones: a restore keeps the star); fav=false and ov: items do not make rows', () => {
    const r = run({
      items: [sheetItem({ id: 'u:a', fav: true }), sheetItem({ id: 'u:b', fav: false }), sheetItem({ id: 'u:c', fav: true, deleted: true }), sheetItem({ id: 'ov:fm:1', kind: '補填', base_id: 'fm:1', fav: true })],
      config: { fav_ids: ' fm:1 , 711:2,,fm:1' },
    })
    expect(r.favorites.map((f) => f.item_id)).toEqual(['711:2', 'fm:1', 'u:a', 'u:c'])
  })
  test('fav_ids entries that the v1 App ignores (custom ids) are noted, and a dropped item has no favourite', () => {
    const r = run({ items: [sheetItem({ id: 'fm:9', fav: true })], config: { fav_ids: 'u:soy,fm:5' } })
    expect(r.favorites.map((f) => f.item_id)).toEqual(['fm:5'])
    expect(r.anomalies.some((a) => a.code === 'fav_id_ignored')).toBe(true)
  })
  test('updated_at of an items.fav row is the item updated_at; of a fav_ids row the server time', () => {
    const r = run({ items: [sheetItem({ fav: true, updated_at: T('2026-10-02', '08:00') })], config: { fav_ids: 'fm:5' } })
    expect(r.favorites.find((f) => f.item_id === 'u:soy')!.updated_at).toBe(T('2026-10-02', '08:00'))
    expect(r.favorites.find((f) => f.item_id === 'fm:5')!.updated_at).toBe('2026-10-15T09:00:00+08:00')
  })
})

describe('logs', () => {
  test('source: quick / kyujin kept, blank or unknown → app', () => {
    const r = run({ logs: [sheetLog({ id: 'a', source: 'kyujin' }), sheetLog({ id: 'b', source: '' }), sheetLog({ id: 'c', source: 'weird' }), sheetLog({ id: 'd', source: undefined })] })
    expect(r.logs.map((l) => [l.id, l.source])).toEqual([['a', 'kyujin'], ['b', 'app'], ['c', 'app'], ['d', 'app']])
    expect(codes(r.anomalies)).toEqual(['logs:fixed:source_invalid'])
  })
  test('quick-log shape is enforced (D1 CHECK): qty 1, no grams, src 其他, no store; recorded', () => {
    const r = run({ logs: [sheetLog({ item_id: '', qty: 2, grams: 50, src: '全家', store: 's:a' })] })
    expect(r.logs[0]).toMatchObject({ item_id: null, qty: 1, grams: null, src: '其他', store_id: null })
    expect(Object.keys(r.anomalies[0]!.changes!).sort()).toEqual(['grams', 'qty', 'src', 'store_id'])
  })
  test('qty 0 / text qty / bad grams / negative nutrition', () => {
    const r = run({ logs: [sheetLog({ id: 'a', qty: 0 }), sheetLog({ id: 'b', qty: '2' }), sheetLog({ id: 'c', grams: 0 }), sheetLog({ id: 'd', kcal: -3 })] })
    expect(r.logs.map((l) => [l.id, l.qty, l.grams, l.kcal])).toEqual([['a', 1, null, 100], ['b', 2, null, 100], ['c', 1, null, 100], ['d', 1, null, 0]])
    expect(codes(r.anomalies)).toEqual(['logs:fixed:qty_invalid', 'logs:fixed:number_from_string', 'logs:fixed:grams_invalid', 'logs:fixed:nutrition_invalid'])
  })
  test('grams numbers kept; the sort is by day, ts, id', () => {
    const r = run({ logs: [sheetLog({ id: 'z', grams: 120.5 }), sheetLog({ id: 'a', day: '2026-10-09', ts: T('2026-10-09') }), sheetLog({ id: 'b', ts: T('2026-10-10', '08:00') })] })
    expect(r.logs.map((l) => l.id)).toEqual(['a', 'b', 'z'])
    expect(r.logs[2]!.grams).toBe(120.5)
  })
  test('names are kept as they are, including quotes, newlines and unicode', () => {
    const r = run({ logs: [sheetLog({ name: "It's \"a\"\nline ☕ 雞胸" })] })
    expect(r.logs[0]!.name).toBe("It's \"a\"\nline ☕ 雞胸")
  })
})

describe('config', () => {
  test('defaults when the Config sheet is empty, and string forms become typed fields', () => {
    const r = run({ config: { target_kcal: '', target_protein: '', target_fat: '', target_carb: '' } })
    expect(r.config).toMatchObject({ target_kcal: 2000, target_protein: 150, target_fat: 60, target_carb: 200, tdee: null, remind_meal_times: [], remind_weight_time: null })
  })
  test('target_protein may have decimals; unreadable values fall back to the default and are recorded', () => {
    const r = run({ config: { target_kcal: '18x', target_protein: '120.5', target_fat: '-4', target_carb: 'a', tdee: '22.5', remind_meal_times: '08:00, 25:00 ,12:30,noon', remind_weight_time: '7:5' } })
    expect(r.config).toMatchObject({ target_kcal: 2000, target_protein: 120.5, target_fat: 60, target_carb: 200, tdee: null, remind_meal_times: ['08:00', '12:30'], remind_weight_time: null })
    expect(Object.keys(r.anomalies[0]!.changes!).sort()).toEqual(['remind_meal_times', 'remind_weight_time', 'target_carb', 'target_fat', 'target_kcal', 'tdee'])
  })
  test('a time the Sheet had turned into a date (v1 read returns 1899-12-30T..) is recovered and recorded', () => {
    const r = run({ config: { remind_weight_time: '1899-12-30T07:30:00+08:00', remind_meal_times: '08:00,1899-12-30T12:30:00+08:00' } })
    expect(r.config).toMatchObject({ remind_weight_time: '07:30', remind_meal_times: ['08:00', '12:30'] })
    expect(r.anomalies).toHaveLength(1)
    expect(r.anomalies[0]).toMatchObject({ code: 'config_time_from_date' })
    expect(Object.keys(r.anomalies[0]!.changes!).sort()).toEqual(['remind_meal_times', 'remind_weight_time'])
  })
  test('schema_version and unknown keys are ignored', () => {
    const r = run({ config: { schema_version: '2', something: 'x' } })
    expect(r.anomalies).toEqual([])
    expect(Object.keys(r.config)).not.toContain('schema_version')
  })
})

test('deterministic: the same snapshot gives the same result, whatever order the rows are in', () => {
  const rows = { logs: [sheetLog({ id: 'a' }), sheetLog({ id: 'b', ts: T('2026-10-09'), day: '2026-10-09' }), sheetLog({ id: 'c', ts: T('2026-10-11'), day: '2026-10-11' })], stores: [sheetStore({ id: 's:b', name: 'B' }), sheetStore({ id: 's:a', name: 'A' })] }
  const a = run(rows)
  const b = run({ logs: [...rows.logs].reverse(), stores: [...rows.stores].reverse() })
  expect(b.logs).toEqual(a.logs)
  expect(b.stores).toEqual(a.stores)
})

test('does not mutate its input', () => {
  const s = snap({ logs: [sheetLog({ day: '2026-10-09', kcal: '5' })], weights: [sheetWeight({ id: '' })] })
  const copy = structuredClone(s)
  transform(s, { userId: OWNER })
  expect(s).toEqual(copy)
})
