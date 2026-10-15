// 傳輸層：fetch 版 Transport。錯誤分成四類，loop 依類別決定退避、登入狀態、更新提示。
//   NetworkError  連不上、逾時（15 秒）、回應讀到一半斷線 → 退避重試（classifyError：NET-0）
//   HttpError     其他非 2xx（5xx 退避重試；4xx 不重試）                    （API-<status>）
//   AuthError     401 → 進入登入狀態，pending 保留                           （unauthorized）
//   TooOldError   409 { error:'client_too_old' } → 顯示「有新版本」          （client_too_old）
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from '@food-log/core'
import type { PullQuery, PullResponse, PushRequest, PushResponse } from '@food-log/core'

export const REQUEST_TIMEOUT_MS = 15_000

export class NetworkError extends Error {
  constructor(message = 'network error', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NetworkError'
  }
}

export class HttpError extends Error {
  readonly status: number
  /** 伺服器回應 body 裡的訊息（有的話；給 4xx 的「壞請求」顯示用）。 */
  readonly serverMessage: string | undefined
  constructor(status: number, serverMessage?: string) {
    super(`API-${status}`)
    this.name = 'HttpError'
    this.status = status
    this.serverMessage = serverMessage
  }
}

export class AuthError extends Error {
  constructor() {
    super('unauthorized')
    this.name = 'AuthError'
  }
}

export class TooOldError extends Error {
  readonly minClientVersion: number | null
  constructor(minClientVersion: number | null = null) {
    super('client_too_old')
    this.name = 'TooOldError'
    this.minClientVersion = minClientVersion
  }
}

/** 同步用的傳輸介面：真實版是 FetchTransport，測試用 testing/MemoryTransport。丟出上面四種錯誤之一。 */
export interface Transport {
  push(req: PushRequest): Promise<PushResponse>
  pull(query: PullQuery): Promise<PullResponse>
}

export interface FetchTransportOptions {
  /** 例如 'https://api.example.workers.dev'；同源就留空。 */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  clientVersion?: number
}

export class FetchTransport implements Transport {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly clientVersion: number

  constructor(opts: FetchTransportOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '')
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.clientVersion = opts.clientVersion ?? CLIENT_VERSION
  }

  push(req: PushRequest): Promise<PushResponse> {
    return this.request<PushResponse>('/sync/push', { method: 'POST', body: JSON.stringify(req), headers: { 'Content-Type': 'application/json' } })
  }

  pull(q: PullQuery): Promise<PullResponse> {
    const qs = new URLSearchParams({ cookie: q.cookie, clientId: q.clientId, afterMutationId: String(q.afterMutationId) })
    return this.request<PullResponse>(`/sync/pull?${qs.toString()}`, { method: 'GET' })
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const ctl = new AbortController()
    // 逾時涵蓋「等回應」和「讀完 body」兩段。
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      let res: Response
      try {
        res = await this.fetchFn(this.baseUrl + path, {
          ...init,
          signal: ctl.signal,
          credentials: 'include',
          headers: { ...(init.headers as Record<string, string> | undefined), [CLIENT_VERSION_HEADER]: String(this.clientVersion) },
        })
      } catch (e) {
        throw new NetworkError(ctl.signal.aborted ? 'timeout' : 'network error', { cause: e })
      }
      if (res.status === 401) throw new AuthError()
      if (res.status === 409) {
        const body = await readJson<{ error?: string; minClientVersion?: number }>(res, ctl.signal).catch(() => null)
        if (body?.error === 'client_too_old') throw new TooOldError(typeof body.minClientVersion === 'number' ? body.minClientVersion : null)
        throw new HttpError(409)
      }
      if (!res.ok) {
        const body = await readJson<{ message?: unknown; error?: unknown }>(res, ctl.signal).catch(() => null)
        const msg = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : undefined
        throw new HttpError(res.status, msg)
      }
      return await readJson<T>(res, ctl.signal)
    } finally {
      clearTimeout(timer)
    }
  }
}

async function readJson<T>(res: Response, signal: AbortSignal): Promise<T> {
  try {
    return (await res.json()) as T
  } catch (e) {
    // body 讀到一半斷線或逾時：當成網路錯誤（push 的話下次重送，伺服器會依 mutationId 去重）。
    throw new NetworkError(signal.aborted ? 'timeout' : 'bad response body', { cause: e })
  }
}

/** UI 用的錯誤代碼（沿用 loadstate 的 classifyError 約定：NET-0、API-<status>、unauthorized）。 */
export function errorCode(e: unknown): string {
  if (e instanceof NetworkError) return 'NET-0'
  if (e instanceof HttpError) return `API-${e.status}`
  if (e instanceof AuthError) return 'unauthorized'
  if (e instanceof TooOldError) return 'client_too_old'
  return e instanceof Error ? e.message : String(e)
}
