import type { RefObject } from 'react'
import type { MergedItem } from '@/types'

export function SearchDock(props: {
  chips: MergedItem[]
  onChip: (item: MergedItem) => void
  onSearch: () => void
  searchRef?: RefObject<HTMLButtonElement | null>
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-h)+var(--safe-bottom))] z-30 bg-gradient-to-t from-background via-background/90 to-transparent px-4 pb-2.5 pt-3.5">
      <div className="mx-auto w-full max-w-xl">
      <div className="pointer-events-auto mb-2.5 flex gap-2 overflow-x-auto [@media(max-height:500px)]:hidden" style={{ height: 44 }}>
        {props.chips.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => props.onChip(c)}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 font-semibold"
          >
            {c.name}
            <span className="tnum text-muted-foreground">{c.kcal}</span>
          </button>
        ))}
      </div>
      <button
        ref={props.searchRef}
        type="button"
        onClick={props.onSearch}
        className="pointer-events-auto flex h-12 w-full items-center rounded-full bg-secondary px-4 text-left text-muted-foreground"
      >
        搜尋 7-11、全家、我的品項
      </button>
      </div>
    </div>
  )
}
