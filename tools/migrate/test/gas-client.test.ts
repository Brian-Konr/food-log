import { afterEach, expect, test, vi } from 'vitest'
import { GasError, callOk, createGasClient, gasClientFromEnv, redact } from '../src/gas-client.ts'

const SECRET = 'sekrit-value-123'
const URL_ = 'https://script.example.test/macros/s/AKfake/exec'

afterEach(() => vi.restoreAllMocks())

function fakeFetch(responses: (string | Error | { status: number; body: string })[]) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string; redirect: string } }[] = []
  const f = async (url: string, init: (typeof calls)[number]['init']) => {
    calls.push({ url, init })
    const r = responses.shift()!
    if (r instanceof Error) throw r
    const o = typeof r === 'string' ? { status: 200, body: r } : r
    return { status: o.status, text: async () => o.body }
  }
  return { f: f as never, calls }
}

test('reads GAS_URL and GAS_SECRET from the environment only; missing values name the variable, never print values', () => {
  expect(() => gasClientFromEnv({})).toThrow(/GAS_URL is not set/)
  expect(() => gasClientFromEnv({ GAS_URL: URL_ })).toThrow(/GAS_SECRET is not set/)
  expect(() => gasClientFromEnv({ GAS_URL: 'http://insecure.test/exec', GAS_SECRET: SECRET })).toThrow(/https/)
  try {
    gasClientFromEnv({ GAS_URL: 'http://insecure.test/exec', GAS_SECRET: SECRET })
  } catch (e) {
    expect(String(e)).not.toContain(SECRET)
  }
  expect(gasClientFromEnv({ GAS_URL: URL_, GAS_SECRET: SECRET })).toBeTruthy()
})

test('POSTs text/plain JSON with the secret in the body (like the v1 front end), follows redirects, secret not in the URL', async () => {
  const { f, calls } = fakeFetch([JSON.stringify({ ok: true, x: 1 })])
  const client = createGasClient({ url: URL_, secret: SECRET, fetch: f })
  const res = await client.call({ action: 'read' })
  expect(res).toEqual({ ok: true, x: 1 })
  const c = calls[0]!
  expect(c.url).toBe(URL_)
  expect(c.url).not.toContain(SECRET)
  expect(c.init.method).toBe('POST')
  expect(c.init.headers['Content-Type']).toMatch(/^text\/plain/)
  expect(c.init.redirect).toBe('follow')
  expect(JSON.parse(c.init.body)).toEqual({ secret: SECRET, action: 'read' })
})

test('never logs the secret: console is silent, errors are scrubbed', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
  const html = fakeFetch([{ status: 500, body: `<html>Error for ${SECRET} ${encodeURIComponent(SECRET)}</html>` }])
  const c1 = createGasClient({ url: URL_, secret: SECRET, fetch: html.f })
  const err1 = await c1.call({ action: 'read' }).catch((e: Error) => e)
  expect(err1).toBeInstanceOf(GasError)
  expect(String(err1)).not.toContain(SECRET)
  expect((err1 as GasError).code).toBe('bad_response')

  const net = fakeFetch([new Error(`connect failed ${SECRET}`), new Error(`connect failed ${SECRET}`)])
  const c2 = createGasClient({ url: URL_, secret: SECRET, fetch: net.f, retries: 2, sleep: async () => {} })
  const err2 = await c2.call({ action: 'read' }).catch((e: Error) => e)
  expect((err2 as GasError).code).toBe('network')
  expect(String(err2)).not.toContain(SECRET)
  expect((err2 as Error).message).toContain('[secret]')

  const bad = fakeFetch([JSON.stringify({ ok: false, error: 'unauthorized', message: '共享密鑰不正確' })])
  const c3 = createGasClient({ url: URL_, secret: SECRET, fetch: bad.f })
  const err3 = await callOk(c3, { action: 'read' }).catch((e: Error) => e)
  expect((err3 as GasError).code).toBe('unauthorized')
  for (const s of spies) expect(s).not.toHaveBeenCalled()
})

test('retries `busy` and network errors with backoff, then gives up', async () => {
  const sleeps: number[] = []
  const { f, calls } = fakeFetch([JSON.stringify({ ok: false, error: 'busy' }), new Error('reset'), JSON.stringify({ ok: true })])
  const client = createGasClient({ url: URL_, secret: SECRET, fetch: f, sleep: async (ms) => void sleeps.push(ms) })
  expect(await client.call({ action: 'read' })).toEqual({ ok: true })
  expect(calls).toHaveLength(3)
  expect(sleeps).toEqual([1000, 2000])

  const busy = fakeFetch([JSON.stringify({ ok: false, error: 'busy' }), JSON.stringify({ ok: false, error: 'busy' })])
  const c2 = createGasClient({ url: URL_, secret: SECRET, fetch: busy.f, retries: 2, sleep: async () => {} })
  await expect(c2.call({ action: 'append' })).rejects.toMatchObject({ code: 'busy' })
})

test('redact handles raw and url-encoded secrets', () => {
  expect(redact(`a ${SECRET} b ${encodeURIComponent('x y&z')}`, 'x y&z')).toBe(`a ${SECRET} b [secret]`)
  expect(redact('plain', '')).toBe('plain')
})
