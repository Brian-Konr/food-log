import { env } from 'cloudflare:workers'
import { MAX_PUSH_MUTATIONS, OWNER, processPush, pull } from '@food-log/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { D1Store } from '../src/db/d1-store.ts'
import { itemArgs, logArgs, mut, quickLogArgs, resetDb, seedUser, storeArgs, upsertWeight } from './helpers.ts'

// Workers free plan: 50 D1 queries per invocation. How many does a push / pull use?

type Fn = (...a: unknown[]) => unknown

/** Counts D1 round trips. `calls`: each first/all/run/batch is 1. `statements`: statements inside a batch counted one by one. */
function countingDb(db: D1Database) {
  const stats = { calls: 0, statements: 0 }
  const origin = new WeakMap<object, D1PreparedStatement>()
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p: D1PreparedStatement = new Proxy(s, {
      get(t, prop) {
        const v = (t as unknown as Record<string | symbol, unknown>)[prop]
        if (prop === 'bind') return (...a: unknown[]) => wrap((v as Fn).apply(t, a) as D1PreparedStatement)
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw')
          return (...a: unknown[]) => {
            stats.calls++
            stats.statements++
            return (v as Fn).apply(t, a)
          }
        return typeof v === 'function' ? (v as Fn).bind(t) : v
      },
    })
    origin.set(p, s)
    return p
  }
  const proxy = new Proxy(db, {
    get(t, prop) {
      if (prop === 'prepare') return (q: string) => wrap(t.prepare(q))
      if (prop === 'batch')
        return (stmts: D1PreparedStatement[]) => {
          stats.calls++
          stats.statements += stmts.length
          return t.batch(stmts.map((s) => origin.get(s) ?? s))
        }
      const v = (t as unknown as Record<string | symbol, unknown>)[prop]
      return typeof v === 'function' ? (v as Fn).bind(t) : v
    },
  }) as D1Database
  return { db: proxy, stats }
}

let userId: string
beforeEach(async () => {
  await resetDb()
  userId = await seedUser()
})

const ctx = { actor: OWNER, now: Date.now }
const SESSION_LOOKUP = 2 // the route spends up to ~2 queries on the session when the cookie cache is cold

describe('D1 query budget (free plan: 50 per invocation)', () => {
  it(`a full push of ${MAX_PUSH_MUTATIONS} weight upserts uses 32 calls (<= 50 with the session lookup)`, async () => {
    const { db, stats } = countingDb(env.DB)
    const mutations = Array.from({ length: MAX_PUSH_MUTATIONS }, (_, i) => upsertWeight(i + 1, 'q' + i, 60 + i, `2026-09-${String(i + 1).padStart(2, '0')}`))
    const out = await processPush(new D1Store(db).forUser(userId), ctx, { clientId: 'budget', mutations })
    expect(out.results.every((r) => r.ok)).toBe(true)
    // 1 cursor read + 1 begin batch + per mutation: 2 reads (get, liveWeightOnDay) + 1 commit batch
    // (the begin batch of every later mutation is skipped: version and cursor come from the previous commit, the guards verify them)
    expect(stats.calls).toBe(32)
    expect(stats.calls + SESSION_LOOKUP).toBeLessThan(50)
  })

  it('a typical offline flush (quick logs, logs of official items, a store log, weights, a delete) stays under 50', async () => {
    await processPush(new D1Store(env.DB).forUser(userId), ctx, {
      clientId: 'seed',
      mutations: [mut(1, 'stores.upsert@1', storeArgs('s:1', '店')), mut(2, 'items.upsert@1', itemArgs('u:1', { store_id: 's:1' })), upsertWeight(3, 'w0', 70, '2026-09-01')],
    })
    const { db, stats } = countingDb(env.DB)
    const mutations = [
      mut(1, 'logs.add@1', { log: quickLogArgs('q1') }),
      mut(2, 'logs.add@1', { log: quickLogArgs('q2') }),
      mut(3, 'logs.add@1', { log: logArgs('l3') }),
      mut(4, 'logs.add@1', { log: logArgs('l4', { item_id: 'u:1', name: '乳清', src: '其他', store_id: 's:1' }) }),
      mut(5, 'logs.add@1', { log: logArgs('l5', { item_id: 'u:1', name: '乳清', src: '其他', store_id: 's:1' }) }),
      mut(6, 'logs.update@1', { id: 'l3', patch: { qty: 2, kcal: 212 } }),
      upsertWeight(7, 'w1', 71, '2026-09-02'),
      mut(8, 'favorites.set@1', { item_id: 'fm:1', fav: true }),
      mut(9, 'logs.delete@1', { id: 'q2' }),
      mut(10, 'config.set@1', { key: 'target_kcal', value: '1900' }),
    ]
    const out = await processPush(new D1Store(db).forUser(userId), ctx, { clientId: 'flush', mutations })
    expect(out.results.map((r) => r.ok)).toEqual(Array(10).fill(true))
    expect(stats.calls + SESSION_LOOKUP).toBeLessThan(50)
  })

  it('replaying an already processed push costs one read per mutation (+1 for the cursor)', async () => {
    const mutations = Array.from({ length: 10 }, (_, i) => upsertWeight(i + 1, 'r' + i, 60 + i, `2026-08-${String(i + 1).padStart(2, '0')}`))
    await processPush(new D1Store(env.DB).forUser(userId), ctx, { clientId: 'dev', mutations })
    const { db, stats } = countingDb(env.DB)
    await processPush(new D1Store(db).forUser(userId), ctx, { clientId: 'dev', mutations })
    expect(stats.calls).toBeLessThanOrEqual(1 + 10 * 2)
  })

  it('pull is a handful of calls regardless of page size', async () => {
    const { db, stats } = countingDb(env.DB)
    await pull(new D1Store(db).forUser(userId), { cookie: '', clientId: 'c', afterMutationId: 0 }, { minClientVersion: 1 })
    expect(stats.calls).toBeLessThanOrEqual(6)
  })

  it('a CAS conflict clears the begin hint: the retry reads for real and still commits', async () => {
    const mine = new D1Store(env.DB).forUser(userId)
    await processPush(mine, ctx, { clientId: 'a', mutations: [upsertWeight(1, 'w1', 70, '2026-09-01')] })
    // another request commits between this instance's two mutations
    const store = new D1Store(env.DB).forUser(userId)
    const first = await processPush(store, ctx, { clientId: 'a', mutations: [upsertWeight(2, 'w2', 71, '2026-09-02')] })
    expect(first.results[0]!.ok).toBe(true)
    await processPush(new D1Store(env.DB).forUser(userId), ctx, { clientId: 'b', mutations: [upsertWeight(1, 'x1', 72, '2026-09-03')] })
    const next = await processPush(store, ctx, { clientId: 'a', mutations: [upsertWeight(3, 'w3', 73, '2026-09-04')] })
    expect(next.results[0]).toMatchObject({ ok: true })
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM weights`).first<{ n: number }>())!.n).toBe(4)
    expect((await env.DB.prepare(`SELECT value FROM meta WHERE key = 'version'`).first<{ value: number }>())!.value).toBe(4)
  })
})
