import { formatInt } from '@/lib/format'
import { cn } from '@/lib/utils'

export function TrendKpi(props: {
  label: string
  value: string
  unit?: string
  over?: boolean
  protein?: boolean
}) {
  return (
    <div className="rounded-2xl bg-card px-3 py-2.5">
      <div className="text-base text-muted-foreground">{props.label}</div>
      <div className={cn('text-[22px] font-bold tnum', props.over && 'text-[var(--over)]', props.protein && 'text-[var(--macro-protein)]')}>
        {props.value}
        {props.unit && <span className="ml-1 text-base font-medium text-muted-foreground">{props.unit}</span>}
      </div>
    </div>
  )
}

export function formatKpiKcal(n: number | null): string {
  return n == null ? '—' : formatInt(n)
}
