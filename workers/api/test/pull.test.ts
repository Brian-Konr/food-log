import { env } from 'cloudflare:workers'
import { OWNER, processPush, pull } from '@food-log/core'
import type { PullResponse, UserStore } from '@food-log/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { D1Store } from '../src/db/d1-store.ts'
import { call, login, mut, noon, pushOk, resetDb, upsertWeight } from './helpers.ts'

let cookie: string
let userId: string
beforeEach(async () => {
  await resetDb()
  ;({ cookie, userId } = await login())
})

const get = async (q: string): Promise<PullResponse> => {
  const r = await call('/sync/pull?' + q, { cookie })
  expect(r.status).toBe(200)
  return r.json()
}
const count = (p: PullResponse) => Object.values(p.changes).reduce((n, rows) => n + rows.length, 0)

/** n logs with versions firstVersion .. firstVersion+n-1 (one row per version), straight into D1 (fast), meta.version moved up. */
async function seedLogs(n: number, opts: { firstVersion?: number; sameVersion?: boolean; user?: string } = {}) {
  const first = opts.firstVersion ?? 1
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
     INSERT INTO logs (id, user_id, day, ts, item_id, name, src, qty, grams, kcal, protein, fat, carb, source, store_id, version, deleted_at, updated_at)
     SELECT 'seed-' || i, ?2, '2026-10-11', ?3, 'fm:1', 'x', '全家', 1, NULL, 100, 1, 1, 1, 'app', NULL, ${opts.sameVersion ? '?4' : '?4 + i'}, NULL, 'x' FROM n`,
  )
    .bind(n - 1, opts.user ?? userId, noon('2026-10-11'), first)
    .run()
  await env.DB.prepare(`UPDATE meta SET value = ? WHERE key = 'version'`).bind(opts.sameVersion ? first : first + n - 1).run()
}

describe('pull paging', () => {
  it('cookie=0 on an empty database: one empty page with the epoch cookie', async () => {
    const p = await get('clientId=c')
    expect(p).toMatchObject({ cookie: 'e1:0', more: false, reset: false, lastMutationId: 0, minClientVersion: 1, errors: [] })
    expect(count(p)).toBe(0)
  })

  it('4500 rows page as 2000 / 2000 / 500 with a monotonically increasing cookie, each row exactly once', async () => {
    await seedLogs(4500)
    const seen = new Set<string>()
    let cookieQ = ''
    const sizes: number[] = []
    for (let i = 0; i < 10; i++) {
      const p = await get('clientId=c&cookie=' + encodeURIComponent(cookieQ))
      sizes.push(p.changes.logs.length)
      for (const l of p.changes.logs) {
        expect(seen.has(l.id)).toBe(false)
        seen.add(l.id)
      }
      cookieQ = p.cookie
      if (!p.more) break
    }
    expect(sizes).toEqual([2000, 2000, 500])
    expect(seen.size).toBe(4500)
    expect(cookieQ).toBe('e1:4500')
    // up to date: nothing more
    const again = await get('clientId=c&cookie=' + cookieQ)
    expect(count(again)).toBe(0)
    expect(again.more).toBe(false)
  })

  it('rows are ordered by version across tables and a page never splits one version', async () => {
    // versions 1..3: a mutation touching several tables shares one version
    await pushOk(
      cookie,
      'c1',
      mut(1, 'stores.upsert@1', { id: 's:1', name: '店' }),
      mut(2, 'items.upsert@1', { id: 'u:a', kind: '自建', src: '其他', name: 'A', serving: '1', kcal: 1, protein: 1, fat: 1, carb: 1, store_id: 's:1' }),
      mut(3, 'stores.delete@1', { id: 's:1' }), // store + cascaded item share version 3
    )
    const p = await get('clientId=c1')
    const versions = [...p.changes.stores, ...p.changes.items].map((r) => r.version)
    expect(Math.max(...versions)).toBe(3)
    expect(p.changes.stores.map((s) => s.version)).toEqual([3])
    expect(p.changes.items.map((i) => i.version)).toEqual([3])
    expect(p.cookie).toBe('e1:3')
  })

  it('a single version bigger than a page is delivered whole (never cut in the middle)', async () => {
    await seedLogs(2600, { sameVersion: true, firstVersion: 5 })
    await env.DB.prepare(`INSERT INTO weights (id, user_id, day, ts, kg, version, updated_at) VALUES ('later', ?, '2026-10-10', ?, 70, 6, 'x')`).bind(userId, noon('2026-10-10')).run()
    await env.DB.prepare(`UPDATE meta SET value = 6 WHERE key = 'version'`).run()
    const p1 = await get('clientId=c')
    expect(p1.changes.logs).toHaveLength(2600)
    expect(p1.more).toBe(true)
    expect(p1.cookie).toBe('e1:5')
    const p2 = await get('clientId=c&cookie=' + p1.cookie)
    expect(p2.changes.weights.map((w) => w.id)).toEqual(['later'])
    expect(p2.more).toBe(false)
  })

  it('tombstones come along (deleted_at set) and favorites/config are carried', async () => {
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-11'), mut(2, 'weights.delete@1', { id: 'w1' }), mut(3, 'favorites.set@1', { item_id: 'fm:1', fav: true }), mut(4, 'config.set@1', { key: 'target_kcal', value: '1900' }))
    const p = await get('clientId=c2')
    expect(p.changes.weights).toHaveLength(1)
    expect(p.changes.weights[0]!.deleted_at).not.toBeNull()
    expect(p.changes.favorites.map((f) => f.item_id)).toEqual(['fm:1'])
    expect(p.changes.config[0]!.target_kcal).toBe(1900)
    // incremental: from the cookie of that page only newer versions come
    await pushOk(cookie, 'c1', mut(5, 'favorites.set@1', { item_id: 'fm:1', fav: false }))
    const inc = await get('clientId=c2&cookie=' + p.cookie)
    expect(inc.changes.favorites).toHaveLength(1)
    expect(inc.changes.favorites[0]!.deleted_at).not.toBeNull()
    expect(count(inc)).toBe(1)
  })
})

describe('epoch / cookie edge cases', () => {
  it('a different epoch (restore / re-import) answers reset:true and restarts from version 0', async () => {
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-11'))
    const first = await get('clientId=c1')
    await env.DB.prepare(`UPDATE meta SET value = 'e2' WHERE key = 'epoch'`).run()
    const p = await get('clientId=c1&cookie=' + encodeURIComponent(first.cookie))
    expect(p.reset).toBe(true)
    expect(p.cookie).toBe('e2:1')
    expect(p.changes.weights).toHaveLength(1) // everything again
    const next = await get('clientId=c1&cookie=' + p.cookie)
    expect(next.reset).toBe(false)
    expect(count(next)).toBe(0)
  })

  it('a cookie ahead of the server (restored older backup) is a reset too', async () => {
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-11'))
    const p = await get('clientId=c1&cookie=e1:99')
    expect(p.reset).toBe(true)
    expect(p.changes.weights).toHaveLength(1)
  })

  it('garbage / empty / "0" cookies start from the beginning without reset', async () => {
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-11'))
    for (const c of ['', '0', 'garbage', 'e1:abc', 'e1:-3']) {
      const p = await get('clientId=c1&cookie=' + encodeURIComponent(c))
      expect(p.reset, c).toBe(false)
      expect(p.changes.weights, c).toHaveLength(1)
    }
  })

  it('clientId is required', async () => {
    expect((await call('/sync/pull', { cookie })).status).toBe(400)
  })
})

describe('cursor-first read order (a response never claims a mutation whose rows it does not carry)', () => {
  /** Wrap a store: right after the n-th read call finishes, another request commits mutation `next` for the same client. */
  function interleaved(inner: UserStore, afterOp: 'getLastMutationId' | 'listErrors' | 'readMeta' | 'rowsAfter', inject: () => Promise<void>): UserStore {
    let fired = false
    const hook = async <T>(op: string, p: Promise<T>): Promise<T> => {
      const v = await p
      if (op === afterOp && !fired) {
        fired = true
        await inject()
      }
      return v
    }
    return {
      userId: inner.userId,
      begin: (c) => inner.begin(c),
      readMeta: () => hook('readMeta', inner.readMeta()),
      rowsAfter: (a, l) => hook('rowsAfter', inner.rowsAfter(a, l)),
      rowsAtVersion: (v) => inner.rowsAtVersion(v),
      getLastMutationId: (c) => hook('getLastMutationId', inner.getLastMutationId(c)),
      getMutationOutcome: (c, m) => inner.getMutationOutcome(c, m),
      listErrors: (c, a) => hook('listErrors', inner.listErrors(c, a)),
    }
  }

  it.each(['getLastMutationId', 'listErrors', 'readMeta', 'rowsAfter'] as const)('a push committed right after the %s read keeps the invariant', async (afterOp) => {
    await pushOk(cookie, 'c1', upsertWeight(1, 'w1', 70, '2026-10-10'))
    const base = new D1Store(env.DB).forUser(userId)
    const inject = async () => {
      await processPush(base, { actor: OWNER, now: Date.now }, { clientId: 'c1', mutations: [upsertWeight(2, 'w2', 71, '2026-10-11')] })
    }
    const p = await pull(interleaved(base, afterOp, inject), { cookie: '', clientId: 'c1', afterMutationId: 0 }, { minClientVersion: 1 })
    const ids = p.changes.weights.map((w) => w.id)
    // the invariant: lastMutationId = 2 is only ever reported together with w2's row
    if (p.lastMutationId >= 2) expect(ids).toContain('w2')
    expect(p.lastMutationId).toBe(1) // cursor is read first, before the injected push
    // and the next pull catches up fully
    const next = await get('clientId=c1&cookie=' + encodeURIComponent(p.cookie))
    expect(next.lastMutationId).toBe(2)
    const all = new Set([...ids, ...next.changes.weights.map((w) => w.id)])
    expect([...all].sort()).toEqual(['w1', 'w2'])
  })
})
