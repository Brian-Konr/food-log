// Own test file on purpose: vitest isolates module state per file, so nothing here ran before the module-load construction.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { authFor, authStats, getAuth } from '../src/auth.ts'
import type { Env } from '../src/env.ts'
import { call, login, resetDb } from './helpers.ts'

const e = env as unknown as Env

describe('auth instance is built once per isolate (global scope, not request CPU)', () => {
  it('exactly one instance exists at import time, before any request ran', () => {
    expect(authStats.created).toBe(1)
  })

  it('login, session, sync, bot and auth routes never construct another; the request host is irrelevant', async () => {
    await resetDb()
    const startup = authFor(e, 'https://whatever.example/x')! // APP_ORIGIN is set: lookup only
    expect(authStats.created).toBe(1)
    const { cookie } = await login()
    for (let i = 0; i < 5; i++) {
      expect((await call('/api/auth/get-session', { cookie })).status).toBe(200)
      expect((await call('/sync/pull?clientId=c', { cookie })).status).toBe(200)
      expect((await call('/bot/v1/read')).status).toBe(401)
    }
    expect(authStats.created).toBe(1)
    expect(authFor(e, 'https://food-log.test/api/auth/get-session')).toBe(startup)
    expect(getAuth(e, 'https://food-log.test')).toBe(startup)
  })

  it('a request env with a different config rebuilds the single slot lazily (tests / localhost dev); fail-closed stays null', () => {
    const startup = authFor(e, 'https://x.example/')!
    const dev = authFor({ ...e, APP_ORIGIN: undefined }, 'http://localhost:8787/api/auth/get-session')!
    expect(dev).not.toBe(startup)
    expect(authStats.created).toBe(2)
    expect(authFor({ ...e, APP_ORIGIN: undefined }, 'http://localhost:8787/other')).toBe(dev) // still one build for that config
    expect(authFor({ ...e, APP_ORIGIN: undefined }, 'https://food-log.x.workers.dev/')).toBeNull() // no origin, not loopback
    expect(authStats.created).toBe(2)
  })
})
