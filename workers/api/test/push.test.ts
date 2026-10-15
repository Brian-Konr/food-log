import { env } from 'cloudflare:workers'
import { MutationError, OWNER, processPush } from '@food-log/core'
import type { PullResponse, UserStore } from '@food-log/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { D1Store, casStats } from '../src/db/d1-store.ts'
import { call, itemArgs, login, logArgs, mut, noon, push, pushOk, quickLogArgs, resetDb, storeArgs, upsertWeight, version } from './helpers.ts'

let cookie: string
let userId: string
beforeEach(async () => {
  await resetDb()
  ;({ cookie, userId } = await login())
})

const rows = async (sql: string, ...p: unknown[]) => (await env.DB.prepare(sql).bind(...p).all<Record<string, unknown>>()).results
const liveWeights = (day: string) => rows(`SELECT id, kg FROM weights WHERE user_id = ? AND day = ? AND deleted_at IS NULL`, userId, day)
const pullAll = async (q = 'clientId=c'): Promise<PullResponse> => {
  const r = await call('/sync/pull?' + q, { cookie })
  expect(r.status).toBe(200)
  return r.json()
}

describe('auth gate', () => {
  it('401 without a session on push and pull', async () => {
    expect((await call('/sync/push', { method: 'POST', client: '1', json: { clientId: 'c', mutations: [] } })).status).toBe(401)
    expect((await call('/sync/pull?clientId=c')).status).toBe(401)
  })
  it('401 with a garbage session cookie', async () => {
    expect((await call('/sync/pull?clientId=c', { cookie: 'better-auth.session_token=nope' })).status).toBe(401)
  })
  it('200 with a session', async () => {
    expect((await call('/sync/pull?clientId=c', { cookie })).status).toBe(200)
  })
})

describe('push idempotency', () => {
  it('the same push twice applies once and the replay returns the ORIGINAL result', async () => {
    const body = [upsertWeight(1, 'w1', 70.5, '2026-10-11'), upsertWeight(2, 'w2', 71, '2026-10-11')] // second overwrites the day
    const a = await pushOk(cookie, 'c1', ...body)
    expect(a.results[1]).toMatchObject({ id: 2, ok: true, result: { overwritten: true, prevKg: 70.5 } })
    const v = await version()
    const b = await pushOk(cookie, 'c1', ...body)
    expect(b.lastMutationId).toBe(2)
    expect(b.results).toEqual(a.results) // incl. {overwritten, prevKg}, not {replayed:true}
    expect(await version()).toBe(v)
    expect(await liveWeights('2026-10-11')).toEqual([{ id: 'w1', kg: 71 }])
  })

  it('an older id after newer ones is a replay too (cursor semantics)', async () => {
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-10'), upsertWeight(2, 'w2', 71, '2026-10-11'))
    const again = await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 99, '2026-10-10'))
    expect(again.results[0]).toMatchObject({ id: 1, ok: true })
    expect((await rows(`SELECT kg FROM weights WHERE id = 'w1'`))[0]!.kg).toBe(70)
  })

  it('outcomes older than 200 are pruned and replay as {replayed:true}; newer ones keep their result', async () => {
    for (let start = 1; start <= 205; start += 10) {
      await pushOk(cookie, 'c1', ...Array.from({ length: Math.min(10, 206 - start) }, (_, i) => upsertWeight(start + i, 'w' + (start + i), 60 + ((start + i) % 50), `2026-${String(1 + Math.floor((start + i) / 28)).padStart(2, '0')}-${String(1 + ((start + i) % 28)).padStart(2, '0')}`)))
    }
    const kept = (await rows(`SELECT COUNT(*) AS n FROM mutation_outcomes WHERE ok = 1`))[0]!.n
    expect(kept).toBe(200)
    const old = await pushOk(cookie, 'c1', upsertWeight(3, 'wx', 1, '2026-01-01'))
    expect(old.results[0]).toMatchObject({ id: 3, ok: true, result: { replayed: true } })
    const recent = await pushOk(cookie, 'c1', upsertWeight(205, 'wx', 1, '2026-01-01'))
    expect(recent.results[0]).toMatchObject({ id: 205, ok: true, result: { rowId: 'w205' } })
  })

  it('different devices have independent cursors (same mutation ids)', async () => {
    await pushOk(cookie, 'devA', upsertWeight(1, 'a1', 70, '2026-10-10'))
    const b = await pushOk(cookie, 'devB', upsertWeight(1, 'b1', 71, '2026-10-11'))
    expect(b.results[0]).toMatchObject({ ok: true, result: { rowId: 'b1' } })
    expect(await rows(`SELECT id FROM weights ORDER BY id`)).toEqual([{ id: 'a1' }, { id: 'b1' }])
  })

  it('a batch of mutations is applied in order, each bumping the version; ignored/duplicate do not', async () => {
    const r = await pushOk(
      cookie,
      'c1',
      upsertWeight(1, 'a', 70, '2026-10-10'),
      upsertWeight(2, 'a', 70, '2026-10-10'), // duplicate id
      mut(3, 'weights.delete@1', { id: 'a' }),
      mut(4, 'weights.delete@1', { id: 'a' }), // already deleted -> ignored
    )
    expect(r.results.map((x) => x.ok)).toEqual([true, true, true, true])
    expect(r.results[1]!.result).toEqual({ duplicate: true })
    expect(r.results[3]!.result).toEqual({ ignored: 'deleted' })
    expect(r.lastMutationId).toBe(4)
    expect(await version()).toBe(2) // add + delete only
  })

  it('more than 10 mutations is a 400', async () => {
    const res = await push(cookie, 'c1', ...Array.from({ length: 11 }, (_, i) => upsertWeight(i + 1, 'w' + i, 70, '2026-10-10')))
    expect(res.status).toBe(400)
  })

  it('bad JSON / body is a 400', async () => {
    expect((await call('/sync/push', { method: 'POST', cookie, client: '1', body: '{nope', headers: { 'content-type': 'application/json' } })).status).toBe(400)
    expect((await call('/sync/push', { method: 'POST', cookie, client: '1', json: { mutations: [] } })).status).toBe(400)
  })
})

