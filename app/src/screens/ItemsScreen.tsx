import type { MergedItem } from '@/types'
import { ResultRow } from '@/components/ResultRow'

export function ItemsScreen(props: {
  items: MergedItem[]
  onUnfav: (item: MergedItem) => void
  onEdit: (item: MergedItem) => void
  onDelete: (item: MergedItem) => void
  onCreate: () => void
}) {
  const fav = props.items.filter((i) => i.fav)
  const mine = props.items.filter((i) => i.src === 'custom')
  return (
    <div className="px-4 pb-[calc(var(--tabbar-h)+var(--safe-bottom)+16px)] pt-2">
      <h1 className="text-[34px] font-bold">品項</h1>
      <h2 className="mt-4 font-bold">收藏</h2>
      <div className="mt-2 overflow-hidden rounded-[var(--radius)] border border-border bg-card">
        {fav.length === 0 ? <p className="px-4 py-4 text-muted-foreground">還沒有收藏</p> : fav.map((i) => (
          <div key={i.id} className="flex items-center border-b border-border last:border-0">
            <div className="min-w-0 flex-1"><ResultRow item={i} onSelect={props.onEdit} /></div>
            <button type="button" className="h-11 px-3" onClick={() => props.onUnfav(i)}>取消收藏</button>
          </div>
        ))}
      </div>
      <h2 className="mt-6 font-bold">我的品項</h2>
      <div className="mt-2 overflow-hidden rounded-[var(--radius)] border border-border bg-card">
        {mine.length === 0 ? <p className="px-4 py-4 text-muted-foreground">還沒有自建品項</p> : mine.map((i) => (
          <div key={i.id} className="flex items-center border-b border-border last:border-0">
            <div className="min-w-0 flex-1">
              <ResultRow item={i} onSelect={props.onEdit} />
            </div>
            <button type="button" className="h-11 px-3 text-destructive" onClick={() => props.onDelete(i)}>刪除</button>
          </div>
        ))}
      </div>
      <button type="button" className="mt-6 h-12 w-full rounded-full bg-primary font-bold text-primary-foreground" onClick={props.onCreate}>
        手動新增品項
      </button>
    </div>
  )
}
