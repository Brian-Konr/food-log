// /bot/v1 read endpoints, mutate envelope, provenance (created_by / source = kyujin), summary parity with core, OpenAPI.
import { env } from 'cloudflare:workers'
import { addDays, defaultConfigRow, summarizeDay, taipeiToday, weekStart, weekSummary } from '@food-log/core'
import { MemoryServer } from '@food-log/core/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import { call, itemArgs, login, logArgs, mintBotKey, mut, noon, pushOk, quickLogArgs, resetDb, storeArgs, weightArgs } from './helpers.ts'

let cookie: string
let userId: string
let key: string
const today = taipeiToday(Date.now())
const day = (back: number) => addDays(today, -back)
let nextId = 0
beforeEach(async () => {
  await resetDb()
  ;({ cookie, userId } = await login())
  key = (await mintBotKey(userId)).key
  nextId = 0
})

const owner = async (name: string, args: unknown) => (await pushOk(cookie, 'api-owner', mut(++nextId, name, args))).results[0]!
const bot = (name: string, args: unknown) => call('/bot/v1/mutate', { method: 'POST', bearer: key, json: { name, args } })
const getJson = async (path: string) => {
  const res = await call(path, { bearer: key })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}
const logOn = (id: string, d: string, over: Record<string, unknown> = {}) => logArgs(id, { day: d, ts: noon(d), ...over })

describe('GET /bot/v1/read', () => {
  it('logs 35 days (today-34 in, today-35 out), weights 90 days (today-89 in, today-90 out), items/stores/config all incl. deleted', async () => {
    for (const [id, back] of [['in', 34], ['out', 35], ['today', 0]] as const) await owner('logs.add@1', { log: logOn(id, day(back)) })
    await owner('weights.upsert@1', weightArgs('w-in', 70, day(89)))
    await owner('weights.upsert@1', weightArgs('w-out', 71, day(90)))
    await owner('stores.upsert@1', storeArgs('s:1', '甲'))
    await owner('stores.upsert@1', storeArgs('s:2', '乙'))
    await owner('stores.delete@1', { id: 's:2' })
    await owner('items.upsert@1', itemArgs('u:1', { store_id: 's:1' }))
    await owner('items.upsert@1', itemArgs('u:2'))
    await owner('items.delete@1', { id: 'u:2' })
    await owner('config.set@1', { key: 'target_kcal', value: '1800' })

    const { status, body } = await getJson('/bot/v1/read')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.logDays).toBe(35)
    expect(body.weightDays).toBe(90)
    expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
    expect(Math.abs(Date.parse(body.serverTime) - Date.now())).toBeLessThan(10_000)
    expect(body.logs.map((l: { id: string }) => l.id).sort()).toEqual(['in', 'today'])
    expect(body.weights.map((w: { id: string }) => w.id)).toEqual(['w-in'])
    expect(body.stores.map((s: { id: string; deleted_at: string | null }) => [s.id, s.deleted_at !== null])).toEqual([['s:1', false], ['s:2', true]])
    expect(body.items.map((i: { id: string; deleted_at: string | null }) => [i.id, i.deleted_at !== null])).toEqual([['u:1', false], ['u:2', true]])
    expect(body.config).toMatchObject({ target_kcal: 1800, target_protein: 150, tdee: null, remind_meal_times: [] })
    // internal columns are not exposed
    for (const r of [body.logs[0], body.items[0], body.stores[0], body.weights[0], body.config]) {
      expect(r).not.toHaveProperty('user_id')
      expect(r).not.toHaveProperty('version')
    }
  })

  it('a user without a config row gets the defaults', async () => {
    const { body } = await getJson('/bot/v1/read')
    expect(body.config).toMatchObject({ target_kcal: 2000, target_protein: 150, target_fat: 60, target_carb: 200 })
  })
})

