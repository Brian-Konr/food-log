import type { MergedItem } from '@/types'
import { formatMacro } from '@/lib/format'
import { cn } from '@food-log/ui'

export function ResultRow(props: {
  item: MergedItem
  onSelect: (item: MergedItem) => void
  storeName?: string
  lastLabel?: string
  hideStoreName?: boolean
  onOpenStore?: () => void
}) {
  const { item } = props
  const storeName = props.storeName ?? (props.hideStoreName ? '' : item.storeName)
  const isStoreItem = !!item.storeId
  const bits = isStoreItem
    ? [
        '店家',
        props.lastLabel,
        item.createdBy === 'kyujin' ? 'Kyujin 建檔' : null,
      ]
    : [
        item.fav ? '★' : null,
        item.src === 'custom' ? item.sheetSrc : item.sheetSrc,
        item.serving,
        item.needsFill ? '要補營養素' : null,
        item.createdBy === 'kyujin' ? 'Kyujin 建檔' : null,
      ]
  const visibleBits = bits.filter(Boolean) as string[]
  const aria = isStoreItem && storeName
    ? `${storeName}，${item.name}，店家品項，${item.kcal} 大卡，蛋白質 ${formatMacro(item.protein ?? 0)} 公克`
    : undefined
  return (
    <button
      type="button"
      aria-label={aria}
      onClick={() => props.onSelect(item)}
      className="flex min-h-[60px] w-full items-center gap-3 px-4 py-2 text-left"
    >
      <div className="min-w-0 flex-1">
        {storeName && !props.hideStoreName ? (
          <div className="flex min-w-0 items-baseline">
            <span className="truncate font-medium text-muted-foreground">{storeName}</span>
            <span className="shrink-0 font-semibold">{'\u00a0·\u00a0'}{item.name}</span>
          </div>
        ) : (
          <div className="truncate font-semibold">{item.name}</div>
        )}
        <div className="truncate text-muted-foreground">
          {item.fav && !isStoreItem && <span className="sr-only">收藏</span>}
          {visibleBits.map((t, i) => (
            <span key={i} className={cn((t === '要補營養素' || t === 'Kyujin 建檔') && 'text-[var(--over)]')}>
              {i > 0 ? ' · ' : ''}{t === '★' ? '★' : t}
            </span>
          ))}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="tnum font-semibold">{item.kcal}</div>
        <div className="text-muted-foreground tnum">{item.protein == null ? '—' : `蛋白 ${formatMacro(item.protein)} g`}</div>
      </div>
    </button>
  )
}
