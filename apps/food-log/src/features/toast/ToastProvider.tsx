// 單一 toast（原本 App.tsx 的 toast state）。showToast(message, undo?, { durationMs, actionLabel })。
// UndoToast 元件本身不動（3 秒、按住暫停、滑開關閉都在裡面）。
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { MutationError } from '@food-log/core'
import { UndoToast } from '@/components/UndoToast'
import { uid } from '@/lib/uid'
import type { Toast } from '@/types'

export interface ToastApi {
  toast: Toast | null
  showToast: (message: string, undo?: () => unknown, extra?: { durationMs?: number; actionLabel?: string }) => void
  clearToast: () => void
  /**
   * 包住一個動作：本機驗證當場失敗（MutationError，什麼都沒寫）就 toast 伺服器同一套訊息，不丟出去。
   * 成功回結果，失敗回 undefined。
   */
  guard: <T,>(p: Promise<T>) => Promise<T | undefined>
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const t = useContext(ToastContext)
  if (!t) throw new Error('useToast 必須在 <ToastProvider> 底下使用')
  return t
}

export function ToastProvider(props: { children?: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const showToast = useCallback<ToastApi['showToast']>((message, undo, extra) => {
    setToast({ id: uid(), message, undo, durationMs: extra?.durationMs, actionLabel: extra?.actionLabel })
  }, [])
  const clearToast = useCallback(() => setToast(null), [])
  const guard = useCallback(async <T,>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p
    } catch (e) {
      setToast({ id: uid(), message: e instanceof MutationError ? e.message : '沒有存到' })
      return undefined
    }
  }, [])
  const value = useMemo(() => ({ toast, showToast, clearToast, guard }), [toast, showToast, clearToast, guard])
  return <ToastContext.Provider value={value}>{props.children}</ToastContext.Provider>
}

/** 放在 AppShell 最底下。dock = 今天頁（搜尋列在底部，toast 要往上抬）。 */
export function ToastView(props: { dock: boolean }) {
  const { toast, clearToast } = useToast()
  return <UndoToast toast={toast} onGone={clearToast} dock={props.dock} durationMs={toast?.durationMs} />
}
