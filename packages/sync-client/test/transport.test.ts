import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from '@food-log/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthError, FetchTransport, HttpError, NetworkError, REQUEST_TIMEOUT_MS, TooOldError, errorCode } from '../src/transport'

afterEach(() => {
  vi.useRealTimers()
})

const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })
const pullQuery = { cookie: 'e1:3', clientId: 'c 1', afterMutationId: 7 }

describe('FetchTransport', () => {
  it('push：POST /sync/push，帶 X-FoodLog-Client 標頭與 credentials: include', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => res(200, { lastMutationId: 1, results: [] }))
    const t = new FetchTransport({ baseUrl: 'https://api.test/', fetch: fetchFn as unknown as typeof fetch })
    const out = await t.push({ clientId: 'c1', mutations: [] })
    expect(out).toEqual({ lastMutationId: 1, results: [] })
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.test/sync/push')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ clientId: 'c1', mutations: [] }) })
    expect((init!.headers as Record<string, string>)[CLIENT_VERSION_HEADER]).toBe(String(CLIENT_VERSION))
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('pull：GET /sync/pull?cookie&clientId&afterMutationId（參數有編碼）', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => res(200, { cookie: 'e1:3', more: false }))
    const t = new FetchTransport({ fetch: fetchFn as unknown as typeof fetch })
    await t.pull(pullQuery)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('/sync/pull?cookie=e1%3A3&clientId=c+1&afterMutationId=7')
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' })
  })

  const cases: [string, () => Response | Promise<Response>, (e: unknown) => void][] = [
    ['401 → AuthError', () => res(401), (e) => expect(e).toBeInstanceOf(AuthError)],
    [
      '409 client_too_old → TooOldError（帶 minClientVersion）',
      () => res(409, { error: 'client_too_old', minClientVersion: 5 }),
      (e) => {
        expect(e).toBeInstanceOf(TooOldError)
        expect((e as TooOldError).minClientVersion).toBe(5)
      },
    ],
    ['409 其他 → HttpError(409)', () => res(409, { error: 'x' }), (e) => expect(e).toMatchObject({ name: 'HttpError', status: 409 })],
    ['503 → HttpError(503)', () => res(503), (e) => expect(e).toMatchObject({ name: 'HttpError', status: 503, message: 'API-503' })],
    ['400 → HttpError(400)', () => res(400), (e) => expect(e).toBeInstanceOf(HttpError)],
    [
      'fetch 丟錯 → NetworkError',
      () => {
        throw new TypeError('Failed to fetch')
      },
      (e) => expect(e).toBeInstanceOf(NetworkError),
    ],
    ['200 但 body 不是 JSON → NetworkError', () => new Response('<html>', { status: 200 }), (e) => expect(e).toBeInstanceOf(NetworkError)],
  ]
  for (const [name, make, check] of cases) {
    it(name, async () => {
      const t = new FetchTransport({ fetch: (async () => make()) as unknown as typeof fetch })
      const err = await t.push({ clientId: 'c', mutations: [] }).catch((e: unknown) => e)
      check(err)
      const err2 = await t.pull(pullQuery).catch((e: unknown) => e)
      check(err2)
    })
  }

  it('逾時 15 秒 → NetworkError(timeout)，並且真的 abort 了請求', async () => {
    vi.useFakeTimers()
    expect(REQUEST_TIMEOUT_MS).toBe(15_000)
    let signal: AbortSignal | undefined
    const fetchFn = (_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init!.signal!
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const t = new FetchTransport({ fetch: fetchFn as unknown as typeof fetch })
    const p = t.pull(pullQuery).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const err = await p
    expect(err).toBeInstanceOf(NetworkError)
    expect((err as NetworkError).message).toBe('timeout')
    expect(signal!.aborted).toBe(true)
  })

  it('errorCode：NET-0、API-<status>、unauthorized、client_too_old', () => {
    expect(errorCode(new NetworkError())).toBe('NET-0')
    expect(errorCode(new HttpError(502))).toBe('API-502')
    expect(errorCode(new AuthError())).toBe('unauthorized')
    expect(errorCode(new TooOldError())).toBe('client_too_old')
    expect(errorCode(new Error('x'))).toBe('x')
  })
})
