import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { HISTORY_LIMIT, fetchSheet, writeSnapshot } from '../src/fetch-sheet.ts'
import type { GasClient } from '../src/gas-client.ts'
import { seedFakeGas } from './helpers.ts'

test('fetches everything from the fake Apps Script: read, then history pages for Logs and Weights until hasMore is false', async () => {
  const g = seedFakeGas()
  const calls: Record<string, unknown>[] = []
  const client: GasClient = { call: async (b) => (calls.push(b), g.client.call(b)) }
  const snap = await fetchSheet(client)

  // only 35 days of logs and 90 days of weights come with `read`; the rest must come from history
  const sheetLogs = g.env.sheets.get('Logs')!.data.length - 1
  expect(snap.logs).toHaveLength(sheetLogs)
  expect(new Set(snap.logs.map((l) => String(l.id))).size).toBe(sheetLogs)
  const sheetWeights = g.env.sheets.get('Weights')!.data.length - 1
  expect(snap.weights).toHaveLength(sheetWeights)
  expect(snap.pages.Logs).toBeGreaterThan(2)
  expect(snap.pages.Weights).toBeGreaterThanOrEqual(1)
  expect(snap.warnings).toEqual([])

  // only read-only actions are used, with the documented parameters
  expect([...new Set(calls.map((c) => c.action))].sort()).toEqual(['history', 'read'])
  for (const c of calls.filter((x) => x.action === 'history')) {
    expect(c.limit).toBe(HISTORY_LIMIT)
    expect(['Logs', 'Weights']).toContain(c.table)
    expect(String(c.before)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }
  // Items / Stores / Config come from read in full (deleted rows included)
  expect(snap.items.map((i) => i.id)).toContain('u:diner')
  expect(snap.stores).toHaveLength(3)
  expect(snap.config.fav_ids).toBe('fm:100,711:200')
  // the Sheet quirk that has no id is carried through
  expect(snap.weights.some((w) => w.id === '')).toBe(true)
})

test('a day with more rows than one page does not lose the older days; the overflow is reported', async () => {
  const all = [
    ...Array.from({ length: 100 }, (_, i) => ({ id: `a${String(i).padStart(3, '0')}`, day: '2026-10-01' })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, day: '2026-09-30' })),
  ]
  const client: GasClient = {
    async call(body) {
      if (body.action === 'read') return { ok: true, version: 1, serverTime: '2026-10-15T09:00:00+08:00', config: {}, items: [], stores: [], logs: [], weights: [] }
      const before = String(body.before)
      const rows = all.filter((r) => r.day < before).sort((a, b) => b.day.localeCompare(a.day))
      return { ok: true, table: body.table, records: rows.slice(0, 90), hasMore: rows.length > 90 }
    },
  }
  const snap = await fetchSheet(client)
  expect(snap.logs.some((l) => String(l.id).startsWith('b'))).toBe(true)
  expect(snap.warnings.join(' ')).toMatch(/more than 90 rows on 2026-10-01/)
})

test('a page cut inside a day is re-read from the next day (overlap), so no row of that day is lost', async () => {
  // 40 rows on 10-03, 60 on 10-02, 5 on 10-01: page 1 = 40 + 50 of 10-02; page 2 must still deliver the other 10 of 10-02
  const all = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, day: '2026-10-03' })),
    ...Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, day: '2026-10-02' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, day: '2026-10-01' })),
  ]
  const client: GasClient = {
    async call(body) {
      if (body.action === 'read') return { ok: true, version: 1, serverTime: '2026-10-04T09:00:00+08:00', config: {}, items: [], stores: [], logs: [], weights: [] }
      const rows = all.filter((r) => r.day < String(body.before)).sort((a, b) => b.day.localeCompare(a.day))
      return { ok: true, table: body.table, records: rows.slice(0, 90), hasMore: rows.length > 90 }
    },
  }
  const snap = await fetchSheet(client)
  expect(snap.logs).toHaveLength(105)
  expect(snap.warnings).toEqual([])
})

test('stops (with a warning) on an empty page that still claims hasMore', async () => {
  const client: GasClient = {
    async call(body) {
      if (body.action === 'read') return { ok: true, version: 1, serverTime: '2026-10-15T09:00:00+08:00', config: {}, items: [], stores: [], logs: [], weights: [] }
      return { ok: true, records: [], hasMore: true }
    },
  }
  const snap = await fetchSheet(client)
  expect(snap.warnings.length).toBe(2)
})

test('an ok:false answer aborts the fetch', async () => {
  const client: GasClient = { call: async () => ({ ok: false, error: 'unauthorized', message: 'no' }) }
  await expect(fetchSheet(client)).rejects.toMatchObject({ code: 'unauthorized' })
})

test('writeSnapshot writes sheet-<stamp>.json with private permissions', async () => {
  const g = seedFakeGas()
  const snap = await fetchSheet(g.client)
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'fl-out-')), 'out')
  const file = writeSnapshot(snap, dir, new Date('2026-10-15T01:02:03Z'))
  expect(path.basename(file)).toBe('sheet-20261015-010203.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, 'utf8')).format).toBe('food-log-sheet/1')
})
