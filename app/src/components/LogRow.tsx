import type { LogRecord, MergedItem } from '@/types'
import { formatHm, formatQty } from '@/lib/format'
import { formatMacro } from '@/lib/format'
import { cn } from '@/lib/utils'

export function LogRow(props: {
  log: LogRecord
  item?: MergedItem | null
  onOpen: (log: LogRecord) => void
  onSwipeDelete?: (log: LogRecord) => void
}) {
  const { log, item } = props
  const src = log.src
  const qty = formatQty(log.qty, log.grams)
  const kyujin = item?.createdBy === 'kyujin'
  const pending = !!log.__pending
  const tags = [
    `${src} · ${qty}`,
    kyujin ? 'Kyujin 建檔' : null,
    pending ? '待上傳' : null,
  ].filter(Boolean) as string[]
  return (
    <button
      type="button"
      onClick={() => props.onOpen(log)}
      className="flex min-h-[60px] w-full items-center gap-3 border-b border-border px-4 py-2 text-left last:border-b-0"
    >
      <div className="w-[46px] shrink-0 text-muted-foreground tnum">{formatHm(log.ts)}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{log.name}</div>
        <div className="truncate text-muted-foreground">
          {tags.map((t, i) => (
            <span key={i}>
              {i > 0 ? ' · ' : ''}
              <span className={cn((t === 'Kyujin 建檔' || t === '待上傳') && 'text-[var(--over)]')}>{t === '待上傳' ? <span className="text-muted-foreground">待上傳</span> : t}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-semibold tnum">{log.kcal}</div>
        <div className="text-muted-foreground tnum">{Number.isFinite(log.protein) ? `${formatMacro(log.protein)} g 蛋白` : '—'}</div>
      </div>
    </button>
  )
}
