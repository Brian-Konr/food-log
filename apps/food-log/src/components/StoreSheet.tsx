import { useMemo, useState } from 'react'
import type { LogRecord, MergedItem, StoreRecord } from '@/types'
import { formatMd, formatQty, formatShortDate } from '@/lib/format'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@food-log/ui'
import { ResultRow } from './ResultRow'

function lastLogFor(itemId: string, logs: LogRecord[]): LogRecord | undefined {
  return [...logs].filter((l) => !l.deleted && l.item_id === itemId).sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)
}

export function StoreSheet(props: {
  open: boolean
  store: StoreRecord | null
  items: MergedItem[]
  logs: LogRecord[]
  remainLine: string
  onOpenItem: (item: MergedItem) => void
  onAddItem: () => void
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const [menu, setMenu] = useState(false)
  const store = props.store
  const sorted = useMemo(() => {
    return [...props.items].sort((a, b) => {
      const la = lastLogFor(a.id, props.logs)
      const lb = lastLogFor(b.id, props.logs)
      if (la && lb) return lb.ts.localeCompare(la.ts)
      if (la && !lb) return -1
      if (!la && lb) return 1
      return a.name.localeCompare(b.name, 'zh-Hant')
    })
  }, [props.items, props.logs])

  if (!store) return null
  const last = store.last_eaten_at
  const lastLine = last ? `上次 ${formatShortDate(last.slice(0, 10))}` : '還沒吃過'

  return (
    <Sheet open={props.open} onOpenChange={(v) => { if (!v) { setMenu(false); props.onClose() } }}>
      <SheetContent className="top-[calc(var(--safe-top)+8px)] bottom-0 h-auto">
        <SheetDescription className="px-4 text-center text-muted-foreground">{props.remainLine}</SheetDescription>
        {menu ? (
          <div className="px-4 pb-4">
            <SheetTitle className="sr-only">店家選項</SheetTitle>
            <button type="button" className="h-12 w-full rounded-[var(--radius)] bg-secondary font-semibold" onClick={() => { setMenu(false); props.onRename() }}>改名</button>
            <button type="button" className="mt-2 h-12 w-full rounded-[var(--radius)] bg-secondary font-semibold text-destructive" onClick={() => { setMenu(false); props.onDelete() }}>刪除店家</button>
            <button type="button" className="mt-2 h-12 w-full" onClick={() => setMenu(false)}>取消</button>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between px-4">
              <div className="min-w-0">
                <SheetTitle className="text-[20px] font-bold">{store.name}</SheetTitle>
                <p className="text-muted-foreground">{lastLine}</p>
              </div>
              <button type="button" aria-label="店家選項" className="grid size-11 shrink-0 place-items-center" onClick={() => setMenu(true)}>⋯</button>
            </div>
            <div className="mt-2">
              {sorted.length === 0 && <p className="px-4 py-4 text-muted-foreground">這家店還沒有品項</p>}
              {sorted.map((item) => {
                const lastL = lastLogFor(item.id, props.logs)
                const lastLabel = lastL
                  ? `上次 ${formatMd(lastL.ts)} · ${formatQty(lastL.qty, lastL.grams)}`
                  : undefined
                return (
                  <ResultRow
                    key={item.id}
                    item={item}
                    hideStoreName
                    lastLabel={lastLabel}
                    onSelect={props.onOpenItem}
                  />
                )
              })}
              <button
                type="button"
                aria-label="＋ 新增品項"
                className="flex min-h-[60px] w-full items-center px-4 text-left font-semibold text-primary"
                onClick={props.onAddItem}
              >
                ＋ 新增品項
              </button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
