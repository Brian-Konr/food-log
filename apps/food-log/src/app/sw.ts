// Service Worker 更新流程（vite-plugin-pwa registerType: 'prompt'）：
// 新版裝好後停在 waiting，不會自己換；由 UpdatePrompt（features/update）的「重新載入」換上：它送 SKIP_WAITING 給等待中的 worker 再 reload。
// main.tsx 啟動時呼叫 registerServiceWorker()；測試不載入 virtual:pwa-register，所以這裡沒有靜態 import 它。
import { useSyncExternalStore } from 'react'

type Register = (opts: { immediate?: boolean; onNeedRefresh?: () => void; onRegisteredSW?: (url: string, reg?: ServiceWorkerRegistration) => void }) => unknown

let needRefresh = false
let registration: ServiceWorkerRegistration | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function registerServiceWorker(register: Register): void {
  register({
    immediate: true,
    onNeedRefresh: () => {
      needRefresh = true
      emit()
    },
    onRegisteredSW: (_url, reg) => {
      registration = reg
    },
  })
}

/** 有新版本已經裝好、等著換。 */
export function useNeedRefresh(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => needRefresh,
    () => false,
  )
}

/** 去找新版（registration.update()）。找不到 registration（沒有 Service Worker）就什麼都不做。 */
export async function checkForUpdate(): Promise<void> {
  try {
    await (registration ?? (await navigator.serviceWorker?.getRegistration()))?.update()
  } catch {
    /* 離線等：下次再找 */
  }
}

/** 測試用 */
export function __setNeedRefreshForTest(v: boolean): void {
  needRefresh = v
  emit()
}
