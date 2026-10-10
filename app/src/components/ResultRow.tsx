import type { MergedItem } from '@/types'
import { formatMacro } from '@/lib/format'
import { cn } from '@/lib/utils'

export function ResultRow(props: { item: MergedItem; onSelect: (item: MergedItem) => void }) {
  const { item } = props
  const bits = [
    item.fav ? '★' : null,
    item.src === 'custom' ? item.sheetSrc : item.sheetSrc,
    item.serving,
    item.needsFill ? '要補營養素' : null,
    item.createdBy === 'kyujin' ? 'Kyujin 建檔' : null,
  ].filter(Boolean) as string[]
  return (
    <button
      type="button"
      onClick={() => props.onSelect(item)}
      className="flex min-h-[60px] w-full items-center gap-3 px-4 py-2 text-left"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{item.name}</div>
        <div className="truncate text-muted-foreground">
          {item.fav && <span className="sr-only">收藏</span>}
          {bits.map((t, i) => (
            <span key={i} className={cn((t === '要補營養素' || t === 'Kyujin 建檔') && 'text-[var(--over)]')}>
              {i > 0 ? ' · ' : ''}{t === '★' ? '★' : t}
            </span>
          ))}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="tnum font-semibold">{item.kcal}</div>
        <div className="text-muted-foreground tnum">{item.protein == null ? '—' : `${formatMacro(item.protein)} g`}</div>
      </div>
    </button>
  )
}
