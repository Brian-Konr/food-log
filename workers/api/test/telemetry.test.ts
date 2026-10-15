import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../src/index.ts'
import type { Env } from '../src/env.ts'
import { BUCKET_CAPACITY, originAllowed, resetTelemetryBuckets, takeToken } from '../src/routes/telemetry.ts'
import { ORIGIN, call, resetDb } from './helpers.ts'

beforeEach(async () => {
  await resetDb()
  resetTelemetryBuckets()
})

const post = (json: unknown) => call('/telemetry/error', { method: 'POST', json })

describe('POST /telemetry/error', () => {
  it('accepts {code, version} without a session', async () => {
    for (const body of [{ code: 'NET-0', version: '1.1.4' }, { code: 'API-503', version: 12 }, { code: 'unauthorized', version: 'abc123' }]) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
  })

  it('rejects any other field (no food data, no messages), bad codes and bad versions', async () => {
    for (const body of [
      { code: 'NET-0', version: '1', message: '雞胸 300kcal' },
      { code: 'NET-0', version: '1', extra: 1 },
      { code: 'a b', version: '1' },
      { code: '', version: '1' },
      { code: 'x'.repeat(65), version: '1' },
      { code: 'NET-0', version: 'x'.repeat(33) },
      { code: 'NET-0', version: -1 },
      { code: 'NET-0' },
      { version: '1' },
      [],
      'text',
      null,
    ]) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('rejects bodies over 1 KB (declared or real) and broken JSON', async () => {
    const big = JSON.stringify({ code: 'NET-0', version: '1', pad: 'x'.repeat(1100) })
    expect(big.length).toBeGreaterThan(1024)
    expect((await call('/telemetry/error', { method: 'POST', body: big, headers: { 'content-type': 'application/json' } })).status).toBe(413)
    // lying content-length (small) with a big body: the real size is checked too
    const lie = await call('/telemetry/error', { method: 'POST', body: big, headers: { 'content-type': 'application/json', 'content-length': '10' } })
    expect([400, 413]).toContain(lie.status)
    expect((await call('/telemetry/error', { method: 'POST', body: '{nope', headers: { 'content-type': 'application/json' } })).status).toBe(400)
    // exactly at the limit is fine
    const exact = JSON.stringify({ code: 'NET-0', version: '1' })
    const padded = exact + ' '.repeat(1024 - exact.length)
    expect(padded.length).toBe(1024)
    expect((await call('/telemetry/error', { method: 'POST', body: padded, headers: { 'content-type': 'application/json' } })).status).toBe(200)
  })

  it('only POST exists', async () => {
    expect((await call('/telemetry/error')).status).toBe(404)
  })
})

const BODY = JSON.stringify({ code: 'NET-0', version: '1' })
const viaApp = (url: string, headers: Record<string, string>, over: Partial<Env> = {}) =>
  app.fetch(new Request(url, { method: 'POST', body: BODY, headers: { 'content-type': 'application/json', ...headers } }), { ...(env as unknown as Env), ...over })

describe('Origin must be the app origin', () => {
  const URL_ = ORIGIN + '/telemetry/error'
  it('no Origin or a foreign Origin is 403 forbidden_origin; the real one passes', async () => {
    const none = await viaApp(URL_, {})
    expect(none.status).toBe(403)
    expect(await none.json()).toEqual({ ok: false, error: 'forbidden_origin' })
    for (const origin of ['https://evil.example', 'http://food-log.test', 'https://food-log.test:8443', 'https://food-log.test.evil.example', 'null']) {
      expect((await viaApp(URL_, { Origin: origin })).status, origin).toBe(403)
    }
    expect((await viaApp(URL_, { Origin: ORIGIN })).status).toBe(200)
  })

  it('a localhost Origin is allowed only when the request itself goes to localhost (dev)', async () => {
    expect((await viaApp(URL_, { Origin: 'http://localhost:5173' })).status).toBe(403) // production host, local page: refused
    const dev = 'http://localhost:8787/telemetry/error'
    expect((await viaApp(dev, { Origin: 'http://localhost:5173' }, { APP_ORIGIN: undefined })).status).toBe(200)
    expect((await viaApp(dev, { Origin: 'http://localhost:8787' }, { APP_ORIGIN: undefined })).status).toBe(200)
    expect((await viaApp(dev, { Origin: 'http://127.0.0.1:5173' }, { APP_ORIGIN: ORIGIN })).status).toBe(200)
    expect((await viaApp(dev, { Origin: 'https://evil.example' }, { APP_ORIGIN: undefined })).status).toBe(403)
    expect((await viaApp(dev, {}, { APP_ORIGIN: undefined })).status).toBe(403)
  })

  it('without APP_ORIGIN outside localhost it fails closed (500) like the other routes', async () => {
    expect((await viaApp('https://food-log.x.workers.dev/telemetry/error', { Origin: 'https://food-log.x.workers.dev' }, { APP_ORIGIN: undefined })).status).toBe(500)
  })

  it('originAllowed unit cases', () => {
    expect(originAllowed({ APP_ORIGIN: ORIGIN }, ORIGIN + '/x', ORIGIN)).toBe(true)
    expect(originAllowed({ APP_ORIGIN: ORIGIN }, ORIGIN + '/x', undefined)).toBe(false)
    expect(originAllowed({ APP_ORIGIN: ORIGIN }, 'not a url', ORIGIN)).toBe(true) // expected comes from APP_ORIGIN
  })
})

describe('per-IP rate limit', () => {
  const URL_ = ORIGIN + '/telemetry/error'

  it('uses the Rate Limiting binding when present: 429 once it says no, keyed on CF-Connecting-IP, before the body is read', async () => {
    const seen: string[] = []
    const limiter = { limit: async ({ key }: { key: string }) => (seen.push(key), { success: seen.length <= 2 }) } as unknown as RateLimit
    const over = { TELEMETRY_LIMITER: limiter }
    expect((await viaApp(URL_, { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7' }, over)).status).toBe(200)
    expect((await viaApp(URL_, { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7' }, over)).status).toBe(200)
    const res = await viaApp(URL_, { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7' }, over)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' })
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(seen).toEqual(['203.0.113.7', '203.0.113.7', '203.0.113.7'])
    // a wrong origin is refused without spending the limiter
    expect((await viaApp(URL_, { 'CF-Connecting-IP': '203.0.113.7' }, over)).status).toBe(403)
    expect(seen).toHaveLength(3)
  })

  it('without the binding the in-isolate token bucket limits per IP (and does not touch other IPs)', async () => {
    const post = (ip: string) => viaApp(URL_, { Origin: ORIGIN, 'CF-Connecting-IP': ip })
    for (let i = 0; i < BUCKET_CAPACITY; i++) expect((await post('198.51.100.1')).status, 'request ' + i).toBe(200)
    expect((await post('198.51.100.1')).status).toBe(429)
    expect((await post('198.51.100.2')).status).toBe(200)
  })

  it('no IP header (local dev) and no binding: not limited', async () => {
    for (let i = 0; i < BUCKET_CAPACITY + 5; i++) expect((await viaApp(URL_, { Origin: ORIGIN })).status).toBe(200)
  })

  it('token bucket refills over time and stays bounded', () => {
    const t0 = 1_000_000
    for (let i = 0; i < BUCKET_CAPACITY; i++) expect(takeToken('k', t0)).toBe(true)
    expect(takeToken('k', t0)).toBe(false)
    expect(takeToken('k', t0 + 5_999)).toBe(false)
    expect(takeToken('k', t0 + 6_000)).toBe(true) // 10 per minute = one token per 6 s
    expect(takeToken('k', t0 + 6_000)).toBe(false)
    for (let i = 0; i < 5000; i++) takeToken('ip' + i, t0) // many keys: memory stays capped (no throw, still answers)
    expect(takeToken('fresh', t0)).toBe(true)
  })
})

describe('GET /api/health', () => {
  it('is public and cheap', async () => {
    const res = await call('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, clientVersion: 1 })
  })
})
