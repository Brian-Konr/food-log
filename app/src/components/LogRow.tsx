import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import type { LogRecord, MergedItem, StoreRecord } from '@/types'
import { formatHm, formatQty } from '@/lib/format'
import { formatMacro } from '@/lib/format'
import { cn } from '@/lib/utils'

export function LogRow(props: {
  log: LogRecord
  item?: MergedItem | null
  stores?: StoreRecord[]
  onOpen: (log: LogRecord) => void
  now?: number
  onSwipeDelete?: (log: LogRecord) => void
}) {
  const { log } = props
  const quick = log.item_id === '' || log.source === 'quick'
  const title = (log.name || '').trim() || (quick ? '快速記錄' : log.name)
  const storeName = log.store ? props.stores?.find((s) => s.id === log.store)?.name : ''
  const qty = formatQty(log.qty, log.grams)
  const pending = log.__write === 'pending' || !!log.__pending
  const failed = log.__write === 'failed'
  const queuedAt = log.__queuedAt ? Date.parse(log.__queuedAt) : 0
  const showPending = pending && !failed && props.now != null && queuedAt > 0 && props.now - queuedAt > 3000
  let second: ReactNode
  if (failed) {
    second = (
      <span className="flex items-center gap-1 text-destructive">
        <AlertCircle size={16} aria-hidden />
        沒有存到 · 重試
      </span>
    )
  } else if (quick) {
    second = <>1 筆{showPending ? <span className="text-muted-foreground"> · 待上傳</span> : null}</>
  } else if (storeName) {
    second = <>{storeName} · {qty}{showPending ? <span className="text-muted-foreground"> · 待上傳</span> : null}</>
  } else {
    second = <>{log.src} · {qty}{showPending ? <span className="text-muted-foreground"> · 待上傳</span> : null}</>
  }
  const fading = log.deleted
  return (
    <button
      type="button"
      onClick={() => props.onOpen(log)}
      className={cn(
        'flex min-h-[60px] w-full scroll-mb-[calc(var(--dock-h)+var(--tabbar-h)+var(--safe-bottom)+80px)] items-center gap-3 border-b border-border px-4 py-2 text-left last:border-b-0',
        fading && 'row-out',
        !fading && pending && 'row-in',
      )}
    >
      <div className="w-[46px] shrink-0 text-muted-foreground tnum">{formatHm(log.ts)}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{title}</div>
        <div className="truncate text-muted-foreground">{second}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-semibold tnum">{log.kcal}</div>
        <div className="text-muted-foreground tnum">{Number.isFinite(log.protein) ? `蛋白 ${formatMacro(log.protein)} g` : '—'}</div>
      </div>
    </button>
  )
}
