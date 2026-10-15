import type { Tab } from '@/types'
import { cn } from '@food-log/ui'

const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'trends', label: '趨勢' },
  { id: 'items', label: '品項' },
  { id: 'settings', label: '設定' },
]

export function TabBar(props: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(var(--tabbar-h)+var(--safe-bottom))] items-start justify-around border-t-[0.5px] border-border bg-card/94 pt-0 backdrop-blur pb-[var(--safe-bottom)]"
      aria-label="分頁"
    >
      {TABS.map((t) => {
        const on = props.tab === t.id
        return (
          <button
            key={t.id}
            type="button"
            aria-current={on ? 'page' : undefined}
            onClick={() => props.onChange(t.id)}
            aria-label={t.label}
            className={cn('flex min-h-11 min-w-16 items-center justify-center', on ? 'font-bold text-primary' : 'font-medium text-muted-foreground')}
          >
            {t.label}
          </button>
        )
      })}
    </nav>
  )
}
