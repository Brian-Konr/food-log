// Apps Script Web App 介面卡。網址與密鑰由使用者第一次開啟時輸入，存在 localStorage；原始碼裡不放。
import { NetworkError } from './errors'
import type { Adapter, Op, Response } from './types'

/**
 * 每個請求最多等多久。Apps Script 冷啟動實測光是「還沒碰到試算表」就可能要 12–26 秒，
 * 寫入再加上等鎖與 Sheet 操作，20 秒會被瀏覽器提早中斷（後端其實可能已寫入）。
 * 55 秒：比 iOS Safari 的 60 秒網路逾時短一點，讓我們自己的訊息先出來。
 */
export const GAS_TIMEOUT_MS = 55_000

export function createGasAdapter(opts: { url: string; secret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Adapter {
  const { url, secret, fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = GAS_TIMEOUT_MS } = opts
  if (!url || !secret) throw new Error('需要 Apps Script 網址和共享密鑰')
  return {
    kind: 'gas',
    async call(op: Op): Promise<Response> {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      let res: globalThis.Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ ...op, secret }),
          redirect: 'follow',
          signal: ctrl.signal,
        })
      } catch {
        throw new NetworkError(undefined, ctrl.signal.aborted ? 'timeout' : 'fetch')
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new NetworkError(`伺服器暫時沒有回應（HTTP ${res.status}），稍後會自動重試`, `http-${res.status}`)
      try {
        return (await res.json()) as Response
      } catch {
        return { ok: false, error: 'bad_response', message: '回應不是 JSON：請確認 Apps Script 部署設成「任何人」可存取' }
      }
    },
  }
}