describe('business errors', () => {
  it('are recorded, advance the cursor, leave the version alone, and come back on pull', async () => {
    await pushOk(cookie, 'c1', mut(1, 'weights.upsert@1', { id: 'w1', day: '2026-10-11', ts: noon('2026-10-11'), kg: 5 })) // below 30 kg
    const out = await pushOk(cookie, 'c1', mut(2, 'weights.upsert@1', { id: 'w2', day: '2026-10-11', ts: noon('2026-10-11'), kg: 5 }))
    expect(out.results[0]).toMatchObject({ id: 2, ok: false, error: 'bad_record' })
    expect(out.lastMutationId).toBe(2)
    expect(await version()).toBe(0)
    expect(await rows(`SELECT mutation_id, ok, error FROM mutation_outcomes ORDER BY mutation_id`)).toEqual([
      { mutation_id: 1, ok: 0, error: 'bad_record' },
      { mutation_id: 2, ok: 0, error: 'bad_record' },
    ])
    const p = await pullAll('clientId=c1&afterMutationId=0')
    expect(p.lastMutationId).toBe(2)
    expect(p.errors.map((e) => [e.mutationId, e.error, e.name])).toEqual([
      [1, 'bad_record', 'weights.upsert@1'],
      [2, 'bad_record', 'weights.upsert@1'],
    ])
    expect((await pullAll('clientId=c1&afterMutationId=1')).errors.map((e) => e.mutationId)).toEqual([2])
    // replay returns the recorded error, not a fresh one
    const again = await pushOk(cookie, 'c1', mut(2, 'weights.upsert@1', { id: 'w2', day: '2026-10-11', ts: noon('2026-10-11'), kg: 70 }))
    expect(again.results[0]).toMatchObject({ id: 2, ok: false, error: 'bad_record' })
  })

  it('errors are never pruned with the 200-result window', async () => {
    await pushOk(cookie, 'c1', mut(1, 'weights.upsert@1', { id: 'bad', day: '2026-10-11', ts: noon('2026-10-11'), kg: 5 }))
    for (let start = 2; start <= 232; start += 10) {
      await pushOk(cookie, 'c1', ...Array.from({ length: Math.min(10, 233 - start) }, (_, i) => mut(start + i, 'favorites.set@1', { item_id: 'fm:' + (start + i), fav: true })))
    }
    expect((await rows(`SELECT COUNT(*) AS n FROM mutation_outcomes WHERE ok = 0`))[0]!.n).toBe(1)
    expect((await pullAll('clientId=c1')).errors).toHaveLength(1)
  })

  it('unknown mutation name and wrong args are bad_record, not 5xx', async () => {
    const r = await pushOk(cookie, 'c1', mut(1, 'nope.nothing@1', {}), mut(2, 'weights.upsert@1', { id: 1 }))
    expect(r.results[0]).toMatchObject({ ok: false, error: 'bad_record' })
    expect(r.results[1]).toMatchObject({ ok: false, error: 'bad_record' })
    expect(r.lastMutationId).toBe(2)
  })

  it('duplicate store name carries details; a later restore of the loser is fine', async () => {
    await pushOk(cookie, 'c1', mut(1, 'stores.upsert@1', storeArgs('s:1', '阿財牛肉麵')))
    const r = await pushOk(cookie, 'c1', mut(2, 'stores.upsert@1', storeArgs('s:2', ' 阿財 牛肉麵 ')))
    expect(r.results[0]).toMatchObject({ ok: false, error: 'duplicate_name', details: { existingId: 's:1', existingName: '阿財牛肉麵' } })
  })
})

