import { useEffect, useRef, useState } from 'react'
import type { LoadState } from '@/data/loadstate'
import { cn } from '@food-log/ui'

export function SyncBadge(props: {
  loadState: LoadState
  pending: number
  online: boolean
  onRetry: () => void
  retrying?: boolean
}) {
  const [showSyncing, setShowSyncing] = useState(false)
  const [phase, setPhase] = useState<'hidden' | 'syncing' | 'done'>('hidden')
  const seenSyncing = useRef(false)
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (props.loadState === 'cached-syncing') {
      const t = setTimeout(() => {
        setShowSyncing(true)
        seenSyncing.current = true
        setPhase('syncing')
      }, 300)
      return () => clearTimeout(t)
    }
    setShowSyncing(false)
    if (props.loadState === 'fresh' && seenSyncing.current) {
      setPhase('done')
      const hide = () => { setPhase('hidden'); seenSyncing.current = false }
      if (reduce) { hide(); return }
      const t = setTimeout(() => {
        const t2 = setTimeout(hide, 250)
        return () => clearTimeout(t2)
      }, 1000)
      return () => clearTimeout(t)
    }
    if (props.loadState === 'fresh') setPhase('hidden')
  }, [props.loadState, reduce])

  const errorCached = props.loadState === 'error-cached'
  const offlinePending = !props.online && props.pending > 0
  let text = ''
  let destructive = false
  let muted = false
  if (errorCached) { text = props.retrying ? '重試中…' : '沒有同步 · 重試'; destructive = true }
  else if (offlinePending) { text = `離線 · ${props.pending} 筆待上傳`; muted = true }
  else if (showSyncing && props.loadState === 'cached-syncing') text = '同步中'
  else if (phase === 'done') text = '已同步'
  if (!text) return null

  const clickable = errorCached
  return (
    <button
      type="button"
      role="status"
      aria-live="polite"
      disabled={props.retrying || !clickable}
      onClick={() => { if (clickable) props.onRetry() }}
      className={cn(
        'flex h-11 shrink-0 items-center whitespace-nowrap px-1',
        clickable ? 'cursor-pointer' : 'pointer-events-none',
      )}
    >
      <span className={cn(
        'flex h-8 items-center gap-1.5 rounded-full border border-input bg-secondary px-3 text-base font-semibold',
        destructive ? 'text-destructive' : muted ? 'text-muted-foreground' : 'text-foreground',
        phase === 'done' && !reduce && 'transition-opacity duration-[250ms]',
      )}>
        <span
          className={cn(
            'size-3 shrink-0 rounded-full',
            destructive ? 'bg-destructive' : muted ? 'bg-muted-foreground' : 'bg-primary',
            text === '同步中' && !reduce && 'sync-dot',
          )}
          aria-hidden
        />
        {text}
      </span>
    </button>
  )
}
