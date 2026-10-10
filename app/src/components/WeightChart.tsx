import type { WeightSeries } from '@/types'
import { addDays } from '@/lib/day'

export function WeightChart(props: { series: WeightSeries; today: string; summary?: string }) {
  const start = addDays(props.today, -28)
  const days: string[] = []
  for (let d = start; d <= props.today; d = addDays(d, 1)) days.push(d)
  const kgs = [
    ...props.series.points.map((p) => p.kg),
    ...props.series.avg7.map((p) => p.kg),
    ...props.series.expected.map((p) => p.kg),
  ]
  // y 軸只框住實際範圍（上下各留 0.3 kg，至少 2 kg 寬），線才看得出起伏
  const lo = kgs.length ? Math.min(...kgs) : 0
  const hi = kgs.length ? Math.max(...kgs) : 1
  const mid = (lo + hi) / 2
  const half = Math.max((hi - lo) / 2 + 0.3, 1)
  const min = mid - half
  const max = mid + half
  const x = (day: string) => (days.indexOf(day) / Math.max(days.length - 1, 1)) * 280
  const y = (kg: number) => 100 - ((kg - min) / (max - min || 1)) * 90
  const line = (pts: { day: string; kg: number }[]) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day)},${y(p.kg)}`).join(' ')
  return (
    <svg role="img" aria-labelledby="wchart-title wchart-desc" viewBox="0 0 280 110" className="h-40 w-full">
      <title id="wchart-title">體重・近 4 週</title>
      <desc id="wchart-desc">{props.summary ?? '每天的體重點、7 日平均線，以及依赤字推算的預期線（虛線）'}</desc>
      {props.series.expected.length > 1 && (
        <path d={line(props.series.expected)} fill="none" stroke="var(--chart-expected)" strokeWidth="2" strokeDasharray="6 5" />
      )}
      {props.series.avg7.length > 1 && (
        <path d={line(props.series.avg7)} fill="none" stroke="var(--chart-weight-avg)" strokeWidth="3" />
      )}
      {props.series.points.map((p) => (
        <circle key={p.day} cx={x(p.day)} cy={y(p.kg)} r="3" fill="var(--chart-weight)" />
      ))}
    </svg>
  )
}
