// Own test file on purpose: vitest isolates module state per file.
// No counter lives in production code. Construction is observed from outside:
//   - startup tests re-import src/auth.ts in a fresh module graph with betterAuth wrapped by vi.mock (the real constructor runs);
//   - request tests spy on drizzle() (createAuth calls it exactly once per betterAuth()) in the module graph the Worker really uses.
import { env } from 'cloudflare:workers'
import * as d1 from 'drizzle-orm/d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authFor, getAuth } from '../src/auth.ts'
import type { Env } from '../src/env.ts'
import { call, login, resetDb } from './helpers.ts'

vi.mock('better-auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('better-auth')>()
  return { ...real, betterAuth: vi.fn(real.betterAuth) }
})

const e = env as unknown as Env

describe('auth instance is built once per isolate (global scope, not request CPU)', () => {
  const spy = vi.spyOn(d1, 'drizzle')
  beforeEach(() => spy.mockClear())
  afterEach(() => spy.mockClear())

  it('login, session, sync, bot and auth routes never construct another; the request host is irrelevant', async () => {
    await resetDb()
    const startup = authFor(e, 'https://whatever.example/x')! // APP_ORIGIN is set: lookup only
    expect(spy).toHaveBeenCalledTimes(0)
    const { cookie } = await login()
    for (let i = 0; i < 5; i++) {
      expect((await call('/api/auth/get-session', { cookie })).status).toBe(200)
      expect((await call('/sync/pull?clientId=c', { cookie })).status).toBe(200)
      expect((await call('/bot/v1/read')).status).toBe(401)
    }
    expect(spy).toHaveBeenCalledTimes(0)
    expect(authFor(e, 'https://food-log.test/api/auth/get-session')).toBe(startup)
    expect(getAuth(e, 'https://food-log.test')).toBe(startup)
  })

  it('a request env with a different config rebuilds the single slot lazily (tests / localhost dev); fail-closed stays null', () => {
    const startup = authFor(e, 'https://x.example/')!
    const dev = authFor({ ...e, APP_ORIGIN: undefined }, 'http://localhost:8787/api/auth/get-session')!
    expect(dev).not.toBe(startup)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(authFor({ ...e, APP_ORIGIN: undefined }, 'http://localhost:8787/other')).toBe(dev) // still one build for that config
    expect(authFor({ ...e, APP_ORIGIN: undefined }, 'https://food-log.x.workers.dev/')).toBeNull() // no origin, not loopback
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('prewarm at module load (fresh module graph, betterAuth observed through vi.mock)', () => {
  async function freshImport() {
    vi.resetModules()
    const { betterAuth } = await import('better-auth')
    vi.mocked(betterAuth).mockClear()
    const auth = await import('../src/auth.ts')
    return { auth, betterAuth: vi.mocked(betterAuth) }
  }

  it('constructs exactly one instance at import time, before any request, and reports ok', async () => {
    const { auth, betterAuth } = await freshImport()
    expect(betterAuth).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(auth.authPrewarmStatus()).toBe('ok')) // set once the startup promise settles (microtasks only)
    expect(auth.authFor(e, 'https://whatever.example/x')).not.toBeNull()
    expect(betterAuth).toHaveBeenCalledTimes(1)
  })

  it("prewarmAuth: 'skipped' without APP_ORIGIN, secret or DB (nothing is built); 'ok' for a real config", async () => {
    const { auth, betterAuth } = await freshImport()
    betterAuth.mockClear()
    expect(await auth.prewarmAuth({ ...e, APP_ORIGIN: undefined })).toBe('skipped')
    expect(await auth.prewarmAuth({ ...e, BETTER_AUTH_SECRET: '' })).toBe('skipped')
    expect(await auth.prewarmAuth({ ...e, DB: undefined as never })).toBe('skipped')
    expect(betterAuth).toHaveBeenCalledTimes(0)
    expect(await auth.prewarmAuth(e)).toBe('ok')
  })

  it("prewarmAuth: 'failed:<reason>' when construction throws synchronously; never rejects", async () => {
    const { auth, betterAuth } = await freshImport()
    betterAuth.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(await auth.prewarmAuth({ ...e, APP_ORIGIN: 'https://sync-fail.example' })).toBe('failed:Error boom')
  })

  it("prewarmAuth: 'failed:<reason>' when the async init rejects, and the broken slot is dropped so a request rebuilds it", async () => {
    const { auth, betterAuth } = await freshImport()
    const cfg = { ...e, APP_ORIGIN: 'https://async-fail.example' }
    betterAuth.mockImplementationOnce((() => ({ $context: Promise.reject(new Error('init failed')) })) as never)
    expect(await auth.prewarmAuth(cfg)).toBe('failed:Error init failed')
    const rebuilt = auth.authFor(cfg, 'https://anything.example/')!
    expect(typeof rebuilt.handler).toBe('function')
    expect(auth.getAuth(cfg, 'https://async-fail.example')).toBe(rebuilt) // the slot now holds the lazily built, real instance
  })
})
