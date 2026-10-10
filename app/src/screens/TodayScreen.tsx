import { Scale } from 'lucide-react'
import type { LogRecord, MergedItem } from '@/types'
import { formatLongDate } from '@/lib/format'
import { RemainingSummary } from '@/components/RemainingSummary'
import { LogRow } from '@/components/LogRow'

export function TodayScreen(props: {
  today: string
  remain: { kcal: number; protein: number; fat: number; carb: number }
  eaten: { kcal: number; protein: number; fat: number; carb: number }
  targets: { kcal: number; protein: number; fat: number; carb: number }
  logs: LogRecord[]
  itemsById: Map<string, MergedItem>
  onWeight: () => void
  onOpenLog: (log: LogRecord) => void
}) {
  const live = props.logs.filter((l) => !l.deleted).sort((a, b) => a.ts.localeCompare(b.ts))
  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-[calc(var(--dock-h)+var(--tabbar-h)+var(--safe-bottom)+16px)] pt-1">
      <div className="flex items-center justify-between py-2">
        <span className="font-medium text-muted-foreground">{formatLongDate(props.today)}</span>
        <button type="button" aria-label="記體重" onClick={props.onWeight} className="grid size-11 place-items-center text-muted-foreground">
          <Scale size={22} strokeWidth={2} />
        </button>
      </div>
      <RemainingSummary remain={props.remain} eaten={props.eaten} targets={props.targets} />
      <div className="mt-5 flex items-center justify-between px-2">
        <h2 className="text-xl font-bold">今天的紀錄</h2>
        <span className="text-muted-foreground">{live.length} 筆</span>
      </div>
      <div className="mt-2 overflow-hidden rounded-[var(--radius)] border border-border bg-card">
        {live.length === 0 ? (
          <p className="px-4 py-6 text-muted-foreground">今天還沒有紀錄</p>
        ) : live.map((l) => (
          <LogRow key={l.id} log={l} item={props.itemsById.get(l.item_id)} onOpen={props.onOpenLog} />
        ))}
      </div>
    </div>
  )
}