describe('GET /bot/v1/summary', () => {
  it('equals core summarizeDay on the same data (also replayed through the in-memory server), remaining may be negative', async () => {
    const d = day(1)
    const steps: Array<[string, unknown, 'owner' | 'kyujin']> = [
      ['config.set@1', { key: 'target_kcal', value: '500' }, 'owner'],
      ['config.set@1', { key: 'target_protein', value: '40' }, 'owner'],
      ['logs.add@1', { log: logOn('a', d, { kcal: 300.4, protein: 20.25 }) }, 'owner'],
      ['logs.add@1', { log: quickLogArgs('q', { day: d, ts: noon(d, '13:00'), kcal: 250, protein: 5 }) }, 'owner'],
      ['logs.add@1', { log: logOn('k', d, { item_id: '', name: '估算', src: '其他', qty: 1, kcal: 100, protein: 1.5, source: 'kyujin' }) }, 'kyujin'],
      ['logs.add@1', { log: logOn('gone', d, { kcal: 999 }) }, 'owner'],
      ['logs.delete@1', { id: 'gone' }, 'owner'],
      ['logs.add@1', { log: logOn('other-day', day(2), { kcal: 777 }) }, 'owner'],
    ]
    const mem = new MemoryServer({ now: Date.now })
    for (const [name, args, who] of steps) {
      if (who === 'owner') await owner(name, args)
      else expect((await bot(name, args)).status).toBe(200)
      const r = who === 'owner' ? await mem.mutate(name as never, args as never) : await mem.asKyujin(name as never, args as never)
      expect(r.ok, name).toBe(true)
    }
    const { status, body } = await getJson('/bot/v1/summary?day=' + d)
    expect(status).toBe(200)
    const expected = summarizeDay(mem.db.all('logs'), mem.db.all('config')[0] ?? defaultConfigRow(), d)
    const { ok, ...rest } = body
    expect(ok).toBe(true)
    expect(rest).toEqual(expected)
    expect(body.count).toBe(3)
    expect(body.totals.kcal).toBeCloseTo(650.4, 5)
    expect(body.remaining.kcal).toBeCloseTo(500 - 650.4, 5)
    expect(body.remaining.kcal).toBeLessThan(0)
  })

  it('defaults to today, and a bad day is a 400 bad_record', async () => {
    const { status, body } = await getJson('/bot/v1/summary')
    expect(status).toBe(200)
    expect(body.day).toBe(today)
    expect(body.count).toBe(0)
    for (const q of ['day=2026-13-40', 'day=yesterday', 'day=2026-10-1']) {
      const r = await getJson('/bot/v1/summary?' + q)
      expect(r.status, q).toBe(400)
      expect(r.body).toMatchObject({ ok: false, error: 'bad_record' })
    }
  })
})

describe('GET /bot/v1/trends', () => {
  it('equals core weekSummary on the same data; non-Mondays and bad dates are 400 bad_record', async () => {
    const monday = weekStart(day(8))
    const mem = new MemoryServer({ now: Date.now })
    await owner('config.set@1', { key: 'tdee', value: '2500' })
    await mem.mutate('config.set@1', { key: 'tdee', value: '2500' })
    for (let i = 0; i < 6; i++) {
      const d = addDays(monday, i)
      const args = { log: logOn('t' + i, d, { kcal: 1800 + i * 50, protein: 120 + i * 5 }) }
      await owner('logs.add@1', args)
      await mem.mutate('logs.add@1', args as never)
    }
    const { status, body } = await getJson('/bot/v1/trends?weekStart=' + monday)
    expect(status).toBe(200)
    const { ok, ...rest } = body
    expect(ok).toBe(true)
    expect(rest).toEqual(weekSummary(mem.db.all('logs'), mem.db.all('config')[0]!, today, monday))
    expect(rest.weekStart).toBe(monday)
    expect(rest.weekEnd).toBe(addDays(monday, 6))

    for (const q of [`weekStart=${addDays(monday, 1)}`, 'weekStart=2026-02-30', 'weekStart=nope', '']) {
      const r = await getJson('/bot/v1/trends?' + q)
      expect(r.status, q).toBe(400)
      expect(r.body).toMatchObject({ ok: false, error: 'bad_record' })
    }
  })
})

