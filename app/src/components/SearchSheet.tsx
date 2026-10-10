import { useDeferredValue, useMemo, useRef, type RefObject } from 'react'
import type { MergedItem, SearchFilter } from '@/types'
import { formatRemain } from '@/lib/nutrition'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './ui/sheet'
import { ResultRow } from './ResultRow'
import { buildIndex, emptyQueryLists, recentCounts, searchItems, type IndexedItem } from '@/data/search'
import type { LogRecord } from '@/types'
import { cn } from '@/lib/utils'

const FILTERS: { id: SearchFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'fav', label: '收藏' },
  { id: '711', label: '7-11' },
  { id: 'familymart', label: '全家' },
]

export function SearchSheet(props: {
  open: boolean
  onOpenChange: (v: boolean) => void
  items: MergedItem[]
  indexed?: IndexedItem[]
  logs: LogRecord[]
  today: string
  remain: { kcal: number; protein: number }
  query: string
  onQuery: (q: string) => void
  filter: SearchFilter
  onFilter: (f: SearchFilter) => void
  onSelect: (item: MergedItem) => void
  onManual: (name: string) => void
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
  const remainLine = `${formatRemain(props.remain.kcal, 'kcal')} · ${formatRemain(props.remain.protein, 'g')} 蛋白質`

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="top-[calc(var(--safe-top)+8px)] bottom-0 h-auto">
        <SheetTitle className="sr-only">搜尋品項</SheetTitle>
        <SheetDescription className="px-4 text-center text-muted-foreground">{remainLine}</SheetDescription>
        <div className="flex items-center gap-2 px-4 py-2">
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            inputMode="search"
            value={props.query}
            onChange={(e) => props.onQuery(e.target.value)}
            placeholder="搜尋品項"
            className="h-12 min-w-0 flex-1 rounded-full bg-secondary px-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          />
          <button type="button" className="h-11 min-w-11 px-2" onClick={() => props.onOpenChange(false)}>取消</button>
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
            hits.length === 0 ? (
              <div className="px-4 py-6">
                <p>找不到「{props.query}」</p>
                <button type="button" className="mt-3 h-12 w-full rounded-full bg-secondary font-semibold" onClick={() => props.onManual(props.query)}>
                  手動新增品項
                </button>
              </div>
            ) : (
              <>
                {hits.some((h) => h.group === 'fav-recent') && <div className="px-4 py-2 font-semibold text-muted-foreground">收藏・最近吃過</div>}
                {hits.filter((h) => h.group === 'fav-recent').map((h) => <ResultRow key={h.item.id} item={h.item} onSelect={props.onSelect} />)}
                {hits.some((h) => h.group === 'store') && <div className="px-4 py-2 font-semibold text-muted-foreground">7-11・全家</div>}
                {hits.filter((h) => h.group === 'store').map((h) => <ResultRow key={h.item.id} item={h.item} onSelect={props.onSelect} />)}
              </>
            )
          ) : (
            <>
              <div className="px-4 py-2 font-semibold text-muted-foreground">收藏</div>
              {empty.fav.map((i) => <ResultRow key={i.id} item={i} onSelect={props.onSelect} />)}
              <div className="px-4 py-2 font-semibold text-muted-foreground">最近吃過</div>
              {empty.recent.map((i) => <ResultRow key={i.id} item={i} onSelect={props.onSelect} />)}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
