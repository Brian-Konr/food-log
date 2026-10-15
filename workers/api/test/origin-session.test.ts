import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { COOKIE_CACHE_SECONDS, getAuth, resolveOrigin } from '../src/auth.ts'
import { app } from '../src/index.ts'
import type { Env } from '../src/env.ts'
import { call, login, resetDb } from './helpers.ts'

beforeEach(resetDb)

/** Hit the worker with a different env (e.g. without APP_ORIGIN) on an arbitrary host. */
const hit = (url: string, over: Partial<Env>, init: RequestInit = {}) =>
  app.fetch(new Request(url, init), { ...(env as unknown as Env), ...over })

describe('APP_ORIGIN (fail closed)', () => {
  it('resolveOrigin: APP_ORIGIN wins and is normalised; only loopback hosts may fall back to the request', () => {
    expect(resolveOrigin({ APP_ORIGIN: 'https://food-log.x.workers.dev/some/path' }, 'https://evil.example/a')).toBe('https://food-log.x.workers.dev')
    expect(resolveOrigin({}, 'http://localhost:8787/api/health')).toBe('http://localhost:8787')
    expect(resolveOrigin({}, 'http://127.0.0.1:8787/x')).toBe('http://127.0.0.1:8787')
    expect(resolveOrigin({}, 'http://[::1]:8787/x')).toBe('http://[::1]:8787')
    expect(resolveOrigin({}, 'https://food-log.x.workers.dev/x')).toBeNull()
    expect(resolveOrigin({}, 'https://localhost.evil.example/x')).toBeNull()
    expect(resolveOrigin({ APP_ORIGIN: 'not a url' }, 'http://localhost:8787/x')).toBeNull()
  })

  it('without APP_ORIGIN on a real hostname: /api/auth/* and /sync/* answer 500, /api/health still works', async () => {
    const auth = await hit('https://food-log.x.workers.dev/api/auth/get-session', { APP_ORIGIN: undefined })
    expect(auth.status).toBe(500)
    expect(await auth.json()).toEqual({ error: 'APP_ORIGIN not configured' })
    const login_ = await hit('https://food-log.x.workers.dev/api/auth/login-code/redeem', { APP_ORIGIN: undefined }, { method: 'POST', body: '{"code":"AAAA-BBBB-CCCC"}', headers: { 'content-type': 'application/json' } })
    expect(login_.status).toBe(500)
    const sync = await hit('https://food-log.x.workers.dev/sync/pull?clientId=c', { APP_ORIGIN: undefined })
    expect(sync.status).toBe(500)
    expect(await sync.json()).toEqual({ error: 'APP_ORIGIN not configured' })
    expect((await hit('https://food-log.x.workers.dev/api/health', { APP_ORIGIN: undefined })).status).toBe(200)
  })

  it('without APP_ORIGIN on localhost (wrangler dev): auth works, derived from the request', async () => {
    const gs = await hit('http://localhost:8787/api/auth/get-session', { APP_ORIGIN: undefined })
    expect(gs.status).toBe(200)
    expect((await hit('http://localhost:8787/sync/pull?clientId=c', { APP_ORIGIN: undefined })).status).toBe(401)
  })

  it('with APP_ORIGIN set, the Host of the request is irrelevant', async () => {
    expect((await hit('https://whatever.example/sync/pull?clientId=c', {})).status).toBe(401) // configured: normal auth gate
  })
})

describe('getAuth cache', () => {
  it('is a single instance keyed on the full config: same config -> same object, any change -> a new one', () => {
    const e = env as unknown as Env
    const a = getAuth(e, 'https://food-log.test')
    expect(getAuth(e, 'https://food-log.test')).toBe(a)
    expect(getAuth({ ...e }, 'https://food-log.test')).toBe(a) // a fresh env object with the same values still hits
    const b = getAuth(e, 'https://other.test')
    expect(b).not.toBe(a)
    const c = getAuth({ ...e, ALLOWED_EMAILS: 'x@example.com' }, 'https://food-log.test')
    expect(c).not.toBe(a)
    const d = getAuth({ ...e, BETTER_AUTH_SECRET: 'another-secret-another-secret-0123456789' }, 'https://food-log.test')
    expect(d).not.toBe(c)
    // many different hosts do not accumulate: going back re-creates (one slot), results stay correct
    for (let i = 0; i < 50; i++) getAuth(e, `https://h${i}.test`)
    expect(getAuth(e, 'https://food-log.test')).not.toBe(a)
    expect(getAuth(e, 'https://food-log.test')).toBe(getAuth(e, 'https://food-log.test'))
  })
})