describe('GET /bot/v1/history', () => {
  const D0 = day(40)
  beforeEach(async () => {
    const mk = (table: string, extra: string) =>
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
         INSERT INTO ${table} ${extra}`,
      )
    await mk(
      'logs',
      `(id, user_id, day, ts, item_id, name, src, qty, grams, kcal, protein, fat, carb, source, store_id, version, deleted_at, updated_at)
       SELECT 'h' || i, ?1, date(?2, '-' || i || ' days'), date(?2, '-' || i || ' days') || 'T12:00:00+08:00', 'fm:1', 'x', '全家', 1, NULL, 100, 1, 1, 1, 'app', NULL, 1 + i,
              CASE WHEN i = 3 THEN 'x' END, 'x' FROM n`,
    ).bind(userId, D0).run()
    await mk(
      'weights',
      `(id, user_id, day, ts, kg, version, deleted_at, updated_at)
       SELECT 'hw' || i, ?1, date(?2, '-' || i || ' days'), date(?2, '-' || i || ' days') || 'T08:00:00+08:00', 70, 1 + i, NULL, 'x' FROM n`,
    ).bind(userId, D0).run()
  })

  it('newest first, default 35, hasMore, deleted rows included', async () => {
    const { status, body } = await getJson(`/bot/v1/history?table=logs&before=${addDays(D0, 1)}`)
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, table: 'logs', hasMore: true })
    expect(body.records).toHaveLength(35)
    expect(body.records[0].day).toBe(D0)
    expect(body.records[34].day).toBe(addDays(D0, -34))
    expect(body.records.map((r: { day: string }) => r.day)).toEqual([...body.records.map((r: { day: string }) => r.day)].sort().reverse())
    expect(body.records[3].deleted_at).not.toBeNull() // tombstones are history too
    expect(body.records[0]).not.toHaveProperty('user_id')
  })

  it('limit is capped at 90; the next page starts at before = the oldest day returned; the end says hasMore:false', async () => {
    let r = await getJson(`/bot/v1/history?table=logs&before=${addDays(D0, 1)}&limit=500`)
    expect(r.body.records).toHaveLength(90)
    expect(r.body.hasMore).toBe(true)
    const oldest = r.body.records[89].day
    r = await getJson(`/bot/v1/history?table=logs&before=${oldest}&limit=90`)
    expect(r.body.records).toHaveLength(10)
    expect(r.body.hasMore).toBe(false)
    r = await getJson(`/bot/v1/history?table=logs&before=${addDays(D0, 1)}&limit=100`)
    expect(r.body.records).toHaveLength(90)
    r = await getJson(`/bot/v1/history?table=logs&before=${addDays(D0, 1)}&limit=2`)
    expect(r.body.records).toHaveLength(2)
    expect(r.body.hasMore).toBe(true)
  })

  it('exactly limit rows left means hasMore false', async () => {
    const r = await getJson(`/bot/v1/history?table=logs&before=${addDays(D0, -89)}&limit=10`)
    expect(r.body.records).toHaveLength(10)
    expect(r.body.hasMore).toBe(false)
  })

  it('weights history works the same; day < before is strict', async () => {
    const r = await getJson(`/bot/v1/history?table=weights&before=${D0}`)
    expect(r.body.table).toBe('weights')
    expect(r.body.records[0].day).toBe(addDays(D0, -1))
    expect(r.body.records).toHaveLength(35)
  })

  it('bad parameters are 400 bad_record', async () => {
    for (const q of ['table=items&before=2026-10-01', 'table=logs', 'table=logs&before=10-01', 'table=logs&before=2026-10-01&limit=0', 'table=logs&before=2026-10-01&limit=x']) {
      const r = await getJson('/bot/v1/history?' + q)
      expect(r.status, q).toBe(400)
      expect(r.body).toMatchObject({ ok: false, error: 'bad_record' })
    }
  })
})

describe('POST /bot/v1/mutate', () => {
  it('envelope: success {ok:true,result}; business errors keep their code with the right status; duplicate_name carries details', async () => {
    const created = await bot('stores.upsert@1', storeArgs('s:k1', '阿財牛肉麵'))
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ ok: true, result: { rowId: 's:k1' } })
    const dup = await bot('stores.upsert@1', storeArgs('s:k2', ' 阿財 牛肉麵 '))
    expect(dup.status).toBe(409)
    expect(await dup.json()).toMatchObject({ ok: false, error: 'duplicate_name', details: { existingId: 's:k1', existingName: '阿財牛肉麵' } })
    const bad = await bot('weights.upsert@1', { id: 'w', day: day(1), ts: noon(day(1), '08:00'), kg: 5 })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ ok: false, error: 'bad_record' })
    const nf = await bot('logs.update@1', { id: 'nope', patch: { kcal: 1 } })
    expect(nf.status).toBe(403) // Kyujin: a row it cannot own is forbidden before it is not_found (Code.gs order)
    const notFound = await owner('logs.restore@1', { id: 'nope' })
    expect(notFound).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('idempotent by record id: resending the same weight / log / store is safe (duplicate, no second row)', async () => {
    const w = weightArgs('wk', 72.4, day(2))
    const a = await (await bot('weights.upsert@1', w)).json()
    const b = await (await bot('weights.upsert@1', w)).json()
    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true, result: { duplicate: true } })
    const l = { log: logOn('lk', day(2), { item_id: '', name: 'x', src: '其他', source: 'kyujin' }) }
    await bot('logs.add@1', l)
    expect(await (await bot('logs.add@1', l)).json()).toMatchObject({ ok: true, result: { duplicate: true } })
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM weights`).first<{ n: number }>())!.n).toBe(1)
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM logs`).first<{ n: number }>())!.n).toBe(1)
  })

  it('same-day weight overwrite reports prevKg; Kyujin rows are created_by / source = kyujin', async () => {
    await owner('stores.upsert@1', storeArgs('s:app', 'App 店'))
    await bot('weights.upsert@1', weightArgs('w1', 72, day(2)))
    const over = await (await bot('weights.upsert@1', weightArgs('w2', 71.5, day(2), '09:00'))).json()
    expect(over).toMatchObject({ ok: true, result: { overwritten: true, prevKg: 72 } })
    await bot('stores.upsert@1', storeArgs('s:kyu', 'Kyujin 店'))
    await bot('items.upsert@1', itemArgs('u:kyu', { store_id: 's:kyu' }))
    await bot('logs.add@1', { log: logOn('lk', day(2), { item_id: 'u:kyu', name: '牛肉麵', src: '其他', store_id: 's:kyu', source: 'kyujin' }) })
    const one = async (sql: string) => (await env.DB.prepare(sql).first<Record<string, unknown>>())!
    expect((await one(`SELECT created_by FROM stores WHERE id = 's:kyu'`)).created_by).toBe('kyujin')
    expect((await one(`SELECT created_by FROM stores WHERE id = 's:app'`)).created_by).toBe('app')
    expect((await one(`SELECT created_by FROM items WHERE id = 'u:kyu'`)).created_by).toBe('kyujin')
    expect((await one(`SELECT source FROM logs WHERE id = 'lk'`)).source).toBe('kyujin')
    // and what Kyujin wrote is immediately visible to the app's pull and to the summary
    const pulled = (await (await call('/sync/pull?clientId=app', { cookie })).json()) as { changes: { logs: Array<{ id: string; source: string }> } }
    expect(pulled.changes.logs.map((l) => [l.id, l.source])).toEqual([['lk', 'kyujin']])
    expect((await getJson('/bot/v1/summary?day=' + day(2))).body.count).toBe(1)
  })

  it('each call uses cursor+1 of the key\'s own client: ids are consecutive, device cursors of the app are untouched', async () => {
    await owner('weights.upsert@1', weightArgs('wa', 70, day(3)))
    for (let i = 0; i < 3; i++) expect((await bot('weights.upsert@1', weightArgs('wb' + i, 60 + i, day(10 + i)))).status).toBe(200)
    const rows = (await env.DB.prepare(`SELECT client_id, last_mutation_id FROM sync_clients ORDER BY client_id`).all<{ client_id: string; last_mutation_id: number }>()).results
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.client_id === 'api-owner')!.last_mutation_id).toBe(1)
    const botRow = rows.find((r) => r.client_id.startsWith('bot:'))!
    expect(botRow.last_mutation_id).toBe(3)
  })

  it('concurrent mutates: nobody is answered with another request\'s result, nothing is double applied', async () => {
    const send = (i: number) => bot('weights.upsert@1', weightArgs('wc' + i, 60 + i, day(20 + i)))
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => send(i)))
    let landed = 0
    for (const [i, r] of rs.entries()) {
      expect([200, 503]).toContain(r.status)
      if (r.status === 200) {
        landed++
        expect(await r.json()).toMatchObject({ ok: true, result: { rowId: 'wc' + i } }) // its OWN result, never a replay of another request's
      }
    }
    expect(landed).toBeGreaterThanOrEqual(1)
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM weights`).first<{ n: number }>())!.n).toBe(landed)
    // resend the 503s: they succeed
    for (const [i, r] of rs.entries()) if (r.status === 503) expect((await send(i)).status).toBe(200)
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM weights`).first<{ n: number }>())!.n).toBe(6)
  })

  it('malformed bodies are 400 bad_record', async () => {
    for (const json of [{}, { name: 'weights.upsert@1' }.valueOf(), { args: {} }, { name: '', args: {} }, { name: 5, args: {} }]) {
      const r = await call('/bot/v1/mutate', { method: 'POST', bearer: key, json })
      expect([400, 403], JSON.stringify(json)).toContain(r.status)
    }
    const bad = await call('/bot/v1/mutate', { method: 'POST', bearer: key, body: '{nope', headers: { 'content-type': 'application/json' } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ ok: false, error: 'bad_record' })
    // wrong args for a known name are bad_record from the mutation schema
    const wrong = await bot('weights.upsert@1', { id: 1 })
    expect(wrong.status).toBe(400)
  })
})

describe('GET /bot/v1/openapi.json', () => {
  it('documents the five endpoints with a Bearer security scheme', async () => {
    const { status, body } = await getJson('/bot/v1/openapi.json')
    expect(status).toBe(200)
    expect(body.openapi).toMatch(/^3\.1/)
    expect(Object.keys(body.paths).sort()).toEqual(['/history', '/mutate', '/read', '/summary', '/trends'])
    expect(body.components.securitySchemes.Bearer).toMatchObject({ type: 'http', scheme: 'bearer' })
    expect(body.paths['/mutate'].post.description).toContain('logs.add@1')
    expect(body.paths['/read'].get.responses['200'].content['application/json'].schema.properties.serverTime.description).toContain('+08:00')
    expect(JSON.stringify(body)).not.toContain(key)
  })
})
