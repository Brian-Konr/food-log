// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  passkey: vi.fn(),
  addPasskey: vi.fn(),
  signOut: vi.fn(),
  createArgs: [] as unknown[],
}))

vi.mock('better-auth/client', () => ({
  createAuthClient: (opts: unknown) => {
    m.createArgs.push(opts)
    return {
      getSession: m.getSession,
      signIn: { passkey: m.passkey },
      passkey: { addPasskey: m.addPasskey },
      signOut: m.signOut,
    }
  },
}))
vi.mock('@better-auth/passkey/client', () => ({ passkeyClient: () => ({ id: 'passkey' }) }))

import { authClient, AuthError, mapAuthError } from '@/features/auth/auth-client'

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(AuthError)
    return (e as AuthError).code
  }
  return 'resolved'
}

beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client setup', () => {
  test('同源、帶 cookie、掛 passkey 外掛', () => {
    const opts = m.createArgs[0] as { baseURL?: string; fetchOptions: { credentials: string }; plugins: unknown[] }
    expect(opts.baseURL).toBeUndefined()
    expect(opts.fetchOptions.credentials).toBe('include')
    expect(opts.plugins).toHaveLength(1)
  })
})

describe('getSession', () => {
  test('有 session → userId + email', async () => {
    m.getSession.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@example.com', name: 'x' }, session: {} }, error: null })
    expect(await authClient.getSession()).toEqual({ userId: 'u1', email: 'a@example.com' })
  })
  test('沒登入（data null）→ null', async () => {
    m.getSession.mockResolvedValue({ data: null, error: null })
    expect(await authClient.getSession()).toBeNull()
  })
  test('401 → null', async () => {
    m.getSession.mockResolvedValue({ data: null, error: { status: 401, message: 'x' } })
    expect(await authClient.getSession()).toBeNull()
  })
  test('離線不是「沒登入」：丟 network', async () => {
    m.getSession.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await code(authClient.getSession())).toBe('network')
    m.getSession.mockResolvedValue({ data: null, error: { status: 0 } })
    expect(await code(authClient.getSession())).toBe('network')
  })
  test('500 → unknown', async () => {
    m.getSession.mockResolvedValue({ data: null, error: { status: 500, message: 'boom' } })
    expect(await code(authClient.getSession())).toBe('unknown')
  })
})

describe('signInWithPasskey', () => {
  test('成功', async () => {
    m.passkey.mockResolvedValue({ data: { session: {} }, error: null })
    await expect(authClient.signInWithPasskey()).resolves.toBeUndefined()
  })
  test.each([
    ['AUTH_CANCELLED', 'cancelled'],
    ['ERROR_CEREMONY_ABORTED', 'cancelled'],
  ])('error.code %s → %s', async (c, want) => {
    m.passkey.mockResolvedValue({ data: null, error: { code: c, message: 'auth cancelled', status: 400 } })
    expect(await code(authClient.signInWithPasskey())).toBe(want)
  })
  test('瀏覽器丟 NotAllowedError → cancelled', async () => {
    const e = new Error('The operation either timed out or was not allowed')
    e.name = 'NotAllowedError'
    m.passkey.mockRejectedValue(e)
    expect(await code(authClient.signInWithPasskey())).toBe('cancelled')
  })
  test('403 → not_allowed；fetch 失敗 → network；其他 → unknown', async () => {
    m.passkey.mockResolvedValue({ data: null, error: { status: 403, message: 'forbidden' } })
    expect(await code(authClient.signInWithPasskey())).toBe('not_allowed')
    m.passkey.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await code(authClient.signInWithPasskey())).toBe('network')
    m.passkey.mockResolvedValue({ data: null, error: { status: 400, code: 'PASSKEY_NOT_FOUND', message: 'nope' } })
    expect(await code(authClient.signInWithPasskey())).toBe('unknown')
  })
})

describe('signInWithCode', () => {
  function stubFetch(res: Response | Error) {
    const f = vi.fn(async () => {
      if (res instanceof Error) throw res
      return res
    })
    vi.stubGlobal('fetch', f)
    return f
  }

  test('POST 同源 redeem、帶 cookie、body 只有 code', async () => {
    const f = stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await authClient.signInWithCode(' ABCD-EFGH-JKMN ')
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/auth/login-code/redeem')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body as string)).toEqual({ code: 'ABCD-EFGH-JKMN' })
  })
  test('401 → invalid_code', async () => {
    stubFetch(new Response(JSON.stringify({ code: 'INVALID_OR_EXPIRED_CODE' }), { status: 401 }))
    expect(await code(authClient.signInWithCode('BAD'))).toBe('invalid_code')
  })
  test('403 → not_allowed', async () => {
    stubFetch(new Response('{}', { status: 403 }))
    expect(await code(authClient.signInWithCode('ABCD'))).toBe('not_allowed')
  })
  test('fetch 失敗 → network', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    expect(await code(authClient.signInWithCode('ABCD'))).toBe('network')
  })
  test('500 → unknown', async () => {
    stubFetch(new Response('', { status: 500 }))
    expect(await code(authClient.signInWithCode('ABCD'))).toBe('unknown')
  })
})

describe('addPasskey / signOut', () => {
  test('addPasskey 成功與取消', async () => {
    m.addPasskey.mockResolvedValue({ data: {}, error: null })
    await expect(authClient.addPasskey()).resolves.toBeUndefined()
    expect(m.addPasskey).toHaveBeenCalledWith({ name: expect.any(String) })
    m.addPasskey.mockResolvedValue({ data: null, error: { code: 'ERROR_CEREMONY_ABORTED', status: 400 } })
    expect(await code(authClient.addPasskey())).toBe('cancelled')
  })
  test('signOut 成功與失敗', async () => {
    m.signOut.mockResolvedValue({ data: { success: true }, error: null })
    await expect(authClient.signOut()).resolves.toBeUndefined()
    m.signOut.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await code(authClient.signOut())).toBe('network')
  })
})

describe('mapAuthError', () => {
  test('AuthError 原樣、未知物件 → unknown', () => {
    expect(mapAuthError(new AuthError('invalid_code'))).toBe('invalid_code')
    expect(mapAuthError('boom')).toBe('unknown')
    expect(mapAuthError({ status: 500 })).toBe('unknown')
  })
  test('TypeError：fetch 失敗 → network；離線 → network', () => {
    expect(mapAuthError(new TypeError('Failed to fetch'))).toBe('network')
    expect(mapAuthError(new TypeError('Load failed'))).toBe('network')
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(mapAuthError(new TypeError('whatever'))).toBe('network')
    vi.restoreAllMocks()
  })
  test('TypeError 且沒有 WebAuthn → unsupported；有 WebAuthn 的其他 TypeError → unknown', () => {
    const err = new TypeError("undefined is not an object (evaluating 'navigator.credentials.get')")
    expect(mapAuthError(err)).toBe('unsupported') // jsdom 沒有 PublicKeyCredential
    vi.stubGlobal('PublicKeyCredential', class {})
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: {} })
    expect(mapAuthError(err)).toBe('unknown')
    Reflect.deleteProperty(navigator, 'credentials')
  })
})
