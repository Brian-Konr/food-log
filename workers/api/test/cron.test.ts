import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { TABLES } from '@food-log/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_CHUNK_ROWS, EXPORT_CRON, EXPORT_LEASE_MS, EXPORT_RESUME_CRON, csvCell, exportSteps, runExport } from '../src/cron/export.ts'
import type { ExportManifest } from '../src/cron/export.ts'
import worker from '../src/index.ts'
import type { Env } from '../src/env.ts'
import { itemArgs, login, logArgs, mut, noon, pushOk, quickLogArgs, resetDb, storeArgs, upsertWeight } from './helpers.ts'

let cookie: string
let userId: string
beforeEach(async () => {
  await resetDb()
  ;({ cookie, userId } = await login())
  const list = await env.EXPORTS.list()
  for (const o of list.objects) await env.EXPORTS.delete(o.key)
})

const keys = async (prefix: string) => (await env.EXPORTS.list({ prefix })).objects.map((o) => o.key).sort()
const text = async (key: string) => (await (await env.EXPORTS.get(key))!.text())
const json = async <T = unknown[]>(key: string) => JSON.parse(await text(key)) as T

async function seedSmall() {
  await pushOk(
    cookie,
    'c1',
    mut(1, 'stores.upsert@1', storeArgs('s:1', '阿財牛肉麵')),
    mut(2, 'items.upsert@1', itemArgs('u:1', { store_id: 's:1', name: '牛肉麵' })),
    mut(3, 'logs.add@1', { log: logArgs('L1', { item_id: 'u:1', name: '牛肉麵, "加辣"', src: '其他', store_id: 's:1' }) }),
    mut(4, 'logs.add@1', { log: quickLogArgs('Q1') }),
    upsertWeight(5, 'w1', 70.5, '2026-10-11'),
    mut(6, 'weights.delete@1', { id: 'w1' }),
    mut(7, 'favorites.set@1', { item_id: 'fm:1', fav: true }),
    mut(8, 'config.set@1', { key: 'target_kcal', value: '1900' }),
  )
}

type Bindings = Pick<Env, 'DB' | 'EXPORTS'>

