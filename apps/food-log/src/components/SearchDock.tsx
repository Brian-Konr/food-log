import type { RefObject } from 'react'
import type { MergedItem } from '@/types'
import { StoreChip } from './StoreChips'

export type DockChip =
  | { kind: 'store'; id: string; name: string }
  | { kind: 'item'; item: MergedItem }

export function SearchDock(props: {
  chips: DockChip[]
  onStore: (id: string) => void
  onItem: (item: MergedItem) => void
  onSearch: () => void
  searchRef?: RefObject<HTMLButtonElement | null>
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+var(--safe-bottom))] z-30 bg-gradient-to-t from-background via-background/90 to-transparent px-4 pb-2.5 pt-3.5">
      <div className="mx-auto w-full max-w-xl">
      <div className="pointer-events-auto mb-2.5 flex gap-2 overflow-x-auto [@media(max-height:500px)]:hidden" style={{ height: 44 }}>
        {props.chips.map((c) => c.kind === 'store' ? (
          <StoreChip key={c.id} name={c.name} onClick={() => props.onStore(c.id)} />
        ) : (
          <button
            key={c.item.id}
            type="button"
            onClick={() => props.onItem(c.item)}
            className="flex h-11 max-w-[13.5rem] shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 font-semibold"
          >
            <span className="min-w-0 truncate">{c.item.name}</span>
            <span className="tnum shrink-0 text-muted-foreground">{c.item.kcal}</span>
          </button>
        ))}
      </div>
      <button
        ref={props.searchRef}
        type="button"
        aria-label="搜尋店家、7-11、全家、我的品項"
        onClick={props.onSearch}
        className="pointer-events-auto flex h-12 w-full items-center rounded-full bg-secondary px-4 text-left text-muted-foreground"
      >
        搜尋店家、7-11、全家、我的品項
      </button>
      </div>
    </div>
  )
}
