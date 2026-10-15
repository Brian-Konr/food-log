// The whole migration loop on synthetic data (plan 4 stage 3 step 2, "來回測試"):
//   fake Apps Script (legacy/test/gas-fakes.ts, with Sheet quirks) → fetch-sheet → transform → load into core's MemoryServer
//   (same chunks / versions as emit-sql) → verify → mutate like the new app and Kyujin would → reverse-export → apply to the SAME
//   fake Apps Script → its `read` / `history` match what D1 says → run it again: nothing left to do.
import { beforeAll, describe, expect, test } from 'vitest'
import { MemoryServer } from '@food-log/core/testing'
import type { LogsAddArgs, PushResult } from '@food-log/core'
import { fetchSheet } from '../src/fetch-sheet.ts'
import { loadIntoMemory, memoryDump } from '../src/memory-load.ts'
import { applyPlan, buildPlan, formatPlan } from '../src/reverse-export.ts'
import type { Plan } from '../src/reverse-export.ts'
import { transform } from '../src/transform.ts'
import type { D1Dump, DumpRow, SheetRecord, SheetSnapshot } from '../src/types.ts'
import { formatReport, verifySnapshot } from '../src/verify.ts'
import { OWNER, T, dayBack, seedFakeGas, today } from './helpers.ts'

const ok = (r: PushResult): PushResult => {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
  return r
}

type World = Awaited<ReturnType<typeof build>>

async function build() {
  const g = seedFakeGas()
  const sheet0 = await fetchSheet(g.client)
  const result = transform(sheet0, { userId: OWNER })
  const server = new MemoryServer({ userId: OWNER })
  server.now = () => Date.now()
  const vCut = loadIntoMemory(server, result)
  return { g, sheet0, result, server, vCut }
}

