// 開機時的登入相關呼叫，不把 better-auth 拉進首頁 bundle：
//   getSession  plain fetch 到 /api/auth/get-session（和 features/auth/auth-client 同一個合約：
//               沒登入回 null；連不上、5xx、回的不是 JSON 都丟例外——不是「沒登入」，不能因此把人登出）
//   signOut、passkey、登入畫面  要用的時候才動態載入 features/auth（better-auth + passkey client 在那個 chunk）
import { lazy } from 'react'

export interface BootAuth {
  getSession(): Promise<{ userId: string; email: string } | null>
  signOut(): Promise<void>
}

export async function fetchSession(opts: { baseUrl?: string; fetch?: typeof fetch } = {}): Promise<{ userId: string; email: string } | null> {
  const f = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const base = (opts.baseUrl ?? import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')
  let res: Response
  try {
    res = await f(`${base}/api/auth/get-session`, { credentials: 'include' })
  } catch {
    throw new Error('network')
  }
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`API-${res.status}`)
  let body: { user?: { id?: unknown; email?: unknown } } | null
  try {
    body = (await res.json()) as typeof body
  } catch {
    throw new Error('bad response') // 例如 dev server 沒有代理到 Worker 時回的 index.html
  }
  const id = body?.user?.id
  if (typeof id !== 'string' || !id) return null
  return { userId: id, email: typeof body?.user?.email === 'string' ? body.user.email : '' }
}

export const defaultAuth: BootAuth = {
  getSession: () => fetchSession(),
  signOut: async () => (await import('@/features/auth/auth-client')).authClient.signOut(),
}

export const LazyLoginScreen = lazy(() => import('@/features/auth/LoginScreen').then((m) => ({ default: m.LoginScreen })))
