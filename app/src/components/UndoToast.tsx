import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { Toast } from '@/types'

export function UndoToast(props: { toast: Toast | null; onGone: () => void; dock?: boolean; durationMs?: number }) {
  const [held, setHeld] = useState(false)
  const t = props.toast
  const id = t?.id ?? null
  const onGoneRef = useRef(props.onGone)
  onGoneRef.current = props.onGone
  const durationRef = useRef(3000)
  durationRef.current = t?.durationMs ?? props.durationMs ?? 3000
  const remainingRef = useRef(3000)
  const startedAtRef = useRef(0)
  const lastIdRef = useRef<string | null>(null)
  const goneForIdRef = useRef<string | null>(null)
  const originRef = useRef<{ x: number; y: number; at: number; pointerId: number } | null>(null)

  function dismiss() {
    if (!id || goneForIdRef.current === id) return
    goneForIdRef.current = id
    onGoneRef.current()
  }

  useEffect(() => {
    if (!id) {
      lastIdRef.current = null
      return
    }
    if (lastIdRef.current !== id) {
      lastIdRef.current = id
      remainingRef.current = durationRef.current
      if (held) setHeld(false)
    }
    if (goneForIdRef.current === id) return
    if (held) return
    startedAtRef.current = Date.now()
    const ms = remainingRef.current
    const handle = setTimeout(() => dismiss(), ms)
    return () => {
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current))
      clearTimeout(handle)
    }
    // Timer must follow toast id + hold only; onGone identity and the toast object must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, held])

  if (!t) return null
  const bottom = props.dock
    ? 'calc(var(--tabbar-h) + var(--safe-bottom) + var(--dock-h) + 8px)'
    : 'calc(var(--tabbar-h) + var(--safe-bottom) + 8px)'

  function isUndoButton(target: EventTarget | null) {
    return target instanceof Element && !!target.closest('button')
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (isUndoButton(e.target)) return
    originRef.current = {
      x: e.clientX ?? 0,
      y: e.clientY ?? 0,
      at: Date.now(),
      pointerId: e.pointerId ?? 0,
    }
    setHeld(true)
    const node = e.currentTarget
    if (typeof node.setPointerCapture === 'function') {
      try { node.setPointerCapture(e.pointerId) } catch { /* jsdom / inactive pointer */ }
    }
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const origin = originRef.current
    originRef.current = null
    const node = e.currentTarget
    if (typeof node.hasPointerCapture === 'function' && typeof node.releasePointerCapture === 'function') {
      try {
        if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId)
      } catch { /* jsdom */ }
    }
    const pid = e.pointerId ?? 0
    if (!origin || origin.pointerId !== pid) {
      setHeld(false)
      return
    }
    const dx = (e.clientX ?? 0) - origin.x
    const dy = (e.clientY ?? 0) - origin.y
    const dt = Date.now() - origin.at
    if (Math.hypot(dx, dy) < 10 && dt < 300) {
      setHeld(false)
      dismiss()
      return
    }
    if (dy > 24 && dy > Math.abs(dx)) {
      setHeld(false)
      dismiss()
      return
    }
    setHeld(false)
  }

  function onPointerCancel() {
    originRef.current = null
    setHeld(false)
  }

  function onPointerLeave(e: PointerEvent<HTMLDivElement>) {
    let captured = false
    const node = e.currentTarget
    if (typeof node.hasPointerCapture === 'function') {
      try { captured = node.hasPointerCapture(e.pointerId) } catch { /* jsdom */ }
    }
    if (captured) return
    originRef.current = null
    setHeld(false)
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 z-50 px-4" style={{ bottom }}>
      <div
        role="status"
        aria-live="polite"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        className="pointer-events-auto mx-auto flex min-h-14 w-full max-w-xl items-center justify-between rounded-[14px] bg-[var(--toast)] px-4 py-2 font-medium text-[var(--toast-foreground)]"
      >
        <span>{t.message}</span>
        {t.undo && (
          <button
            type="button"
            aria-label={t.actionLabel ?? '復原'}
            className="flex min-h-11 min-w-16 items-center justify-center font-bold text-[var(--toast-action)]"
            onClick={() => { void t.undo?.(); dismiss() }}
          >
            {t.actionLabel ?? '復原'}
          </button>
        )}
      </div>
    </div>
  )
}