/** What the new app, Brian's second device and Kyujin do after the cut-over. */
async function mutate(server: MemoryServer): Promise<void> {
  const d0 = today()
  const now = T(d0, '00:30')
  const log = (id: string, over: Record<string, unknown> = {}): LogsAddArgs['log'] => ({
    id, ts: now, day: d0, item_id: 'u:soy', name: 'Soy milk', src: '其他', qty: 1, kcal: 111, protein: 8, fat: 4, carb: 6, ...over,
  } as LogsAddArgs['log'])
  // stores and items
  ok(await server.mutate('stores.upsert@1', { id: 's:new', name: 'New Cafe', ts: now }))
  ok(await server.mutate('stores.upsert@1', { id: 's:bbb', name: 'Cafe Latte', ts: T(dayBack(50)) })) // rename
  ok(await server.asKyujin('stores.upsert@1', { id: 's:kyu', name: 'Kyujin Kitchen', ts: now }))
  ok(await server.mutate('items.upsert@1', { id: 'u:new2', kind: '自建', src: '其他', name: 'New thing', serving: '2 pcs', serving_g: 90, kcal: 210, protein: 7, fat: 9, carb: 22, store_id: 's:new', ts: now }))
  ok(await server.mutate('items.upsert@1', { id: 'u:bagel', kind: '自建', src: '全家', name: 'Bagel XL', serving: '1 份', kcal: 300, protein: 11, fat: 3, carb: 60, ts: T(dayBack(30)) }))
  ok(await server.asKyujin('items.upsert@1', { id: 'u:kyu2', kind: '自建', src: '其他', name: 'Kyujin soup', serving: '1 bowl', kcal: 150, protein: 9, fat: 6, carb: 14, ts: now }))
  ok(await server.mutate('items.delete@1', { id: 'ov:fm:100' }))
  ok(await server.mutate('stores.delete@1', { id: 's:aaa' })) // cascades u:salad
  // logs
  ok(await server.mutate('logs.add@1', { log: log('n-1') }))
  ok(await server.mutate('logs.add@1', { log: log('n-2', { item_id: 'u:new2', name: 'New thing', qty: 2, grams: 180.5, store_id: 's:new' }) }))
  ok(await server.mutate('logs.add@1', { log: log('n-quick', { item_id: null, name: 'Mystery bar', kcal: 222, source: 'quick' }) }))
  ok(await server.mutate('logs.add@1', { log: log('n-gone', { kcal: 5 }) }))
  ok(await server.mutate('logs.delete@1', { id: 'n-gone' })) // created and deleted after the cut-over
  ok(await server.asKyujin('logs.add@1', { log: log('n-kyu', { item_id: null, name: 'Kyujin lunch', kcal: 640, source: 'kyujin' }) }))
  ok(await server.mutate('logs.update@1', { id: 'l-0-a', patch: { qty: 3, kcal: 301, name: 'Soy milk (large)' } }))
  ok(await server.mutate('logs.update@1', { id: 'l-120-a', patch: { kcal: 777 } })) // an old log, outside the 35-day read window
  ok(await server.mutate('logs.delete@1', { id: 'l-1-b' }))
  ok(await server.mutate('logs.delete@1', { id: 'l-100-a' }))
  ok(await server.mutate('logs.restore@1', { id: 'l-gone' })) // was deleted in the Sheet
  // weights
  ok(await server.mutate('weights.upsert@1', { id: 'w-new-today', day: d0, ts: T(d0, '06:00'), kg: 68.8 })) // overwrites w-0 (same day)
  ok(await server.mutate('weights.upsert@1', { id: 'w-130', day: dayBack(130), ts: T(dayBack(130), '07:00'), kg: 69.4 })) // a day that only had a deleted row
  ok(await server.mutate('weights.delete@1', { id: 'w-5' }))
  ok(await server.asKyujin('weights.upsert@1', { id: 'w-kyu', day: dayBack(1), ts: T(dayBack(1), '08:00'), kg: 67.7 })) // overwrites w-1
  // favourites and config
  ok(await server.mutate('favorites.set@1', { item_id: 'fm:300', fav: true }))
  ok(await server.mutate('favorites.set@1', { item_id: '711:200', fav: false }))
  ok(await server.mutate('favorites.set@1', { item_id: 'u:bagel', fav: true }))
  ok(await server.mutate('favorites.set@1', { item_id: 'u:soy', fav: false })) // the item row itself does not change
  ok(await server.mutate('config.set@1', { key: 'target_kcal', value: '1750' }))
  ok(await server.mutate('config.set@1', { key: 'remind_meal_times', value: ['07:00', '13:00'] }))
  ok(await server.mutate('config.set@1', { key: 'tdee', value: '' }))
  ok(await server.mutate('config.set@1', { key: 'remind_weight_time', value: '06:45' }))
}

const blank = (v: unknown) => v === null || v === undefined || v === ''
const eq = (a: unknown, b: unknown) => (blank(a) && blank(b)) || (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : String(a) === String(b))