describe('session cookie cache', () => {
  const sessionCount = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM session`).first<{ n: number }>())!.n
  const only = (cookie: string, name: string) =>
    cookie
      .split('; ')
      .filter((c) => c.includes(name))
      .join('; ')

  it('login hands out a signed session_data cookie', async () => {
    const { cookie } = await login()
    expect(cookie).toMatch(/session_data=/)
    expect(COOKIE_CACHE_SECONDS).toBe(300)
  })

  it('/sync/* is served from the cookie cache: a valid cache cookie works even with the session row gone (<= 5 min staleness)', async () => {
    const { cookie } = await login()
    await env.DB.prepare(`DELETE FROM session`).run()
    expect(await sessionCount()).toBe(0)
    expect((await call('/sync/pull?clientId=c', { cookie })).status).toBe(200) // no D1 lookup needed
  })

  it('without the cache cookie the session is looked up in D1 and refills the cache (Set-Cookie)', async () => {
    const { cookie } = await login()
    const tokenOnly = only(cookie, 'session_token')
    expect(tokenOnly).not.toMatch(/session_data/)
    const r = await call('/sync/pull?clientId=c', { cookie: tokenOnly })
    expect(r.status).toBe(200)
    const set = r.headers.getSetCookie().find((c) => c.includes('session_data='))
    expect(set).toBeDefined()
    expect(set).toMatch(/Max-Age=300/i)
    // and the refilled cookie is accepted on its own with the token, again without D1
    const refilled = tokenOnly + '; ' + set!.split(';')[0]
    await env.DB.prepare(`DELETE FROM session`).run()
    expect((await call('/sync/pull?clientId=c', { cookie: refilled })).status).toBe(200)
  })

  it('401 stays: deleted session + no cache cookie', async () => {
    const { cookie } = await login()
    await env.DB.prepare(`DELETE FROM session`).run()
    expect((await call('/sync/pull?clientId=c', { cookie: only(cookie, 'session_token') })).status).toBe(401)
  })

  it('401 stays: expired session (row expired, no cache cookie)', async () => {
    const { cookie } = await login()
    await env.DB.prepare(`UPDATE session SET expires_at = ?`).bind(Date.now() - 1000).run()
    expect((await call('/sync/pull?clientId=c', { cookie: only(cookie, 'session_token') })).status).toBe(401)
    expect((await call('/sync/push', { method: 'POST', cookie: only(cookie, 'session_token'), client: '1', json: { clientId: 'c', mutations: [] } })).status).toBe(401)
  })

  it('401 stays: a forged / tampered cache cookie is ignored and the (now missing) session decides', async () => {
    const { cookie } = await login()
    await env.DB.prepare(`DELETE FROM session`).run()
    const token = only(cookie, 'session_token')
    const name = cookie.split('; ').find((c) => c.includes('session_data='))!.split('=')[0]!
    expect((await call('/sync/pull?clientId=c', { cookie: token + '; ' + name + '=eyJmb3JnZWQiOnRydWV9.AAAA' })).status).toBe(401)
    // a malformed (not even base64) cache cookie must be a 401, never a 500
    expect((await call('/sync/pull?clientId=c', { cookie: token + '; ' + name + '=%%%not-base64.%%%' })).status).toBe(401)
    // a cache cookie without any session token is useless
    expect((await call('/sync/pull?clientId=c', { cookie: only(cookie, 'session_data') })).status).toBe(401)
  })

  it('a malformed cache cookie next to a VALID session token still authenticates (falls back to D1)', async () => {
    const { cookie } = await login()
    const name = cookie.split('; ').find((c) => c.includes('session_data='))!.split('=')[0]!
    expect((await call('/sync/pull?clientId=c', { cookie: only(cookie, 'session_token') + '; ' + name + '=%%%not-base64' })).status).toBe(200)
  })

  it('401 stays: garbage and missing cookies', async () => {
    expect((await call('/sync/pull?clientId=c', { cookie: 'better-auth.session_token=nope; better-auth.session_data=nope' })).status).toBe(401)
    expect((await call('/sync/pull?clientId=c')).status).toBe(401)
  })
})
