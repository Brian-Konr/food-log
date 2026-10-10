import { useEffect, useRef, useState } from 'react'
import type { Toast } from '@/types'

export function UndoToast(props: { toast: Toast | null; onGone: () => void; dock?: boolean }) {
  const [held, setHeld] = useState(false)
  const t = props.toast
  const gone = props.onGone
  const started = useRef(0)
  useEffect(() => {
    if (!t || held) return
    started.current = Date.now()
    const id = setTimeout(gone, 5000)
    return () => clearTimeout(id)
  }, [t, held, gone])
  if (!t) return null
  const bottom = props.dock
    ? 'calc(var(--tabbar-h) + var(--safe-bottom) + var(--dock-h) + 8px)'
    : 'calc(var(--tabbar-h) + var(--safe-bottom) + 8px)'
  return (
    <div
      role="status"
      aria-live="polite"
      onPointerDown={() => setHeld(true)}
      onPointerUp={() => setHeld(false)}
      className="fixed inset-x-4 z-50 flex min-h-14 items-center justify-between rounded-[14px] bg-[var(--toast)] px-4 py-2 font-medium text-[var(--toast-foreground)]"
      style={{ bottom }}
    >
      <span>{t.message}</span>
      {t.undo && (
        <button
          type="button"
          className="flex min-h-11 min-w-16 items-center justify-center font-bold text-[var(--toast-action)]"
          onClick={() => { void t.undo?.(); gone() }}
        >
          復原
        </button>
      )}
    </div>
  )
}