/** env whose R2 put() is observable: `before` may throw (simulated crash) or mutate the database (data changing mid-export). */
function spyEnv(before?: (key: string) => Promise<void> | void, order: string[] = []): Bindings & { order: string[] } {
  return {
    DB: env.DB,
    order,
    EXPORTS: new Proxy(env.EXPORTS, {
      get(t, prop) {
        const v = (t as unknown as Record<string | symbol, unknown>)[prop]
        if (prop === 'put')
          return async (key: string, ...rest: unknown[]) => {
            await before?.(key)
            order.push(key)
            return (v as (...a: unknown[]) => unknown).call(t, key, ...rest)
          }
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    }) as R2Bucket,
  }
}

const seedLogs = async (n: number, prefix = 'e') =>
  void (await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
     INSERT INTO logs (id, user_id, day, ts, item_id, name, src, qty, grams, kcal, protein, fat, carb, source, store_id, version, deleted_at, updated_at)
     SELECT ?4 || i, ?2, '2026-10-11', ?3, 'fm:1', 'x', '全家', 1, NULL, 100, 1, 1, 1, 'app', NULL, 1 + i, NULL, 'x' FROM n`,
  ).bind(n - 1, userId, noon('2026-10-11'), prefix).run())

const progress = () => env.DB.prepare(`SELECT * FROM export_progress`).first<Record<string, unknown>>()
const partRows = async (day: string, table: string) => {
  const ks = (await keys(`exports/${day}/${table}.part-`)).filter((k) => k.endsWith('.json'))
  const out: unknown[][] = []
  for (let i = 1; i <= ks.length; i++) out.push(await json(`exports/${day}/${table}.part-${i}.json`))
  return { keys: ks, parts: out }
}
const D = '2026-10-13'

describe('daily export to R2', () => {
  it('writes part files per table, logs csv parts and _ok.json (with the part list) under exports/YYYY-MM-DD/, including tombstones', async () => {
    await seedSmall()
    const m = await runExport(env, D)
    expect(await keys(`exports/${D}/`)).toEqual(
      [
        'config.part-1.json',
        'favorites.part-1.json',
        'items.part-1.json',
        'logs.part-1.csv',
        'logs.part-1.json',
        'stores.part-1.json',
        'weights.part-1.json',
        '_ok.json',
      ].map((f) => `exports/${D}/` + f).sort(),
    )
    const n = async (t: string) => (await json<Array<Record<string, unknown>>>(`exports/${D}/${t}.part-1.json`)).length
    expect(await n('stores')).toBe(1)
    expect(await n('items')).toBe(1)
    expect(await n('logs')).toBe(2)
    expect(await n('weights')).toBe(1)
    expect(await n('favorites')).toBe(1)
    expect(await n('config')).toBe(1)
    const weights = await json<Array<{ id: string; deleted_at: string | null; user_id: string }>>(`exports/${D}/weights.part-1.json`)
    expect(weights[0]).toMatchObject({ id: 'w1', user_id: userId })
    expect(weights[0]!.deleted_at).not.toBeNull() // soft-deleted rows are backed up too
    const cfg = await json<Array<{ target_kcal: number; remind_meal_times: string[] }>>(`exports/${D}/config.part-1.json`)
    expect(cfg[0]).toMatchObject({ target_kcal: 1900, remind_meal_times: [] })
    // the manifest
    const ok = await json<ExportManifest>(`exports/${D}/_ok.json`)
    expect(ok).toEqual(m)
    expect(ok).toMatchObject({ ok: true, day: D, versionAtStart: 8, versionAtEnd: 8, epoch: 'e1', consistent: true, attempts: 1 })
    for (const t of TABLES) {
      expect(ok.tables[t]!.rows).toBe(await n(t))
      expect(ok.tables[t]!.parts).toEqual([{ key: `exports/${D}/${t}.part-1.json`, rows: await n(t), bytes: expect.any(Number) }])
      expect(ok.tables[t]!.bytes).toBe(ok.tables[t]!.parts[0]!.bytes)
    }
    expect(ok.tables['logs.csv']!.rows).toBe(2)
    expect(ok.tables['logs.csv']!.parts.map((p) => p.key)).toEqual([`exports/${D}/logs.part-1.csv`])
    expect((await env.EXPORTS.head(ok.tables.logs!.parts[0]!.key))!.size).toBe(ok.tables.logs!.bytes)
    expect(await progress()).toBeNull() // progress row removed once _ok.json is written
  })

  it('logs csv parts have a header (part 1), one line per log, RFC 4180 quoting, and no secrets tables are exported', async () => {
    await seedSmall()
    await runExport(env, D)
    const csv = (await text(`exports/${D}/logs.part-1.csv`)).replace(/^﻿/, '')
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('id,day,ts,item_id,name,src,qty,grams,kcal,protein,fat,carb,source,store_id,deleted_at,updated_at,user_id')
    const l1 = lines.find((l) => l.startsWith('L1,'))!
    expect(l1).toContain('"牛肉麵, ""加辣"""')
    expect(csvCell(null)).toBe('')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('x\ny')).toBe('"x\ny"')
    const all = await keys('exports/')
    expect(all.some((k) => /session|user|passkey|apikey|login/.test(k))).toBe(false)
  })

  it('_ok.json is written last, and a failure midway leaves no _ok.json', async () => {
    await seedSmall()
    const a = spyEnv()
    await runExport(a, '2026-10-14')
    expect(a.order.at(-1)).toBe('exports/2026-10-14/_ok.json')
    expect(a.order.filter((k) => k.endsWith('_ok.json'))).toHaveLength(1)
    expect(a.order).toHaveLength(8)

    const failing = spyEnv((k) => {
      if (k.endsWith('logs.part-1.json')) throw new Error('R2 down')
    })
    await expect(runExport(failing, '2026-10-15')).rejects.toThrow('R2 down')
    expect(await keys('exports/2026-10-15/')).not.toContain('exports/2026-10-15/_ok.json')
  })

  it(`a large database is exported over several steps: ${EXPORT_CHUNK_ROWS}-row parts, complete, and _ok.json only at the end`, async () => {
    await seedSmall()
    await seedLogs(2500)
    const total = 2500 + 2 // two logs from seedSmall
    const results: string[] = []
    let ok: ExportManifest | undefined
    for (let i = 0; i < 10 && !ok; i++) {
      // one chunk per invocation
      const r = await exportSteps(env, D, { rowBudget: 1 })
      results.push(r.status)
      if (r.status === 'done') ok = r.manifest
      else {
        expect(await keys(`exports/${D}/`)).not.toContain(`exports/${D}/_ok.json`)
        expect(await progress()).not.toBeNull()
      }
    }
    // stores/items 1 row each + logs 3 chunks (1000/1000/502) + weights/favorites/config: finishes within a handful of invocations
    expect(results.at(-1)).toBe('done')
    expect(results.slice(0, -1).every((s) => s === 'partial')).toBe(true)
    expect(results.length).toBeGreaterThan(3)
    const { keys: lk, parts } = await partRows(D, 'logs')
    expect(lk).toHaveLength(3)
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, total - 2000])
    const ids = parts.flat().map((r) => (r as { id: string }).id)
    expect(new Set(ids).size).toBe(total)
    expect(ok!.tables.logs).toMatchObject({ rows: total })
    expect(ok!.tables.logs!.parts.map((p) => p.rows)).toEqual([1000, 1000, total - 2000])
    // csv parts: header only in part 1, same row counts, 1 line per row
    const csvParts = await Promise.all([1, 2, 3].map((i) => text(`exports/${D}/logs.part-${i}.csv`)))
    expect(csvParts[0]!.startsWith('id,day,')).toBe(true) // text() drops the BOM; check the bytes below
    expect([...new Uint8Array(await (await env.EXPORTS.get(`exports/${D}/logs.part-1.csv`))!.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(csvParts[1]!.startsWith('id,day,')).toBe(false)
    expect(csvParts.map((c) => (c.match(/\r\n/g) ?? []).length)).toEqual([1001, 1000, total - 2000])
    expect(ok!.tables['logs.csv']!.parts).toHaveLength(3)
    expect(ok!.tables['logs.csv']!.rows).toBe(total)
    // rows come out in rowid order exactly once; every other table has its single part
    expect(ok!.tables.weights!.parts).toHaveLength(1)
    expect(await progress()).toBeNull()
  })

  it('exactly one full chunk does not leave an empty trailing part', async () => {
    await seedLogs(1000)
    const m = await runExport(env, D)
    expect(m.tables.logs!.parts.map((p) => p.rows)).toEqual([1000])
    expect(await keys(`exports/${D}/logs.part-`)).toEqual([`exports/${D}/logs.part-1.csv`, `exports/${D}/logs.part-1.json`])
  })

  it('a crash midway leaves progress in export_progress and the next invocation resumes from it, without redoing finished parts', async () => {
    await seedSmall()
    await seedLogs(2500)
    let crash = true
    const a = spyEnv((k) => {
      if (crash && k.endsWith('logs.part-2.json')) throw new Error('isolate died')
    })
    await expect(exportSteps(a, D, { rowBudget: Infinity })).rejects.toThrow('isolate died')
    expect(await keys(`exports/${D}/`)).not.toContain(`exports/${D}/_ok.json`)
    const p = (await progress())!
    expect(p).toMatchObject({ day: D, attempt: 1, table_idx: TABLES.indexOf('logs'), part: 2, rows: 1000, version_at_start: 8 })
    expect(Number(p.rowid_cursor)).toBeGreaterThanOrEqual(1000)
    expect(p.lease_until).toBe(0) // released in finally

    crash = false
    const b = spyEnv()
    const r = await exportSteps(b, D, { rowBudget: Infinity })
    expect(r.status).toBe('done')
    expect(b.order).not.toContain(`exports/${D}/logs.part-1.json`) // resumed, not restarted
    expect(b.order).not.toContain(`exports/${D}/stores.part-1.json`)
    expect(b.order[0]).toBe(`exports/${D}/logs.part-2.json`)
    const { parts } = await partRows(D, 'logs')
    const ids = parts.flat().map((x) => (x as { id: string }).id)
    expect(parts.map((x) => x.length)).toEqual([1000, 1000, 502])
    expect(new Set(ids).size).toBe(2502)
    const ok = await json<ExportManifest>(`exports/${D}/_ok.json`)
    expect(ok.tables.logs!.rows).toBe(2502)
    expect(ok.tables.stores!.rows).toBe(1) // tables finished before the crash are in the manifest too
    expect(ok.consistent).toBe(true)
  })

  it('a hard crash (lease never released) blocks others only until the lease expires; a concurrent invocation gets busy', async () => {
    await seedSmall()
    const r1 = await exportSteps(env, D, { rowBudget: 1 })
    expect(r1.status).toBe('partial')
    await env.DB.prepare(`UPDATE export_progress SET lease_until = ?`).bind(Date.now() + EXPORT_LEASE_MS).run() // pretend an isolate holds it
    const busy = await exportSteps(env, D, { rowBudget: Infinity })
    expect(busy).toEqual({ status: 'busy', rowsThisRun: 0 })
    expect(await keys(`exports/${D}/`)).not.toContain(`exports/${D}/_ok.json`)
    await env.DB.prepare(`UPDATE export_progress SET lease_until = ?`).bind(Date.now() - 1).run() // it died: lease expired
    expect((await exportSteps(env, D, { rowBudget: Infinity })).status).toBe('done')
    // two simultaneous invocations: one works, the other is busy or finds it already done; the result is one coherent export
    await resetProgressAndObjects()
    const both = await Promise.all([exportSteps(env, D), exportSteps(env, D)])
    expect(both.some((r) => r.status === 'done')).toBe(true)
    expect(both.every((r) => ['done', 'busy', 'skipped'].includes(r.status))).toBe(true)
    expect((await json<ExportManifest>(`exports/${D}/_ok.json`)).tables.logs!.rows).toBe(2)
  })

  it('an existing _ok.json makes a normal run a no-op; force re-exports from scratch', async () => {
    await seedSmall()
    await runExport(env, D)
    const spy = spyEnv()
    expect(await exportSteps(spy, D)).toEqual({ status: 'skipped', rowsThisRun: 0 })
    expect(spy.order).toEqual([])
    await exportSteps(spy, D, { force: true })
    expect(spy.order.at(-1)).toBe(`exports/${D}/_ok.json`)
  })

  it('an unfinished export of an older day is abandoned when a new day starts', async () => {
    await seedSmall()
    await exportSteps(env, '2026-10-12', { rowBudget: 1 })
    expect((await progress())!.day).toBe('2026-10-12')
    expect((await exportSteps(env, D)).status).toBe('done')
    expect(await keys('exports/2026-10-12/_ok.json')).toEqual([])
    expect(await progress()).toBeNull()
  })

  describe('consistency (versionAtStart)', () => {
    const bumpOnConfigPart = (times: number) => {
      let n = 0
      return spyEnv(async (k) => {
        if (k.endsWith('config.part-1.json') && n++ < times) {
          // a writer commits while the export is on its last table
          await env.DB.batch([
            env.DB.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'version'`),
            env.DB.prepare(`INSERT INTO weights (id, user_id, day, ts, kg, version, deleted_at, updated_at) VALUES (?, ?, '2026-10-0${n}', ?, 70.0, (SELECT value FROM meta WHERE key = 'version'), NULL, 'x')`).bind('late' + n, userId, noon(`2026-10-0${n}`, '08:00')),
          ])
        }
      })
    }

    it('head version moved once: the export restarts with fresh progress, includes the late write, and is consistent', async () => {
      await seedSmall()
      const a = bumpOnConfigPart(1)
      const m = await runExport(a, D)
      expect(m).toMatchObject({ consistent: true, attempts: 2, versionAtStart: 9, versionAtEnd: 9 })
      const weights = await json<Array<{ id: string }>>(`exports/${D}/weights.part-1.json`)
      expect(weights.map((w) => w.id).sort()).toEqual(['late1', 'w1'])
      expect(a.order.filter((k) => k.endsWith('stores.part-1.json'))).toHaveLength(2) // really started over
      expect(a.order.filter((k) => k.endsWith('_ok.json'))).toHaveLength(1)
      expect(a.order.at(-1)).toBe(`exports/${D}/_ok.json`)
    })

    it('moved again on the retry: _ok.json is written with consistent:false (restore drill must reject it), after one restart only', async () => {
      await seedSmall()
      const a = bumpOnConfigPart(2)
      const m = await runExport(a, D)
      expect(m).toMatchObject({ consistent: false, attempts: 2, versionAtStart: 9, versionAtEnd: 10 })
      expect(a.order.filter((k) => k.endsWith('stores.part-1.json'))).toHaveLength(2)
      expect(await json<ExportManifest>(`exports/${D}/_ok.json`)).toMatchObject({ consistent: false })
      expect(await progress()).toBeNull()
    })

    it('an epoch change counts as a change too', async () => {
      await seedSmall()
      let flipped = false
      const a = spyEnv(async (k) => {
        if (k.endsWith('config.part-1.json') && !flipped) {
          flipped = true
          await env.DB.prepare(`UPDATE meta SET value = 'e2' WHERE key = 'epoch'`).run()
        }
      })
      const m = await runExport(a, D)
      expect(m).toMatchObject({ consistent: true, attempts: 2, epoch: 'e2' })
    })

    it('the restart works across invocations too (progress carries attempt and versionAtStart)', async () => {
      await seedSmall()
      let bumped = false
      const a = spyEnv(async (k) => {
        if (k.endsWith('config.part-1.json') && !bumped) {
          bumped = true
          await env.DB.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'version'`).run()
        }
      })
      const seen: string[] = []
      let last: Awaited<ReturnType<typeof exportSteps>> | undefined
      for (let i = 0; i < 40 && last?.status !== 'done'; i++) {
        last = await exportSteps(a, D, { rowBudget: 1 })
        seen.push(last.status)
      }
      expect(last).toMatchObject({ status: 'done', manifest: { attempts: 2, consistent: true, versionAtStart: 9 } })
    })
  })

  it('covers every user, and an empty database exports one empty part per table plus a manifest', async () => {
    await runExport(env, D)
    for (const t of TABLES) expect((await text(`exports/${D}/${t}.part-1.json`)).trim()).toBe('[]')
    expect((await json<ExportManifest>(`exports/${D}/_ok.json`)).tables.logs!.rows).toBe(0)
    const other = await login('second@example.com')
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-10'))
    await pushOk(other.cookie, 'c1', upsertWeight(1, 'w1', 80, '2026-10-10'))
    await runExport(env, '2026-10-14')
    const rows = await json<Array<{ user_id: string; kg: number }>>('exports/2026-10-14/weights.part-1.json')
    expect(rows.map((r) => r.kg).sort()).toEqual([70, 80])
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(2)
  })
})

async function resetProgressAndObjects() {
  await env.DB.prepare(`DELETE FROM export_progress`).run()
  for (const o of (await env.EXPORTS.list()).objects) await env.EXPORTS.delete(o.key)
}

describe('scheduled() handler and the two crons', () => {
  const run = (iso: string, cron: string, over: Partial<Env> = {}) =>
    worker.scheduled(createScheduledController({ scheduledTime: Date.parse(iso), cron }), { ...(env as unknown as Env), ...over })

  it('dates the export by the Taipei day of the scheduled time (20:00 UTC = 04:00 next day in Taipei)', async () => {
    await seedSmall()
    await run('2026-10-12T20:00:00Z', EXPORT_CRON)
    expect(await keys('exports/')).toContain('exports/2026-10-13/_ok.json')
  })

  it('the start cron does a bounded amount of work; each resume tick continues; _ok.json appears only at the end; later ticks are no-ops', async () => {
    await seedSmall()
    await seedLogs(2500)
    const over = { EXPORT_ROW_BUDGET: '1000' }
    const okExists = async () => (await keys('exports/2026-10-13/')).includes('exports/2026-10-13/_ok.json')
    await run('2026-10-12T20:00:00Z', EXPORT_CRON, over)
    expect(await okExists()).toBe(false)
    expect((await progress())!.day).toBe('2026-10-13')
    // the resume cron also fires at minute 0: it leaves that tick to the start cron
    const before = JSON.stringify(await progress())
    await run('2026-10-12T20:00:00Z', EXPORT_RESUME_CRON, over)
    expect(JSON.stringify(await progress())).toBe(before)
    await run('2026-10-12T20:05:00Z', EXPORT_RESUME_CRON, over)
    expect(await okExists()).toBe(false)
    await run('2026-10-12T20:10:00Z', EXPORT_RESUME_CRON, over)
    expect(await okExists()).toBe(true)
    const ok = await json<ExportManifest>('exports/2026-10-13/_ok.json')
    expect(ok.tables.logs!.rows).toBe(2502)
    // nothing left to do: the next tick neither writes nor errors
    const put = vi.spyOn(env.EXPORTS, 'put')
    await run('2026-10-12T20:15:00Z', EXPORT_RESUME_CRON, over)
    expect(put).not.toHaveBeenCalled()
    put.mockRestore()
    expect(await progress()).toBeNull()
  })

  it('a resume tick starts the export when the 04:00 run never got going (no progress, no _ok.json)', async () => {
    await seedSmall()
    await run('2026-10-12T20:05:00Z', EXPORT_RESUME_CRON)
    expect(await keys('exports/')).toContain('exports/2026-10-13/_ok.json')
  })
})
