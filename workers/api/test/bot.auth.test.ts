// Kyujin key lifecycle (acceptance #4): unknown / revoked / disabled / expired -> 401 right away; scopes and actor -> 403.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../src/index.ts'
import type { Env } from '../src/env.ts'
import { ORIGIN, call, login, mintBotKey, resetDb } from './helpers.ts'

let userId: string
let cookie: string
beforeEach(async () => {
  await resetDb()
  ;({ userId, cookie } = await login())
})

const read = (bearer?: string, extra: Record<string, string> = {}) => call('/bot/v1/read', { bearer, headers: extra })
const ENDPOINTS: Array<[string, string, unknown?]> = [
  ['GET', '/bot/v1/read'],
  ['GET', '/bot/v1/summary'],
  ['GET', '/bot/v1/trends?weekStart=2026-10-05'],
  ['GET', '/bot/v1/history?table=logs&before=2026-10-01'],
  ['GET', '/bot/v1/openapi.json'],
  ['POST', '/bot/v1/mutate', { name: 'weights.upsert@1', args: {} }],
]

describe('401 unauthorized', () => {
  it('every endpoint answers 401 {ok:false,error:"unauthorized"} without a key, before looking at the request', async () => {
    for (const [method, path, json] of ENDPOINTS) {
      const res = await call(path, { method, json })
      expect(res.status, path).toBe(401)
      expect(await res.json(), path).toMatchObject({ ok: false, error: 'unauthorized' })
    }
  })

  it('an owner session cookie is not a bot credential', async () => {
    const res = await call('/bot/v1/read', { cookie })
    expect(res.status).toBe(401)
  })

  it('an unknown key, a wrong scheme, a malformed header and an x-api-key header are all 401', async () => {
    const { key } = await mintBotKey(userId)
    expect((await read('flk_' + 'x'.repeat(48))).status).toBe(401)
    expect((await read(key + 'x')).status).toBe(401)
    expect((await call('/bot/v1/read', { headers: { Authorization: 'Basic ' + key } })).status).toBe(401)
    expect((await call('/bot/v1/read', { headers: { Authorization: 'Bearer' } })).status).toBe(401)
    expect((await call('/bot/v1/read', { headers: { Authorization: 'Bearer a b' } })).status).toBe(401)
    expect((await call('/bot/v1/read', { headers: { 'x-api-key': key } })).status).toBe(401)
    expect((await read(key)).status).toBe(200)
  })

  it('the key works repeatedly (the plugin default of 10 requests per day is switched off)', async () => {
    const { key } = await mintBotKey(userId)
    for (let i = 0; i < 15; i++) expect((await read(key)).status, `request ${i}`).toBe(200)
  })
})

describe('revoking', () => {
  it('deleting the key row makes the very next request a 401', async () => {
    const { key, id } = await mintBotKey(userId)
    expect((await read(key)).status).toBe(200)
    await env.DB.prepare(`DELETE FROM apikey WHERE id = ?`).bind(id).run()
    const res = await read(key)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthorized' })
    const mutate = await call('/bot/v1/mutate', { method: 'POST', bearer: key, json: { name: 'weights.upsert@1', args: {} } })
    expect(mutate.status).toBe(401)
  })

  it('disabling the key (the soft revoke printed by scripts/bot-key.ts --revoke) is a 401 too', async () => {
    const { key, id } = await mintBotKey(userId)
    await env.DB.prepare(`UPDATE apikey SET enabled = 0 WHERE id = ?`).bind(id).run()
    expect((await read(key)).status).toBe(401)
  })

  it('rotation: the new key works, the old one is revoked, only the revoked one fails', async () => {
    const a = await mintBotKey(userId)
    const b = await mintBotKey(userId)
    await env.DB.prepare(`DELETE FROM apikey WHERE id = ?`).bind(a.id).run()
    expect((await read(a.key)).status).toBe(401)
    expect((await read(b.key)).status).toBe(200)
  })

  it('an expired key is a 401', async () => {
    const { key } = await mintBotKey(userId, { expiresAt: Date.now() - 1000 })
    expect((await read(key)).status).toBe(401)
  })

  it('only the SHA-256 hash is stored, never the key', async () => {
    const { key } = await mintBotKey(userId)
    const row = await env.DB.prepare(`SELECT * FROM apikey`).first<Record<string, unknown>>()
    expect(JSON.stringify(row)).not.toContain(key)
    expect(row!.key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(row!.permissions).toBe('{"foodlog":["read","write.kyujin"]}')
    expect(row!.metadata).toBe('{"actor":"kyujin"}')
  })
})

describe('403 forbidden (valid key, not allowed)', () => {
  it('a read-only key can read but not mutate', async () => {
    const { key } = await mintBotKey(userId, { permissions: { foodlog: ['read'] } })
    expect((await read(key)).status).toBe(200)
    const res = await call('/bot/v1/mutate', { method: 'POST', bearer: key, json: { name: 'weights.upsert@1', args: {} } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it('a write-only key can mutate but not read', async () => {
    const { key } = await mintBotKey(userId, { permissions: { foodlog: ['write.kyujin'] } })
    expect((await read(key)).status).toBe(403)
    const res = await call('/bot/v1/mutate', { method: 'POST', bearer: key, json: { name: 'weights.upsert@1', args: { id: 'w', day: '2026-10-11', ts: '2026-10-11T08:00:00+08:00', kg: 70 } } })
    expect(res.status).toBe(200)
  })

  it('a key without foodlog scopes, or without actor metadata, is refused', async () => {
    expect((await read((await mintBotKey(userId, { permissions: { other: ['read'] } })).key)).status).toBe(403)
    expect((await read((await mintBotKey(userId, { metadata: {} })).key)).status).toBe(403)
    expect((await read((await mintBotKey(userId, { metadata: { actor: 'app' } })).key)).status).toBe(403)
  })
})

describe('data scoping and configuration', () => {
  it('a key reads only its own user\'s data', async () => {
    const second = await login('second@example.com')
    await env.DB.prepare(
      `INSERT INTO weights (id, user_id, day, ts, kg, version, updated_at) VALUES ('w-owner', ?, '2026-10-10', '2026-10-10T08:00:00+08:00', 70, 1, 'x')`,
    ).bind(userId).run()
    const mine = await (await read((await mintBotKey(userId)).key)).json()
    const theirs = await (await read((await mintBotKey(second.userId)).key)).json()
    expect((mine as { weights: unknown[] }).weights.length).toBe(1)
    expect((theirs as { weights: unknown[] }).weights.length).toBe(0)
  })

  it('without APP_ORIGIN on a real hostname the bot API fails closed (500), like /sync and /api/auth', async () => {
    const { key } = await mintBotKey(userId)
    const res = await app.fetch(new Request('https://food-log.x.workers.dev/bot/v1/read', { headers: { Authorization: 'Bearer ' + key } }), { ...(env as unknown as Env), APP_ORIGIN: undefined })
    expect(res.status).toBe(500)
  })

  it('unknown /bot paths are a JSON 404 in the envelope (after auth)', async () => {
    const { key } = await mintBotKey(userId)
    const res = await call('/bot/v1/nope', { bearer: key })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('the Origin header is not needed for bearer calls', async () => {
    const { key } = await mintBotKey(userId)
    const res = await app.fetch(new Request(ORIGIN + '/bot/v1/read', { headers: { Authorization: 'Bearer ' + key } }), env as unknown as Env)
    expect(res.status).toBe(200)
  })
})