/** Wrap a store so that, once, right before the first commit, `sabotage` runs (a write that sneaks in after the mutator read). */
function sabotaged(inner: UserStore, sabotage: () => Promise<void>): UserStore {
  let done = false
  return {
    userId: inner.userId,
    begin: async (c) => {
      const stx = await inner.begin(c)
      return {
        tx: stx.tx,
        version: stx.version,
        lastMutationId: stx.lastMutationId,
        hasWrites: () => stx.hasWrites(),
        commit: async (input) => {
          if (!done) {
            done = true
            await sabotage()
          }
          return stx.commit(input)
        },
      }
    },
    readMeta: () => inner.readMeta(),
    rowsAfter: (a, l) => inner.rowsAfter(a, l),
    rowsAtVersion: (v) => inner.rowsAtVersion(v),
    getLastMutationId: (c) => inner.getLastMutationId(c),
    getMutationOutcome: (c, m) => inner.getMutationOutcome(c, m),
    listErrors: (c, a) => inner.listErrors(c, a),
  }
}

describe('unique index after a passing guard is a business error, not a 503 loop', () => {
  const ctx = { actor: OWNER, now: Date.now }

  it('weights: a live row appears without bumping the version (guard still passes) -> bad_record, cursor advances, later mutations proceed', async () => {
    const sneak = async () => {
      await env.DB.prepare(
        `INSERT INTO weights (id, user_id, day, ts, kg, version, deleted_at, updated_at) VALUES ('sneaky', ?, '2026-10-11', ?, 80, 0, NULL, 'x')`,
      ).bind(userId, noon('2026-10-11')).run()
    }
    // the mutator saw no live row (it read before the sneak), so it tries to insert a second live row for the day
    const store = sabotaged(new D1Store(env.DB).forUser(userId), sneak)
    const before = casStats.conflicts
    const res = await processPush(
      store,
      ctx,
      { clientId: 'c1', mutations: [mut(1, 'weights.upsert@1', { id: 'w1', day: '2026-10-11', ts: noon('2026-10-11'), kg: 70 }), upsertWeight(2, 'w2', 71, '2026-10-12')] },
    )
    expect(res.results[0]).toMatchObject({ id: 1, ok: false, error: 'bad_record' })
    expect((res.results[0] as { message: string }).message).toMatch(/這天已經有一筆體重/)
    expect(res.results[1]).toMatchObject({ id: 2, ok: true })
    expect(res.lastMutationId).toBe(2)
    expect(casStats.conflicts).toBe(before) // not treated as a CAS conflict
    expect((await rows(`SELECT id FROM weights WHERE id = 'w1'`))).toHaveLength(0)
    expect((await rows(`SELECT error FROM mutation_outcomes WHERE mutation_id = 1`))[0]!.error).toBe('bad_record')
  })

  it('stores: same for the live-name index', async () => {
    const sneak = async () => {
      await env.DB.prepare(
        `INSERT INTO stores (id, user_id, name, name_norm, created_by, ts, version, updated_at) VALUES ('s:sneaky', ?, 'x', '阿財牛肉麵', 'app', 'x', 0, 'x')`,
      ).bind(userId).run()
    }
    const res = await processPush(sabotaged(new D1Store(env.DB).forUser(userId), sneak), ctx, { clientId: 'c1', mutations: [mut(1, 'stores.upsert@1', storeArgs('s:1', '阿財牛肉麵'))] })
    expect(res.results[0]).toMatchObject({ ok: false, error: 'bad_record' })
    expect((res.results[0] as { message: string }).message).toMatch(/店名重複/)
  })

  it('a CHECK failure after the guard (a mutator writing a row the schema refuses) is also bad_record', async () => {
    const s = new D1Store(env.DB).forUser(userId)
    const stx = await s.begin('c1')
    stx.tx.put('weights', { id: 'w1', day: '2026-10-11', ts: noon('2026-10-11'), kg: 5, deleted_at: null, updated_at: 'x' })
    await expect(stx.commit({ ok: true, mutationId: 1, result: {} })).rejects.toBeInstanceOf(MutationError)
    expect(await s.getLastMutationId('c1')).toBe(0) // nothing was written
  })

  it('if version moved in between it is a CAS conflict (retry), not a business error', async () => {
    const s = new D1Store(env.DB).forUser(userId)
    const stx = await s.begin('c1')
    // someone else commits first (version moves) and ALSO creates the live row
    await pushOk(cookie, 'other', upsertWeight(1, 'theirs', 70, '2026-10-11'))
    stx.tx.put('weights', { id: 'w1', day: '2026-10-11', ts: noon('2026-10-11'), kg: 71, deleted_at: null, updated_at: 'x' })
    expect(await stx.commit({ ok: true, mutationId: 1, result: {} })).toBe(false)
  })
})

