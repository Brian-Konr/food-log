import { PenLine, Store } from 'lucide-react'
import { useDeferredValue, useMemo, useRef, type RefObject } from 'react'
import type { MergedItem, SearchFilter, StoreRecord } from '@/types'
import { formatMd } from '@/lib/format'
import { Sheet, SheetContent, SheetDescription, SheetTitle, cn } from '@food-log/ui'
import { ResultRow } from './ResultRow'
import { buildIndex, emptyQueryLists, matchingStores, recentCounts, searchItems, type IndexedItem } from '@/data/search'
import type { LogRecord } from '@/types'

const FILTERS: { id: SearchFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'fav', label: '收藏' },
  { id: 'store', label: '店家' },
  { id: '711', label: '7-11' },
  { id: 'familymart', label: '全家' },
]

function sortStores(stores: StoreRecord[]): StoreRecord[] {
  const live = stores.filter((s) => !s.deleted)
  return [...live].sort((a, b) => {
    if (a.last_eaten_at && b.last_eaten_at) return b.last_eaten_at.localeCompare(a.last_eaten_at)
    if (a.last_eaten_at && !b.last_eaten_at) return -1
    if (!a.last_eaten_at && b.last_eaten_at) return 1
    return a.name.localeCompare(b.name, 'zh-Hant')
  })
}

export function SearchSheet(props: {
  open: boolean
  onOpenChange: (v: boolean) => void
  items: MergedItem[]
  stores: StoreRecord[]
  indexed?: IndexedItem[]
  logs: LogRecord[]
  today: string
  remainLine: string
  query: string
  onQuery: (q: string) => void
  filter: SearchFilter
  onFilter: (f: SearchFilter) => void
  onSelect: (item: MergedItem) => void
  onManual: (name: string) => void
  onQuick: () => void
  onOpenStore: (id: string) => void
  onAddStore: () => void
  inputRef?: RefObject<HTMLInputElement | null>
}) {
  const deferred = useDeferredValue(props.query)
  const localIndex = useMemo(() => props.indexed ?? buildIndex(props.items), [props.indexed, props.items])
  const recent = useMemo(() => recentCounts(props.logs, props.today), [props.logs, props.today])
  const hits = useMemo(
    () => searchItems(localIndex, deferred, { filter: props.filter, recent }),
    [localIndex, deferred, props.filter, recent],
  )
  const empty = useMemo(() => emptyQueryLists(props.items, props.logs, props.today), [props.items, props.logs, props.today])
  const q = deferred.trim()
  const fallbackRef = useRef<HTMLInputElement>(null)
  const inputRef = props.inputRef ?? fallbackRef
  const freqStores = sortStores(props.stores).slice(0, 8)
  const matched = q ? matchingStores(props.stores, q) : []
  const lastByItem = useMemo(() => {
    const m = new Map<string, LogRecord>()
    for (const l of props.logs) {
      if (l.deleted || !l.item_id) continue
      const prev = m.get(l.item_id)
      if (!prev || l.ts > prev.ts) m.set(l.item_id, l)
    }
    return m
  }, [props.logs])

  function rowFor(item: MergedItem) {
    const last = lastByItem.get(item.id)
    const lastLabel = last ? `上次 ${formatMd(last.ts)}` : undefined
    return (
      <ResultRow
        key={item.id}
        item={item}
        storeName={item.storeName || undefined}
        lastLabel={item.storeId ? lastLabel : undefined}
        onSelect={props.onSelect}
      />
    )
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="top-[calc(var(--safe-top)+8px)] bottom-0 h-auto">
        <SheetTitle className="sr-only">搜尋品項</SheetTitle>
        <SheetDescription className="px-4 text-center text-muted-foreground">{props.remainLine}</SheetDescription>
        <div className="flex items-center gap-2 px-4 py-2">
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            inputMode="search"
            value={props.query}
            onChange={(e) => props.onQuery(e.target.value)}
            placeholder="搜尋店家、7-11、全家、我的品項"
            className="h-12 min-w-0 flex-1 rounded-full bg-secondary px-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          />
          <button type="button" aria-label="取消" className="h-11 min-w-11 px-2" onClick={() => props.onOpenChange(false)}>取消</button>
        </div>
        <div className="flex gap-2 overflow-x-auto px-4 pb-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => props.onFilter(f.id)}
              className={cn('h-11 shrink-0 rounded-full border border-border px-4 font-medium', props.filter === f.id && 'bg-foreground text-background')}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {q ? (
            <>
              {matched.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="flex min-h-[60px] w-full items-center gap-2 px-4 text-left font-semibold"
                  onClick={() => props.onOpenStore(s.id)}
                >
                  <Store size={16} aria-hidden />
                  打開 {s.name}
                </button>
              ))}
              {hits.length === 0 && matched.length === 0 ? (
                <div className="px-4 py-6">
                  <p>找不到「{props.query}」</p>
                  <button type="button" className="mt-3 h-12 w-full rounded-full bg-secondary font-semibold" onClick={() => props.onManual(props.query)}>
                    手動新增品項
                  </button>
                </div>
              ) : (
                <>
                  {hits.some((h) => h.group === 'fav-recent') && <div className="px-4 py-2 font-semibold text-muted-foreground">收藏・最近吃過</div>}
                  {hits.filter((h) => h.group === 'fav-recent').map((h) => rowFor(h.item))}
                  {hits.some((h) => h.group === 'store') && <div className="px-4 py-2 font-semibold text-muted-foreground">7-11・全家</div>}
                  {hits.filter((h) => h.group === 'store').map((h) => rowFor(h.item))}
                </>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                aria-label="不指定店家"
                className="flex min-h-11 w-full items-center gap-2 px-4 text-left text-muted-foreground"
                onClick={props.onQuick}
              >
                <PenLine size={16} aria-hidden />
                不指定店家
              </button>
              <div className="px-4 py-2 font-semibold text-muted-foreground">常吃店家</div>
              <div className="flex gap-2 overflow-x-auto px-4 py-2">
                {freqStores.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => props.onOpenStore(s.id)}
                    className="flex h-11 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3.5 font-semibold"
                  >
                    <Store size={16} aria-hidden />
                    {s.name}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="＋ 新增店家"
                  onClick={props.onAddStore}
                  className="flex h-11 shrink-0 items-center rounded-full border border-border bg-card px-3.5 font-semibold"
                >
                  ＋ 新增店家
                </button>
              </div>
              <div className="px-4 py-2 font-semibold text-muted-foreground">收藏</div>
              {empty.fav.map((i) => rowFor(i))}
              <div className="px-4 py-2 font-semibold text-muted-foreground">最近吃過</div>
              {empty.recent.map((i) => rowFor(i))}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
