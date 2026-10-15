import { env } from 'cloudflare:workers'
import { CLIENT_VERSION } from '@food-log/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../src/index.ts'
import type { Env } from '../src/env.ts'
import { ORIGIN, call, login, mut, resetDb, upsertWeight } from './helpers.ts'

let cookie: string
beforeEach(async () => {
  await resetDb()
  ;({ cookie } = await login())
})

const body = (...m: unknown[]) => ({ clientId: 'c1', mutations: m })

/** Run the worker with a different env (e.g. another MIN_CLIENT_VERSION). */
const hit = (over: Partial<Env>, path: string, init: { client?: string; json?: unknown; method?: string } = {}) => {
  const headers = new Headers({ Cookie: cookie, Origin: ORIGIN })
  if (init.client !== undefined) headers.set('X-FoodLog-Client', init.client)
  if (init.json !== undefined) headers.set('Content-Type', 'application/json')
  return app.fetch(new Request(ORIGIN + path, { method: init.method ?? 'GET', headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) }), { ...(env as unknown as Env), ...over })
}

describe('client version gate (409 client_too_old)', () => {
  it('missing, zero, non-numeric headers are too old; the current version is accepted', async () => {
    for (const client of [undefined, '0', 'abc', '', '1.5']) {
      const res = await call('/sync/push', { method: 'POST', cookie, json: body(), ...(client === undefined ? {} : { client }) })
      expect(res.status, String(client)).toBe(409)
      expect(await res.json()).toEqual({ error: 'client_too_old', minClientVersion: 1 })
    }
    expect((await call('/sync/push', { method: 'POST', cookie, client: String(CLIENT_VERSION), json: body() })).status).toBe(200)
  })

  it('with MIN_CLIENT_VERSION=3: 2 is too old (409 with the minimum), 3 and 4 are accepted; nothing is written by a rejected push', async () => {
    const old = await hit({ MIN_CLIENT_VERSION: '3' }, '/sync/push', { method: 'POST', client: '2', json: body(upsertWeight(1, 'w1', 70, '2026-10-11')) })
    expect(old.status).toBe(409)
    expect(await old.json()).toEqual({ error: 'client_too_old', minClientVersion: 3 })
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM weights`).first<{ n: number }>())!.n).toBe(0)
    for (const v of ['3', '4']) {
      const ok = await hit({ MIN_CLIENT_VERSION: '3' }, '/sync/push', { method: 'POST', client: v, json: body() })
      expect(ok.status, v).toBe(200)
    }
  })

  it('rollback switch: MIN_CLIENT_VERSION=9999 turns every push into a 409 and pull reports the minimum', async () => {
    const res = await hit({ MIN_CLIENT_VERSION: '9999' }, '/sync/push', { method: 'POST', client: String(CLIENT_VERSION), json: body() })
    expect(res.status).toBe(409)
    const pull = await hit({ MIN_CLIENT_VERSION: '9999' }, '/sync/pull?clientId=c1')
    expect(pull.status).toBe(200)
    expect(((await pull.json()) as { minClientVersion: number }).minClientVersion).toBe(9999)
  })

  it('a missing or nonsense MIN_CLIENT_VERSION falls back to 1', async () => {
    for (const v of [undefined, '', 'x', '0', '-2']) {
      const res = await hit({ MIN_CLIENT_VERSION: v }, '/sync/push', { method: 'POST', client: '1', json: body() })
      expect(res.status, String(v)).toBe(200)
    }
  })
})

describe('mutation versions (current and previous are accepted, unknown ones are business errors)', () => {
  it('@1 names work for a client at the minimum version; an unknown @2 / unversioned name is bad_record, never a 5xx', async () => {
    const res = await call('/sync/push', {
      method: 'POST',
      cookie,
      client: '1',
      json: body(upsertWeight(1, 'w1', 70, '2026-10-11'), mut(2, 'weights.upsert@2', {}), mut(3, 'weights.upsert', {})),
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { results: Array<{ ok: boolean; error?: string }> }
    expect(out.results.map((r) => r.ok)).toEqual([true, false, false])
    expect(out.results[1]!.error).toBe('bad_record')
    expect(out.results[2]!.error).toBe('bad_record')
  })
})