/** Differences between what D1 holds for the rows changed after V_cut and what the Sheet holds now. Empty = the Sheet is current. */
function diffs(dump: D1Dump, vCut: number, sheet: SheetSnapshot): string[] {
  const out: string[] = []
  const changed = (rows: DumpRow[]) => rows.filter((r) => Number(r.version) > vCut)
  const find = (rows: SheetRecord[], id: string) => rows.find((r) => String(r.id) === id)
  const del = (r: SheetRecord) => r.deleted === true || r.deleted === 'TRUE'
  const cmp = (what: string, pairs: [string, unknown, unknown][]) => {
    for (const [f, a, b] of pairs) if (!eq(a, b)) out.push(`${what} ${f}: D1 ${JSON.stringify(a)} vs Sheet ${JSON.stringify(b)}`)
  }
  const favLive = new Set(dump.tables.favorites.filter((f) => f.deleted_at === null).map((f) => String(f.item_id)))

  for (const s of changed(dump.tables.stores)) {
    const r = find(sheet.stores, String(s.id))
    if (!r) { if (s.deleted_at === null) out.push(`store ${s.id} missing in Sheet`); continue }
    cmp(`store ${s.id}`, [['deleted', s.deleted_at !== null, del(r)], ['name', s.name, r.name], ['last_eaten_at', s.last_eaten_at, r.last_eaten_at], ['created_by', s.created_by, r.created_by]])
  }
  const itemIds = new Set([...changed(dump.tables.items).map((i) => String(i.id)), ...dump.tables.favorites.filter((f) => Number(f.version) > vCut && String(f.item_id).startsWith('u:')).map((f) => String(f.item_id))])
  for (const id of itemIds) {
    const i = dump.tables.items.find((x) => x.id === id)!
    const r = find(sheet.items, id)
    if (!r) { if (i.deleted_at === null) out.push(`item ${id} missing in Sheet`); continue }
    cmp(`item ${id}`, [['deleted', i.deleted_at !== null, del(r)], ['name', i.name, r.name], ['serving', i.serving, r.serving], ['serving_g', i.serving_g, r.serving_g], ['kcal', i.kcal, r.kcal], ['protein', i.protein, r.protein], ['store', i.store_id, r.store], ['created_by', i.created_by, r.created_by], ['src', i.src, r.src]])
    if (id.startsWith('u:')) cmp(`item ${id}`, [['fav', favLive.has(id), r.fav === true]])
  }
  for (const l of changed(dump.tables.logs)) {
    const r = find(sheet.logs, String(l.id))
    if (!r) { if (l.deleted_at === null) out.push(`log ${l.id} missing in Sheet`); continue }
    cmp(`log ${l.id}`, [['deleted', l.deleted_at !== null, del(r)], ['qty', l.qty, r.qty], ['grams', l.grams, r.grams], ['kcal', l.kcal, r.kcal], ['protein', l.protein, r.protein], ['fat', l.fat, r.fat], ['carb', l.carb, r.carb], ['day', l.day, r.day], ['ts', l.ts, r.ts], ['name', l.name, r.name], ['source', l.source, r.source], ['item_id', l.item_id, r.item_id], ['store', l.store_id, r.store]])
  }
  for (const w of changed(dump.tables.weights)) {
    const sameDay = sheet.weights.filter((r) => String(r.day).slice(0, 10) === w.day && !del(r))
    if (w.deleted_at === null) {
      if (!sameDay.some((r) => eq(r.kg, w.kg))) out.push(`weight ${w.id} (${w.day}) ${w.kg}: no live Sheet weight with that kg that day`)
    } else if (sameDay.some((r) => String(r.id) === String(w.id))) out.push(`weight ${w.id} should be deleted`)
  }
  const cfg = dump.tables.config[0]!
  const wanted: Record<string, string> = {
    target_kcal: String(cfg.target_kcal), target_protein: String(cfg.target_protein), target_fat: String(cfg.target_fat), target_carb: String(cfg.target_carb),
    tdee: cfg.tdee === null ? '' : String(cfg.tdee), remind_meal_times: (cfg.remind_meal_times as string[]).join(','), remind_weight_time: cfg.remind_weight_time === null ? '' : String(cfg.remind_weight_time),
  }
  for (const [k, v] of Object.entries(wanted)) cmp('config', [[k, v, sheet.config[k]]])
  const official = [...favLive].filter((i) => !i.startsWith('u:') && !i.startsWith('ov:')).sort().join(',')
  cmp('config', [['fav_ids', official, String(sheet.config.fav_ids).split(',').filter(Boolean).sort().join(',')]])
  return out
}