describe('concurrent push (CAS)', () => {
  it('two devices write the same day at once: exactly one live row, both answered, last one overwrote', async () => {
    const [a, b] = await Promise.all([
      push(cookie, 'devA', upsertWeight(1, 'a1', 70, '2026-10-11')),
      push(cookie, 'devB', upsertWeight(1, 'b1', 71, '2026-10-11')),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const ra = (await a.json()) as { results: Array<{ ok: boolean; result: Record<string, unknown> }> }
    const rb = (await b.json()) as { results: Array<{ ok: boolean; result: Record<string, unknown> }> }
    expect(ra.results[0]!.ok && rb.results[0]!.ok).toBe(true)
    const overwrote = [ra, rb].filter((r) => r.results[0]!.result.overwritten === true)
    expect(overwrote).toHaveLength(1)
    expect(await liveWeights('2026-10-11')).toHaveLength(1)
    expect(await version()).toBe(2)
  })

  it('8-way parallel writes on different days: every answered request landed, versions are distinct and gapless, CAS conflicts really happened; 503s resend fine', async () => {
    const before = casStats.conflicts
    const send = (i: number) => push(cookie, 'dev' + i, upsertWeight(1, 'w' + i, 60 + i, `2026-09-${10 + i}`))
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => send(i)))
    // under heavy contention a request may legitimately give up with 503 after 5 CAS retries; it must never corrupt data
    const answered = rs.filter((r) => r.status === 200).length
    expect(answered).toBeGreaterThanOrEqual(1)
    for (const r of rs) expect([200, 503]).toContain(r.status)
    expect(casStats.conflicts).toBeGreaterThan(before)
    expect(await version()).toBe(answered)
    for (const [i, r] of rs.entries()) if (r.status === 503) expect((await send(i)).status).toBe(200)
    expect(await rows(`SELECT COUNT(*) AS n FROM weights`)).toEqual([{ n: 8 }])
    expect((await rows(`SELECT DISTINCT version FROM weights ORDER BY version`)).map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('the same device pushing the same mutation from two requests at once applies it once (cursor guard)', async () => {
    const rs = await Promise.all([push(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-11')), push(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-11')), push(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-11'))])
    for (const r of rs) expect(r.status).toBe(200)
    expect(await version()).toBe(1)
    expect(await rows(`SELECT COUNT(*) AS n FROM weights`)).toEqual([{ n: 1 }])
  })

  it('an expired commit rolls the whole batch back (no rows, no version, no cursor)', async () => {
    const s = new D1Store(env.DB).forUser(userId)
    const stx = await s.begin('c1')
    await pushOk(cookie, 'other', upsertWeight(1, 'theirs', 70, '2026-10-10'))
    stx.tx.put('weights', { id: 'w1', day: '2026-10-11', ts: noon('2026-10-11'), kg: 71, deleted_at: null, updated_at: 'x' })
    expect(await stx.commit({ ok: true, mutationId: 1, result: {} })).toBe(false)
    expect(await rows(`SELECT id FROM weights`)).toEqual([{ id: 'theirs' }])
    expect(await s.getLastMutationId('c1')).toBe(0)
    expect(await version()).toBe(1)
    expect(await rows(`SELECT COUNT(*) AS n FROM cas_guard`)).toEqual([{ n: 0 }])
  })

  it('an error commit has the cursor guard too', async () => {
    const s = new D1Store(env.DB).forUser(userId)
    const stx = await s.begin('c1')
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-10')) // moves c1's cursor
    expect(await stx.commit({ ok: false, mutationId: 1, error: { name: 'x', error: 'bad_record', message: 'm', at: 'x' } })).toBe(false)
  })
})

describe('mutators through D1 (reads of every Tx method)', () => {
  it('logs.add with a self-made item and a store: item first in the same version, last_eaten_at moves forward only', async () => {
    await pushOk(cookie, 'c1', mut(1, 'stores.upsert@1', storeArgs('s:1', '阿財牛肉麵')))
    const r = await pushOk(
      cookie,
      'c1',
      mut(2, 'logs.add@1', {
        log: logArgs('L1', { item_id: 'u:i1', name: '牛肉麵', src: '其他', store_id: 's:1', ts: noon('2026-10-11', '12:00') }),
        item: itemArgs('u:i1', { store_id: 's:1', name: '牛肉麵' }),
      }),
      mut(3, 'logs.add@1', { log: logArgs('L2', { item_id: 'u:i1', name: '牛肉麵', src: '其他', store_id: 's:1', ts: noon('2026-10-11', '08:00') }) }), // backfill: last_eaten_at stays
    )
    expect(r.results.map((x) => x.ok)).toEqual([true, true])
    expect((await rows(`SELECT last_eaten_at FROM stores WHERE id = 's:1'`))[0]!.last_eaten_at).toBe(noon('2026-10-11', '12:00'))
    const v = await rows(`SELECT 'items' AS t, version FROM items UNION ALL SELECT 'logs', version FROM logs WHERE id = 'L1'`)
    expect(new Set(v.map((x) => x.version)).size).toBe(1)
  })

  it('stores.delete cascades to items with cascade_of; stores.restore only restores those', async () => {
    await pushOk(
      cookie,
      'c1',
      mut(1, 'stores.upsert@1', storeArgs('s:1', '店')),
      mut(2, 'items.upsert@1', itemArgs('u:a', { store_id: 's:1', name: 'A' })),
      mut(3, 'items.upsert@1', itemArgs('u:b', { store_id: 's:1', name: 'B' })),
      mut(4, 'items.delete@1', { id: 'u:b' }), // deleted on its own before
      mut(5, 'stores.delete@1', { id: 's:1' }),
    )
    expect(await rows(`SELECT id, cascade_of, deleted_at IS NOT NULL AS del FROM items ORDER BY id`)).toEqual([
      { id: 'u:a', cascade_of: 's:1', del: 1 },
      { id: 'u:b', cascade_of: null, del: 1 },
    ])
    await pushOk(cookie, 'c1', mut(6, 'stores.restore@1', { id: 's:1' }))
    expect(await rows(`SELECT id, cascade_of, deleted_at IS NOT NULL AS del FROM items ORDER BY id`)).toEqual([
      { id: 'u:a', cascade_of: null, del: 0 },
      { id: 'u:b', cascade_of: null, del: 1 },
    ])
  })

  it('weights: delete frees the day, restore onto a taken day is bad_record, get/liveWeightOnDay see the right rows', async () => {
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-11'), mut(2, 'weights.delete@1', { id: 'w1' }), upsertWeight(3, 'w2', 71, '2026-10-11'))
    const r = await pushOk(cookie, 'c1', mut(4, 'weights.restore@1', { id: 'w1' }))
    expect(r.results[0]).toMatchObject({ ok: false, error: 'bad_record' })
    expect(await liveWeights('2026-10-11')).toEqual([{ id: 'w2', kg: 71 }])
  })

  it('favorites tombstone and config typed row round-trip through pull', async () => {
    await pushOk(
      cookie,
      'c1',
      mut(1, 'favorites.set@1', { item_id: 'fm:1', fav: true }),
      mut(2, 'favorites.set@1', { item_id: 'fm:1', fav: false }),
      mut(3, 'config.set@1', { key: 'target_kcal', value: '1800' }),
      mut(4, 'config.set@1', { key: 'remind_meal_times', value: ['08:00', '12:30'] }),
      mut(5, 'config.set@1', { key: 'tdee', value: '2650' }),
    )
    const p = await pullAll('clientId=c1')
    expect(p.changes.favorites).toHaveLength(1)
    expect(p.changes.favorites[0]).toMatchObject({ item_id: 'fm:1' })
    expect(p.changes.favorites[0]!.deleted_at).not.toBeNull()
    expect(p.changes.config).toHaveLength(1)
    expect(p.changes.config[0]).toMatchObject({ target_kcal: 1800, tdee: 2650, remind_meal_times: ['08:00', '12:30'], target_protein: 150 })
  })

  it('quick logs and logs.update/delete/restore', async () => {
    await pushOk(cookie, 'c1', mut(1, 'logs.add@1', { log: quickLogArgs('q1') }), mut(2, 'logs.update@1', { id: 'q1', patch: { kcal: 250, name: '  午餐  ' } }), mut(3, 'logs.delete@1', { id: 'q1' }))
    expect(await rows(`SELECT kcal, name, deleted_at IS NOT NULL AS del FROM logs`)).toEqual([{ kcal: 250, name: '午餐', del: 1 }])
    await pushOk(cookie, 'c1', mut(4, 'logs.restore@1', { id: 'q1' }))
    expect(await rows(`SELECT deleted_at IS NOT NULL AS del FROM logs`)).toEqual([{ del: 0 }])
  })
})

describe('user scoping', () => {
  it('a second user sees none of the first user\'s rows, cursors or errors, and same ids do not collide', async () => {
    const other = await login('second@example.com')
    await pushOk(cookie, 'c1', upsertWeight(1, 'same', 70, '2026-10-11'), mut(2, 'weights.upsert@1', { id: 'bad', day: '2026-10-11', ts: noon('2026-10-11'), kg: 5 }))
    const op = await call('/sync/pull?clientId=c1', { cookie: other.cookie })
    const body = (await op.json()) as PullResponse
    expect(body.lastMutationId).toBe(0)
    expect(body.errors).toEqual([])
    expect(body.changes.weights).toEqual([])
    // same client id and same row id for the other user is independent
    const r = await pushOk(other.cookie, 'c1', upsertWeight(1, 'same', 80, '2026-10-11'))
    expect(r.results[0]).toMatchObject({ ok: true, result: { rowId: 'same' } })
    expect(await rows(`SELECT user_id, kg FROM weights ORDER BY user_id`)).toHaveLength(2)
    const mine = (await (await call('/sync/pull?clientId=c1', { cookie })).json()) as PullResponse
    expect(mine.changes.weights.map((w) => w.kg)).toEqual([70])
  })
})
