import { beforeEach, describe, expect, it } from 'vitest'
import { call, resetDb } from './helpers.ts'

beforeEach(resetDb)

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

describe('GET /api/health', () => {
  it('is public and cheap', async () => {
    const res = await call('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, clientVersion: 1 })
  })
})
