import { useState } from 'react'
import { Button } from '@food-log/ui'

const WAIT_MS = 4000
/**
 * main.tsx 的 registerSW（autoUpdate）會在新 worker activated 時自己 reload。
 * 新 worker 啟用後多等一下讓它先動；它沒動（頁面還在）才由我們 reload，避免連續 reload 兩次。
 */
export const RELOAD_GRACE_MS = 1500

/** 等 worker 啟用（或失敗／逾時），任何情況都會 resolve；回傳是否真的啟用 */
function settle(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    if (worker.state === 'activated') return resolve(true)
    if (worker.state === 'redundant') return resolve(false)
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      worker.removeEventListener('statechange', onChange)
      resolve(ok)
    }
    const onChange = () => {
      if (worker.state === 'activated') finish(true)
      else if (worker.state === 'redundant') finish(false)
    }
    const timer = setTimeout(() => finish(false), WAIT_MS)
    worker.addEventListener('statechange', onChange)
  })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 取得最新的 service worker 後重新載入。
 * vite-plugin-pwa 設 `registerType: 'autoUpdate'`（workbox skipWaiting + clientsClaim），新 worker 通常自己啟用，
 * 且 registerSW 會在啟用時 reload；這裡仍送 SKIP_WAITING（沒人監聽就無害），等啟用，再給 registerSW 的 reload 一點時間。
 * 沒有新 worker、或任何一步失敗／逾時，照樣 reload。
 */
export async function applyUpdate(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.update()
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      const next = reg.waiting ?? reg.installing
      if (next && (await settle(next))) await sleep(RELOAD_GRACE_MS)
    }
  } catch {
    // 落到下面的 reload
  }
  window.location.reload()
}

/**
 * 後端回 409（前端版本過舊）時由外層把 open 設成 true。不能關閉，只能重新載入。
 *
 * `retired`：409 也可能是回滾用的 kill switch（`MIN_CLIENT_VERSION=9999`），這時重新載入沒有用（會一直 409）。
 * 整合時請在 `minClientVersion >= 9999` 時傳 `retired`，畫面改成「已暫停使用」且沒有重新載入按鈕。
 */
export function UpdatePrompt({ open, retired = false }: { open: boolean; retired?: boolean }) {
  const [busy, setBusy] = useState(false)
  if (!open) return null
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-between gap-3 border-b bg-background px-4 pb-3 pt-[calc(var(--safe-top)+0.75rem)] shadow-md"
    >
      <p className="font-medium">{retired ? '這個版本已暫停使用，請改用舊版 App' : '有新版本，請重新載入'}</p>
      {!retired && (
        <Button
          type="button"
          size="sm"
          className="shrink-0 rounded-[22px] px-5 font-bold"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void applyUpdate()
          }}
        >
          {busy ? '更新中…' : '重新載入'}
        </Button>
      )}
    </div>
  )
}
