import { passkeyClient } from '@better-auth/passkey/client'
import { createAuthClient } from 'better-auth/client'

/**
 * 前端的登入／登出封裝（Better Auth 在同源的 /api/auth/*，cookie session）。
 * 所有失敗都丟 AuthError，code 是下面五種之一，畫面只看 code。
 */
export type AuthErrorCode = 'cancelled' | 'invalid_code' | 'not_allowed' | 'network' | 'unsupported' | 'unknown'

export class AuthError extends Error {
  readonly code: AuthErrorCode
  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'AuthError'
    this.code = code
  }
}

export interface AuthSession {
  userId: string
  email: string
}

// 不給 baseURL：瀏覽器端預設 window.location.origin + /api/auth（同源）
const client = createAuthClient({
  plugins: [passkeyClient()],
  fetchOptions: { credentials: 'include' },
})

interface ClientError {
  code?: string
  message?: string
  status?: number
  name?: string
}

const CANCEL_CODES = new Set(['AUTH_CANCELLED', 'REGISTRATION_CANCELLED', 'ERROR_CEREMONY_ABORTED'])

/** 這個瀏覽器能不能做 WebAuthn（沒有的話 Better Auth 的 passkey 呼叫會丟 TypeError） */
function webauthnAvailable(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.credentials
}

/** fetch 失敗的 TypeError（Chrome "Failed to fetch"、Safari "Load failed"、Firefox "NetworkError…"） */
function isFetchFailure(e: Error): boolean {
  return /fetch|network|load failed/i.test(e.message) || (typeof navigator !== 'undefined' && navigator.onLine === false)
}

/** Better Auth 的 `{ error }`（或丟出的例外）→ 五種代碼之一 */
export function mapAuthError(err: unknown): AuthErrorCode {
  if (err instanceof AuthError) return err.code
  if (err === null || typeof err !== 'object') return 'unknown'
  const e = err as ClientError
  // 瀏覽器的 WebAuthn 被取消。注意 iOS/WebKit 在「這台裝置沒有這個網站的 passkey」或逾時時也丟 NotAllowedError，
  // 無法和使用者按取消分辨，所以 'cancelled' 的畫面要一併提示「可能是還沒有 passkey」。
  if (e.name === 'NotAllowedError' || e.name === 'AbortError') return 'cancelled'
  if (err instanceof TypeError) {
    if (isFetchFailure(err)) return 'network'
    return webauthnAvailable() ? 'unknown' : 'unsupported'
  }
  const code = String(e.code ?? '')
  if (CANCEL_CODES.has(code) || /cancel/i.test(code)) return 'cancelled'
  if (code === 'INVALID_OR_EXPIRED_CODE') return 'invalid_code'
  if (code === 'NOT_ALLOWED' || e.status === 403) return 'not_allowed'
  // better-fetch 連不上時沒有 HTTP status（0 或 undefined），也沒有伺服器的錯誤碼
  if (!e.status && !code) return 'network'
  return 'unknown'
}

function fail(err: unknown): never {
  throw new AuthError(mapAuthError(err), err instanceof Error ? err.message : (err as ClientError | null)?.message)
}

async function getSession(): Promise<AuthSession | null> {
  let res: { data?: { user?: { id?: string; email?: string } } | null; error?: ClientError | null }
  try {
    res = await client.getSession()
  } catch (e) {
    return fail(e)
  }
  if (res.error) {
    // 401：沒登入（或過期）。其他錯誤（含離線）丟出去，呼叫端不要因此把人登出。
    if (res.error.status === 401) return null
    return fail(res.error)
  }
  const user = res.data?.user
  if (!user?.id || !user.email) return null
  return { userId: user.id, email: user.email }
}

async function signInWithPasskey(): Promise<void> {
  let res: { error?: ClientError | null } | undefined
  try {
    res = (await client.signIn.passkey()) as typeof res
  } catch (e) {
    return fail(e)
  }
  if (res?.error) return fail(res.error)
}

async function signInWithCode(code: string): Promise<void> {
  let res: Response
  try {
    res = await fetch('/api/auth/login-code/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code: code.trim() }),
    })
  } catch {
    throw new AuthError('network')
  }
  if (res.ok) return
  if (res.status === 401 || res.status === 400 || res.status === 422) throw new AuthError('invalid_code')
  if (res.status === 403) throw new AuthError('not_allowed')
  throw new AuthError('unknown', `HTTP ${res.status}`)
}

async function addPasskey(): Promise<void> {
  let res: { error?: ClientError | null } | undefined
  try {
    const name = typeof navigator !== 'undefined' && /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : 'this device'
    res = (await client.passkey.addPasskey({ name })) as typeof res
  } catch (e) {
    return fail(e)
  }
  if (res?.error) return fail(res.error)
}

async function signOut(): Promise<void> {
  let res: { error?: ClientError | null } | undefined
  try {
    res = (await client.signOut()) as typeof res
  } catch (e) {
    return fail(e)
  }
  if (res?.error) return fail(res.error)
}

export const authClient = { getSession, signInWithPasskey, signInWithCode, addPasskey, signOut }