const strip = (r: SheetRecord) => JSON.stringify({ ...r, updated_at: undefined })
/** rows that D1 did not change after V_cut must be untouched in the Sheet (the rollback does not rewrite history) */
function untouched(dump: D1Dump, vCut: number, before: SheetSnapshot, after: SheetSnapshot): string[] {
  const out: string[] = []
  const changedIds = (t: 'stores' | 'items' | 'logs' | 'weights') => new Set(dump.tables[t].filter((r) => Number(r.version) > vCut).map((r) => String(r.id)))
  const favItems = new Set(dump.tables.favorites.filter((f) => Number(f.version) > vCut).map((f) => String(f.item_id)))
  for (const t of ['stores', 'items', 'logs'] as const) {
    const skip = changedIds(t)
    if (t === 'items') for (const f of favItems) skip.add(f)
    for (const b of before[t]) {
      const id = String(b.id)
      if (skip.has(id)) continue
      const a = after[t].find((x) => String(x.id) === id)
      if (!a || strip(a) !== strip(b)) out.push(`${t} ${id} was touched`)
    }
  }
  return out
}

describe('migration round trip on a realistic synthetic Sheet', () => {
  let w: World
  let dump: D1Dump
  let plan: Plan
  let sheetBefore: SheetSnapshot
  beforeAll(async () => {
    w = await build()
    await mutate(w.server)
    dump = memoryDump(w.server)
    sheetBefore = await fetchSheet(w.g.client)
    plan = buildPlan(dump, { userId: OWNER, since: w.vCut, base: sheetBefore })
  })

  test('the seed Sheet has the quirks and spans more than one history page', () => {
    expect(w.sheet0.pages.Logs).toBeGreaterThan(2)
    const codes = new Set(w.result.anomalies.map((a) => a.code))
    for (const c of ['weight_id_assigned', 'weight_superseded', 'day_from_ts', 'number_from_string']) expect(codes.has(c), c).toBe(true)
  })

  test('after loading, verify says the migration is faithful (before any new-app mutation)', async () => {
    const fresh = await build()
    const rep = verifySnapshot(fresh.sheet0, memoryDump(fresh.server), { userId: OWNER })
    expect(rep.ok, formatReport(rep)).toBe(true)
  })

  test('the plan only contains rows changed after V_cut, ordered stores → items → logs → weights → config', () => {
    expect(plan.withBase).toBe(true)
    expect(plan.warnings).toEqual([])
    const order = ['stores', 'items', 'logs', 'weights', 'config', 'favorites']
    const ranks = plan.steps.map((s) => order.indexOf(s.table))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(plan.steps.every((s) => s.version > w.vCut || s.table === 'favorites' || s.table === 'items')).toBe(true)
    const labels = new Set(plan.steps.map((s) => s.label))
    for (const l of ['upsertStore', 'upsertItem', 'append', 'update', 'softDelete', 'restore', 'upsertWeight', 'setConfig']) expect(labels.has(l), l).toBe(true)
    // Kyujin's rows are written as Kyujin (Apps Script keeps created_by / source only that way)
    expect(plan.steps.find((s) => s.id === 'n-kyu')!.request.client).toBe('kyujin')
    expect(plan.steps.find((s) => s.id === 's:kyu')!.request.client).toBe('kyujin')
    // nothing for rows that did not change
    expect(plan.steps.some((s) => s.id === 'l-50-a')).toBe(false)
    expect(formatPlan(plan)).toContain('diffed against the current Sheet')
  })

  test('the plan, applied to the same fake Apps Script, makes the Sheet match D1; a second run has nothing left to do', async () => {
    const report = await applyPlan(w.g.client, plan)
    expect(report.failed).toEqual([])
    const after = await fetchSheet(w.g.client)
    expect(diffs(dump, w.vCut, after)).toEqual([])
    expect(untouched(dump, w.vCut, sheetBefore, after)).toEqual([])

    // idempotent: re-planning against the new Sheet is empty ...
    const again = buildPlan(dump, { userId: OWNER, since: w.vCut, base: after })
    expect(again.steps.map((s) => `${s.table}/${s.id}/${s.label}`)).toEqual([])
    // ... and replaying the OLD plan changes nothing (Apps Script is idempotent by id)
    const replay = await applyPlan(w.g.client, plan)
    expect(replay.failed.filter((f) => !['duplicate_name'].includes(f.error)), JSON.stringify(replay.failed)).toEqual([])
    const afterReplay = await fetchSheet(w.g.client)
    expect(diffs(dump, w.vCut, afterReplay)).toEqual([])
    expect(afterReplay.logs.length).toBe(after.logs.length)
    expect(afterReplay.weights.length).toBe(after.weights.length)
    expect(afterReplay.items.length).toBe(after.items.length)
  })

  test('without a base (conservative plan) the result is the same, on a fresh copy of the Sheet, and re-running is harmless', async () => {
    const w2 = await build()
    await mutate(w2.server)
    const dump2 = memoryDump(w2.server)
    const p = buildPlan(dump2, { userId: OWNER, since: w2.vCut, base: null })
    expect(p.withBase).toBe(false)
    expect(p.steps.length).toBeGreaterThan(plan.steps.length)
    const first = await applyPlan(w2.g.client, p)
    expect(first.failed, JSON.stringify(first.failed)).toEqual([])
    expect(first.tolerated).toBeGreaterThan(0) // restore of rows that are not there
    const after = await fetchSheet(w2.g.client)
    expect(diffs(dump2, w2.vCut, after)).toEqual([])
    const second = await applyPlan(w2.g.client, p)
    expect(second.failed, JSON.stringify(second.failed)).toEqual([])
    const after2 = await fetchSheet(w2.g.client)
    expect(diffs(dump2, w2.vCut, after2)).toEqual([])
    expect(after2.logs.length).toBe(after.logs.length)
    expect(after2.weights.length).toBe(after.weights.length)
  })

  test('the GAS `read` (what the v1 app sees) shows the post-cut-over state', async () => {
    const read = w.g.env.call({ action: 'read' }) as { logs: SheetRecord[]; weights: SheetRecord[]; items: SheetRecord[]; config: Record<string, string> }
    const todayLogs = read.logs.filter((l) => l.day === today() && l.deleted !== true)
    expect(todayLogs.map((l) => l.id).sort()).toEqual(['l-0-a', 'l-0-b', 'n-1', 'n-2', 'n-kyu', 'n-quick'].sort())
    expect(read.logs.find((l) => l.id === 'l-0-a')).toMatchObject({ qty: 3, kcal: 301, name: 'Soy milk (large)' })
    expect(read.weights.filter((x) => x.day === today() && x.deleted !== true).map((x) => x.kg)).toEqual([68.8])
    expect(read.config).toMatchObject({ target_kcal: '1750', tdee: '', remind_meal_times: '07:00,13:00', remind_weight_time: '06:45', fav_ids: 'fm:100,fm:300' })
    expect(read.items.find((i) => i.id === 'u:bagel')).toMatchObject({ name: 'Bagel XL', fav: true })
    expect(read.items.find((i) => i.id === 'u:soy')).toMatchObject({ fav: false })
    expect(read.items.find((i) => i.id === 'u:salad')).toMatchObject({ deleted: true })
  })
})

