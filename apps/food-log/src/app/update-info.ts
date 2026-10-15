// 409 client_too_old 的 minClientVersion（transport 丟的 TooOldError 帶著它）：
// >= 9999 是回滾用的 kill switch，這時「重新載入」沒有用，UpdatePrompt 要顯示「已暫停使用」（retired）。
import { useSyncExternalStore } from 'react'
import { TooOldError } from '@food-log/sync-client'
import type { Transport } from '@food-log/sync-client'
import type { PullQuery, PullResponse, PushRequest, PushResponse } from '@food-log/core'

let minClientVersion: number | null = null
const listeners = new Set<() => void>()

export function setMinClientVersion(v: number | null): void {
  if (v === minClientVersion) return
  minClientVersion = v
  listeners.forEach((l) => l())
}

export function useMinClientVersion(): number | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => minClientVersion,
    () => null,
  )
}

/** 包一層 transport：收到 TooOldError 就記下 minClientVersion，錯誤原樣丟出（sync-client 的 loop 照舊處理）。 */
export function trackTooOld(inner: Transport): Transport {
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f()
    } catch (e) {
      if (e instanceof TooOldError) setMinClientVersion(e.minClientVersion)
      throw e
    }
  }
  return {
    push: (req: PushRequest): Promise<PushResponse> => wrap(() => inner.push(req)),
    pull: (q: PullQuery): Promise<PullResponse> => wrap(() => inner.pull(q)),
  }
}
