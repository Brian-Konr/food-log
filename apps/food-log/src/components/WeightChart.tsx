import type { WeightSeries } from '@/types'
import { addDays } from '@/lib/day'
import { formatKg, formatMd } from '@/lib/format'
import { weightYTicks } from '@/lib/trends'
import { cn } from '@food-log/ui'

export function WeightChart(props: { series: WeightSeries; today: string; spanDays: number; summary: string }) {
  const start = addDays(props.today, -(props.spanDays - 1))
  const days: string[] = []
  for (let d = start; d <= props.today; d = addDays(d, 1)) days.push(d)
  const inDays = new Set(days)
  const points = props.series.points.filter((p) => inDays.has(p.day))
  const avg7 = props.series.avg7.filter((p) => inDays.has(p.day))
  const expected = props.series.expected.filter((p) => inDays.has(p.day))
  const mid = days[Math.floor((props.spanDays - 1) / 2)]
  const xLabels = (
    <div className="mt-1 flex justify-between text-base text-muted-foreground tnum">
      <span>{formatMd(start)}</span>
      <span>{formatMd(mid)}</span>
      <span>今天</span>
    </div>
  )

  if (!points.length) {
    return (
      <div>
        <div className="flex">
          <div className="h-40 w-14 shrink-0" />
          <div className="flex h-40 min-w-0 flex-1 items-center justify-center">
            <p className="text-muted-foreground">這段期間沒有體重紀錄</p>
          </div>
        </div>
        <div className="flex">
          <div className="w-14 shrink-0" />
          <div className="min-w-0 flex-1">{xLabels}</div>
        </div>
      </div>
    )
  }

  const drawAvg = points.length >= 2 && avg7.length >= 2
  const drawExpected = points.length >= 2 && expected.length >= 2
  const values = points.length === 1
    ? [points[0].kg]
    : [
        ...points.map((p) => p.kg),
        ...(drawAvg ? avg7.map((p) => p.kg) : []),
        ...(drawExpected ? expected.map((p) => p.kg) : []),
      ]
  const { min, max, ticks } = weightYTicks(values)
  const span = Math.max(props.spanDays - 1, 1)
  const xOf = (day: string) => (days.indexOf(day) / span) * 100
  const yOf = (kg: number) => ((max - kg) / (max - min || 1)) * 100
  const line = (pts: { day: string; kg: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.day)},${yOf(p.kg)}`).join(' ')

  return (
    <div>
      <div className="flex">
        <div className="relative h-40 w-14 shrink-0">
          {[ticks[2], ticks[1], ticks[0]].map((kg) => (
            <span
              key={kg}
              className="absolute right-1 text-base text-muted-foreground tnum -translate-y-1/2"
              style={{ top: `${yOf(kg)}%` }}
            >
              {formatKg(kg)}
            </span>
          ))}
        </div>
        <div className="relative h-40 min-w-0 flex-1">
          <svg
            role="img"
            aria-labelledby="wchart-title wchart-desc"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
          >
            <title id="wchart-title">體重（kg）</title>
            <desc id="wchart-desc">{props.summary}</desc>
            {ticks.map((kg) => (
              <line
                key={kg}
                x1="0"
                x2="100"
                y1={yOf(kg)}
                y2={yOf(kg)}
                stroke="var(--border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {drawExpected && (
              <path
                d={line(expected)}
                fill="none"
                stroke="var(--chart-expected)"
                strokeWidth="2"
                strokeDasharray="6 5"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {drawAvg && (
              <path
                d={line(avg7)}
                fill="none"
                stroke="var(--chart-weight-avg)"
                strokeWidth="3"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {points.map((p) => (
            <span
              key={p.day}
              className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--chart-weight)]"
              style={{ left: `${xOf(p.day)}%`, top: `${yOf(p.kg)}%` }}
            />
          ))}
          {points.length === 1 && (
            <span
              className={cn(
                'absolute text-base tnum text-foreground -translate-y-1/2',
                xOf(points[0].day) > 70 ? '-translate-x-full pr-2' : 'pl-2',
              )}
              style={{ left: `${xOf(points[0].day)}%`, top: `${yOf(points[0].kg)}%` }}
            >
              {formatKg(points[0].kg)}
            </span>
          )}
        </div>
      </div>
      <div className="flex">
        <div className="w-14 shrink-0" />
        <div className="min-w-0 flex-1">{xLabels}</div>
      </div>
    </div>
  )
}
