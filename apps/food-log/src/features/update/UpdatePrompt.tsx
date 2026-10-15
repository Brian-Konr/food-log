import { useState } from 'react'

const WAIT_MS = 4000

/** 等 worker 啟用（或失敗／逾時），任何情況都會 resolve */
function settle(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    if (worker.state === 'activated' || worker.state === 'redundant') return resolve()
    const done = () => {
      clearTimeout(timer)
      worker.removeEventListener('statechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') done()
    }
    const timer = setTimeout(done, WAIT_MS)
    worker.addEventListener('statechange', onChange)
  })
}

/**
 * 取得最新的 service worker 後重新載入。
 * vite-plugin-pwa 設 `registerType: 'autoUpdate'`（workbox 會 skipWaiting + clientsClaim），新 worker 通常自己啟用；
 * 這裡仍送 SKIP_WAITING（沒有監聽就無害），再等它啟用。任何一步失敗或逾時都照樣 reload。
 */
export async function applyUpdate(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.update()
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      const next = reg.waiting ?? reg.installing
      if (next) await settle(next)
    }
  } catch {
    // 落到下面的 reload
  }
  window.location.reload()
}

/** 後端回 409（前端版本過舊）時由外層把 open 設成 true。不能關閉，只能重新載入。 */
export function UpdatePrompt({ open }: { open: boolean }) {
  const [busy, setBusy] = useState(false)
  if (!open) return null
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-between gap-3 border-b bg-background px-4 pb-3 pt-[calc(var(--safe-top)+0.75rem)] shadow-md"
    >
      <p className="font-medium">有新版本，請重新載入</p>
      <button
        type="button"
        disabled={busy}
        className="h-11 shrink-0 rounded-[22px] bg-primary px-5 font-bold text-primary-foreground disabled:opacity-60"
        onClick={() => {
          setBusy(true)
          void applyUpdate()
        }}
      >
        {busy ? '更新中…' : '重新載入'}
      </button>
    </div>
  )
}
