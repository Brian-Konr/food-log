import type { CachedSnapshot } from './cache'
import { NetworkError, ServerError } from '@/api/errors'

export type LoadState = 'skeleton' | 'cached-syncing' | 'fresh' | 'error-cached' | 'error-empty'
export type ErrorKind = 'offline' | 'server' | 'auth'

export function deriveLoadState(input: {
  booting: boolean
  cache: CachedSnapshot | null
  fresh: boolean
  error: { kind: ErrorKind; code: string } | null
}): LoadState {
  if (input.booting) return 'skeleton'
  if (input.fresh && !input.error) return 'fresh'
  if (input.error && input.cache) return 'error-cached'
  if (input.error && !input.cache) return 'error-empty'
  if (input.cache && !input.fresh && !input.error) return 'cached-syncing'
  return 'skeleton'
}

export function errorCopy(kind: ErrorKind, code: string): { reason: string; codeLine: string } {
  if (kind === 'offline') return { reason: '沒有網路連線', codeLine: `錯誤代碼 ${code || 'NET-0'}` }
  if (kind === 'auth') return { reason: '登入過期，請重新打開', codeLine: `錯誤代碼 ${code || 'unauthorized'}` }
  if (code === 'schema_outdated') return { reason: '請先執行 migrateFoodLog', codeLine: '錯誤代碼 schema_outdated' }
  return { reason: '伺服器沒有回應，可能是暫時的問題', codeLine: `錯誤代碼 ${code || 'server_error'}` }
}

export function classifyError(err: unknown, browserOnline: boolean): { kind: ErrorKind; code: string } {
  if (!browserOnline) return { kind: 'offline', code: 'NET-0' }
  if (err instanceof NetworkError) {
    if (err.kind === 'fetch') return { kind: 'offline', code: 'NET-0' }
    if (err.kind === 'timeout') return { kind: 'server', code: 'GAS-503' }
    const http = /^http-(\d+)$/.exec(err.kind)
    if (http) return { kind: 'server', code: `GAS-${http[1]}` }
    return { kind: 'server', code: 'GAS-503' }
  }
  if (err instanceof ServerError) {
    if (err.code === 'unauthorized') return { kind: 'auth', code: 'unauthorized' }
    if (err.code === 'schema_outdated') return { kind: 'server', code: 'schema_outdated' }
    if (err.code === 'busy' || err.code === 'server_error') return { kind: 'server', code: err.code === 'busy' ? 'GAS-503' : 'server_error' }
    return { kind: 'server', code: err.code }
  }
  return { kind: 'server', code: 'server_error' }
}