describe('reverse-export details', () => {
  const baseSheet = (): SheetSnapshot => ({ format: 'food-log-sheet/1', fetchedAt: '', serverTime: '', apiVersion: 1, config: { fav_ids: '', target_kcal: '2000' }, items: [], stores: [], logs: [], weights: [], warnings: [], pages: { Logs: 0, Weights: 0 } })
  const emptyDump = (): D1Dump => ({ meta: { version: 10, epoch: 'e' }, tables: { stores: [], items: [], logs: [], weights: [], favorites: [], config: [] } })
  const wrow = (over: DumpRow = {}): DumpRow => ({ id: 'w1', user_id: OWNER, day: '2026-10-10', ts: T('2026-10-10', '07:00'), kg: 70.5, version: 11, deleted_at: null, updated_at: 'x', ...over })

  test('rows at or below V_cut and rows of other users produce no steps', () => {
    const d = emptyDump()
    d.tables.weights.push(wrow({ version: 10 }), wrow({ id: 'w2', user_id: 'other', version: 99 }))
    expect(buildPlan(d, { userId: OWNER, since: 10, base: baseSheet() }).steps).toEqual([])
  })

  test('weights: a new id on a day that has a live row overwrites through a fresh `~r` id; a deleted new row is skipped; an unchanged kg is skipped', () => {
    const d = emptyDump()
    d.tables.weights.push(wrow({ id: 'wA', kg: 71 }), wrow({ id: 'wB', day: '2026-10-11', kg: 60, version: 12, deleted_at: 'x' }), wrow({ id: 'wC', day: '2026-10-12', kg: 70, version: 13 }))
    const b = baseSheet()
    b.weights = [
      { id: 'old', day: '2026-10-10', ts: T('2026-10-10'), kg: 70.5, deleted: false },
      { id: 'old2', day: '2026-10-12', ts: T('2026-10-12'), kg: 70, deleted: false },
    ]
    const p = buildPlan(d, { userId: OWNER, since: 10, base: b })
    expect(p.steps.map((s) => [s.id, s.label, (s.request.record as { id?: string } | undefined)?.id])).toEqual([['wA', 'upsertWeight', 'wA~r11']])
  })

  test('weights: a Sheet row without id cannot be softDeleted: warned, not sent', () => {
    const d = emptyDump()
    d.tables.weights.push(wrow({ id: 'w:2026-10-10', deleted_at: 'x' }))
    const b = baseSheet()
    b.weights = [{ id: '', day: '2026-10-10', ts: T('2026-10-10'), kg: 70, deleted: false }]
    const p = buildPlan(d, { userId: OWNER, since: 10, base: b })
    expect(p.steps).toEqual([])
    expect(p.warnings[0]).toMatch(/no id/)
  })

  test('a failing step is reported, the run goes on, and tolerated codes are not failures', async () => {
    const calls: string[] = []
    const client = {
      async call(body: Record<string, unknown>) {
        calls.push(String(body.action))
        if (body.action === 'restore') return { ok: false, error: 'not_found' }
        if (body.action === 'upsertStore') return { ok: false, error: 'duplicate_name', message: 'x' }
        return { ok: true }
      },
    }
    const plan: Plan = {
      userId: OWNER, since: 0, withBase: false, warnings: [],
      steps: [
        { seq: 1, version: 1, table: 'stores', id: 's:a', label: 'restore', request: { action: 'restore' }, tolerate: ['not_found'] },
        { seq: 2, version: 1, table: 'stores', id: 's:a', label: 'upsertStore', request: { action: 'upsertStore' } },
        { seq: 3, version: 1, table: 'logs', id: 'l', label: 'append', request: { action: 'append' } },
      ],
    }
    const r = await applyPlan(client, plan)
    expect(calls).toEqual(['restore', 'upsertStore', 'append'])
    expect(r).toMatchObject({ applied: 1, tolerated: 1 })
    expect(r.failed).toEqual([{ seq: 2, label: 'upsertStore', id: 's:a', error: 'duplicate_name', message: 'x' }])
  })

  test('a dry run needs no client: buildPlan and formatPlan are pure', () => {
    const d = emptyDump()
    d.tables.config.push({ user_id: OWNER, target_kcal: 1700, target_protein: 150, target_fat: 60, target_carb: 200, tdee: null, remind_meal_times: ['08:00'], remind_weight_time: null, version: 11, deleted_at: null, updated_at: 'x' })
    const p = buildPlan(d, { userId: OWNER, since: 10, base: baseSheet() })
    expect(p.steps.map((s) => (s.request as { key: string }).key)).toEqual(['target_kcal', 'target_protein', 'target_fat', 'target_carb', 'tdee', 'remind_meal_times', 'remind_weight_time'])
    expect(formatPlan(p)).toContain('setConfig')
  })
})
