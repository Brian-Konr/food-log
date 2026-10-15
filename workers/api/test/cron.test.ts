import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { TABLES } from '@food-log/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { EXPORT_CHUNK_ROWS, csvCell, runExport } from '../src/cron/export.ts'
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

describe('daily export to R2', () => {
  it('writes one JSON per table, logs.csv and _ok.json under exports/YYYY-MM-DD/, including tombstones', async () => {
    await seedSmall()
    const m = await runExport(env, '2026-10-13')
    expect(await keys('exports/2026-10-13/')).toEqual(
      ['config.json', 'favorites.json', 'items.json', 'logs.csv', 'logs.json', 'stores.json', 'weights.json', '_ok.json'].map((f) => 'exports/2026-10-13/' + f).sort(),
    )
    const n = async (t: string) => (await json<Array<Record<string, unknown>>>(`exports/2026-10-13/${t}.json`)).length
    expect(await n('stores')).toBe(1)
    expect(await n('items')).toBe(1)
    expect(await n('logs')).toBe(2)
    expect(await n('weights')).toBe(1)
    expect(await n('favorites')).toBe(1)
    expect(await n('config')).toBe(1)
    const weights = await json<Array<{ id: string; deleted_at: string | null; user_id: string }>>('exports/2026-10-13/weights.json')
    expect(weights[0]).toMatchObject({ id: 'w1', user_id: userId })
    expect(weights[0]!.deleted_at).not.toBeNull() // soft-deleted rows are backed up too
    const cfg = await json<Array<{ target_kcal: number; remind_meal_times: string[] }>>('exports/2026-10-13/config.json')
    expect(cfg[0]).toMatchObject({ target_kcal: 1900, remind_meal_times: [] })
    // the manifest
    const ok = await json<typeof m>('exports/2026-10-13/_ok.json')
    expect(ok).toMatchObject({ ok: true, day: '2026-10-13', versionAtStart: 8, versionAtEnd: 8, epoch: 'e1' })
    for (const t of TABLES) expect(ok.tables[t]!.rows).toBe(await n(t))
    expect(ok.tables['logs.csv']!.rows).toBe(2)
  })

  it('logs.csv has a header, one line per log, RFC 4180 quoting, and no secrets tables are exported', async () => {
    await seedSmall()
    await runExport(env, '2026-10-13')
    const csv = (await text('exports/2026-10-13/logs.csv')).replace(/^﻿/, '')
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
    const order: string[] = []
    const spy = (failOn?: string): Pick<Env, 'DB' | 'EXPORTS'> => ({
      DB: env.DB,
      EXPORTS: new Proxy(env.EXPORTS, {
        get(t, prop) {
          const v = (t as unknown as Record<string | symbol, unknown>)[prop]
          if (prop === 'put')
            return async (key: string, ...rest: unknown[]) => {
              if (failOn && key.endsWith(failOn)) throw new Error('R2 down')
              order.push(key)
              return (v as (...a: unknown[]) => unknown).call(t, key, ...rest)
            }
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
        },
      }) as R2Bucket,
    })
    await runExport(spy(), '2026-10-14')
    expect(order.at(-1)).toBe('exports/2026-10-14/_ok.json')
    expect(order.filter((k) => k.endsWith('_ok.json'))).toHaveLength(1)
    expect(order).toHaveLength(8)

    await expect(runExport(spy('logs.json'), '2026-10-15')).rejects.toThrow('R2 down')
    expect(await keys('exports/2026-10-15/')).not.toContain('exports/2026-10-15/_ok.json')
  })

  it(`reads in chunks of ${EXPORT_CHUNK_ROWS}: 2,500 logs across three chunks all arrive exactly once, ordered`, async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2499)
       INSERT INTO logs (id, user_id, day, ts, item_id, name, src, qty, grams, kcal, protein, fat, carb, source, store_id, version, deleted_at, updated_at)
       SELECT 'e' || i, ?1, '2026-10-11', ?2, 'fm:1', 'x', '全家', 1, NULL, 100, 1, 1, 1, 'app', NULL, 1 + i, NULL, 'x' FROM n`,
    ).bind(userId, noon('2026-10-11')).run()
    const m = await runExport(env, '2026-10-13')
    const rows = await json<Array<{ id: string }>>('exports/2026-10-13/logs.json')
    expect(rows).toHaveLength(2500)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500)
    expect(m.tables.logs!.rows).toBe(2500)
    expect(((await text('exports/2026-10-13/logs.csv')).match(/\r\n/g) ?? []).length).toBe(2501)
  })

  it('covers every user, and an empty database exports empty arrays plus a manifest', async () => {
    await runExport(env, '2026-10-13')
    for (const t of TABLES) expect((await text(`exports/2026-10-13/${t}.json`)).trim()).toBe('[]')
    expect((await json<{ tables: Record<string, { rows: number }> }>('exports/2026-10-13/_ok.json')).tables.logs!.rows).toBe(0)
    const other = await login('second@example.com')
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-10'))
    await pushOk(other.cookie, 'c1', upsertWeight(1, 'w1', 80, '2026-10-10'))
    await runExport(env, '2026-10-14')
    const rows = await json<Array<{ user_id: string; kg: number }>>('exports/2026-10-14/weights.json')
    expect(rows.map((r) => r.kg).sort()).toEqual([70, 80])
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(2)
  })

  it('the scheduled() handler dates the export by the Taipei day of the scheduled time (20:00 UTC = 04:00 next day in Taipei)', async () => {
    await seedSmall()
    await worker.scheduled(createScheduledController({ scheduledTime: Date.parse('2026-10-12T20:00:00Z'), cron: '0 20 * * *' }), env as unknown as Env)
    expect(await keys('exports/')).toContain('exports/2026-10-13/_ok.json')
  })
})
