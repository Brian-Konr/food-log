import { useEffect, useRef, useState } from 'react'
import type { Toast } from '@/types'

export function UndoToast(props: { toast: Toast | null; onGone: () => void; dock?: boolean; durationMs?: number }) {
  const [held, setHeld] = useState(false)
  const t = props.toast
  const gone = props.onGone
  const duration = t?.durationMs ?? props.durationMs ?? 5000
  const started = useRef(0)
  useEffect(() => {
    if (!t || held) return
    started.current = Date.now()
    const id = setTimeout(gone, duration)
    return () => clearTimeout(id)
  }, [t, held, gone, duration])
  if (!t) return null
  const bottom = props.dock
    ? 'calc(var(--tabbar-h) + var(--safe-bottom) + var(--dock-h) + 8px)'
    : 'calc(var(--tabbar-h) + var(--safe-bottom) + 8px)'
  return (
    <div className="pointer-events-none fixed inset-x-0 z-50 px-4" style={{ bottom }}>
      <div
        role="status"
        aria-live="polite"
        onPointerDown={() => setHeld(true)}
        onPointerUp={() => setHeld(false)}
        className="pointer-events-auto mx-auto flex min-h-14 w-full max-w-xl items-center justify-between rounded-[14px] bg-[var(--toast)] px-4 py-2 font-medium text-[var(--toast-foreground)]"
      >
        <span>{t.message}</span>
        {t.undo && (
          <button
            type="button"
            aria-label={t.actionLabel ?? '復原'}
            className="flex min-h-11 min-w-16 items-center justify-center font-bold text-[var(--toast-action)]"
            onClick={() => { void t.undo?.(); gone() }}
          >
            {t.actionLabel ?? '復原'}
          </button>
        )}
      </div>
    </div>
  )
}
