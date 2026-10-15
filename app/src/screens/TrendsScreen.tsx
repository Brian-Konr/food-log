import { useMemo, useState } from 'react'
import type { LogRecord, WeightRecord, WeightSeries } from '@/types'
import type { LoadState } from '@/data/loadstate'
import { addDays, weekStart } from '@/lib/day'
import { formatInt, formatKg, formatShortDate } from '@/lib/format'
import { parseTargets } from '@/lib/nutrition'
import { trendsView, WEIGHT_RANGE_DAYS, type WeightRange } from '@/lib/trends'
import { TrendKpi } from '@/components/TrendKpi'
import { KcalBarChart } from '@/components/KcalBarChart'
import { WeightChart } from '@/components/WeightChart'
import { SyncBadge } from '@/components/SyncBadge'
import { SkeletonBlock } from '@/components/SkeletonBlock'
import { cn } from '@/lib/utils'

const RANGE_UI: Record<WeightRange, string> = { '1W': '1 週', '1M': '1 個月', '3M': '3 個月' }
const RANGE_THIS: Record<WeightRange, string> = { '1W': '這 1 週', '1M': '這 1 個月', '3M': '這 3 個月' }

function weightChartSummary(w: WeightSeries, range: WeightRange): string {
  const span = RANGE_UI[range]
  if (w.startAvg != null && w.endAvg != null) {
    const a = Math.round(w.startAvg * 10) / 10
    const b = Math.round(w.endAvg * 10) / 10
    if (b < a) return `過去 ${span}體重從 ${formatKg(a)} 降到 ${formatKg(b)} kg`
    if (b > a) return `過去 ${span}體重從 ${formatKg(a)} 升到 ${formatKg(b)} kg`
    return `過去 ${span}體重 ${formatKg(b)} kg，沒有變化`
  }
  return `過去 ${span}還沒有 7 日平均`
}

export function TrendsScreen(props: {
  today: string
  logs: LogRecord[]
  weights: WeightRecord[]
  config: Record<string, string>
  onWeight: () => void
  loadState: LoadState
  pending: number
  online: boolean
  onRetry: () => void
  retrying?: boolean
  staleToday?: boolean
  weightFail?: { kg: number; onRetry?: () => void; message?: string } | null
  range: WeightRange
  onRange: (r: WeightRange) => void
  weightDays?: number
}) {
  const thisMon = weekStart(props.today)
  const oldest = addDays(thisMon, -21)
  const [mon, setMon] = useState(thisMon)
  const view = useMemo(
    () => trendsView(props.logs, props.weights, props.config, props.today, mon, WEIGHT_RANGE_DAYS[props.range]),
    [props.logs, props.weights, props.config, props.today, mon, props.range],
  )
  const targets = parseTargets(props.config)
  const isThis = mon === thisMon
  const canPrev = addDays(mon, -7) >= oldest
  const canNext = mon < thisMon
  const range = isThis
    ? `本週 ${formatShortDate(mon)}–${formatShortDate(addDays(mon, 6))}`
    : `${formatShortDate(mon)}–${formatShortDate(addDays(mon, 6))}`
  const s = view.summary
  const deficitLabel = s.avgDeficit == null ? '—' : s.avgDeficit < 0 ? `平均超過 ${formatInt(Math.abs(s.avgDeficit))} kcal/天` : formatInt(s.avgDeficit)
  const incDates = view.chartIncompleteDays.map(formatShortDate).join('、')
  const summary = view.chartAvgKcal == null
    ? ''
    : `近 4 週平均 ${formatInt(view.chartAvgKcal)} kcal，${view.overGoalDays} 天超過目標，${view.chartIncompleteN} 天記錄不完整${incDates ? `（${incDates}）` : ''}。`
  const w = view.weight
  const deltaWord = (n: number | null) => {
    if (n == null) return ''
    const r = Math.round(n * 10) / 10
    if (r === 0) return '沒有變化'
    return r < 0 ? `少了 ${formatKg(Math.abs(r))} kg` : `多了 ${formatKg(r)} kg`
  }
  const hasWeight = props.weights.some((x) => !x.deleted)
  const [table, setTable] = useState(false)
  const chartSummary = weightChartSummary(w, props.range)
  const showExpected = w.points.length >= 2 && w.expected.length >= 2
  const showWeightSkeleton = props.range === '3M'
    && (props.loadState === 'cached-syncing' || props.loadState === 'skeleton')
    && (props.weightDays ?? 0) < 90

  return (
    <div className="mx-auto w-full max-w-xl px-4 pb-[calc(var(--tabbar-h)+var(--safe-bottom)+16px)] pt-2">
      <div className="sticky top-0 z-20 flex items-start justify-between bg-background">
        <div>
          <h1 className="text-[34px] font-bold">趨勢</h1>
          <p className="text-muted-foreground">{range}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <SyncBadge loadState={props.loadState} pending={props.pending} online={props.online} onRetry={props.onRetry} retrying={props.retrying} />
          <button type="button" className="h-11 px-2" disabled={!canPrev} onClick={() => setMon(addDays(mon, -7))}>‹ 上週</button>
          {!isThis && <button type="button" className="h-11 px-2" disabled={!canNext} onClick={() => setMon(addDays(mon, 7))}>下週 ›</button>}
        </div>
      </div>

      {(props.loadState === 'skeleton' || props.loadState === 'error-empty') ? (
        <div className="mt-4" aria-busy="true">
          <div className="grid grid-cols-3 gap-2">
            <SkeletonBlock className="h-16 w-full" announce />
            <SkeletonBlock className="h-16 w-full" />
            <SkeletonBlock className="h-16 w-full" />
          </div>
          <div className="mt-6 h-40 rounded-[var(--radius)] bg-muted" />
        </div>
      ) : view.insufficient ? (
        <p className="mt-6 text-muted-foreground">飲食記錄滿 3 天就會出現熱量趨勢（目前 {view.loggedDays} 天）</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <TrendKpi label="平均攝取" value={s.avgKcal == null ? '—' : formatInt(s.avgKcal)} unit={s.avgKcal == null ? undefined : 'kcal/天'} />
            <TrendKpi label="平均赤字" value={s.avgDeficit == null ? '—' : s.avgDeficit < 0 ? formatInt(Math.abs(s.avgDeficit)) : formatInt(s.avgDeficit)} unit={s.avgDeficit == null || s.avgDeficit < 0 ? undefined : 'kcal/天'} over={s.avgDeficit != null && s.avgDeficit < 0} />
            <TrendKpi label="蛋白質達標" value={`${s.proteinHit}/${s.proteinDenom} 天`} protein />
          </div>
          {s.avgDeficit != null && s.avgDeficit < 0 && <p className="mt-1 text-[var(--over)]">{deficitLabel}</p>}
          {s.incompleteDays > 0 && <p className="mt-1 text-muted-foreground">不含記錄不完整的 {s.incompleteDays} 天</p>}
          {s.avgKcal == null && <p className="mt-1 text-muted-foreground">本週還沒有完整記錄的日子</p>}
          {(props.config.tdee ?? '') === '' && <p className="mt-1 text-muted-foreground">先到設定填每日消耗，就能看到赤字</p>}
          <section className="mt-6 rounded-[var(--radius)] border border-border bg-card p-4">
          <h2 className="font-bold">每日熱量・近 4 週</h2>
          <KcalBarChart slots={view.slots} target={targets.kcal} summary={summary} incompleteN={view.chartIncompleteN} maskDay={props.staleToday ? props.today : undefined} />
          <p className="mt-2 flex items-center gap-2 text-muted-foreground" aria-hidden="true">
            <span className="inline-block w-5 border-t-2 border-dashed border-[var(--chart-goal)]" />目標 {formatInt(targets.kcal)} kcal
          </p>
          <button type="button" className="mt-2 h-11" onClick={() => setTable((v) => !v)}>看每日數字</button>
          {table && (
            <table className="mt-2 w-full text-left">
              <thead><tr><th>日期</th><th>熱量</th><th>蛋白質</th><th>完整</th><th>體重</th></tr></thead>
              <tbody>
                {view.slots.map((sl) => (
                  <tr key={sl.day}>
                    <td>{formatShortDate(sl.day)}</td>
                    <td className="tnum">{sl.day === props.today && props.staleToday ? '同步後顯示' : sl.slot === 'future' ? '—' : formatInt(sl.kcal)}</td>
                    <td className="tnum">{sl.slot === 'future' ? '—' : sl.protein}</td>
                    <td>{sl.slot === 'incomplete' ? '不完整' : sl.slot === 'complete' ? '完整' : sl.slot === 'today' ? '今天' : '—'}</td>
                    <td className="tnum">{sl.kg == null ? '—' : formatKg(sl.kg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </section>
        </>
      )}

      {hasWeight && (
        <section className="mt-8 rounded-[var(--radius)] border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">體重（kg）</h2>
            <div className="flex items-center gap-2">
              {props.weightFail && (
                props.weightFail.onRetry
                  ? <button type="button" className="text-destructive" onClick={props.weightFail.onRetry}>{formatKg(props.weightFail.kg)} kg 沒有存到 · 重試</button>
                  : <span className="text-destructive">{formatKg(props.weightFail.kg)} kg 沒有存到{props.weightFail.message ? ` · ${props.weightFail.message}` : ''}</span>
              )}
              <button type="button" className="h-11 px-2" onClick={props.onWeight}>＋ 記體重</button>
            </div>
          </div>
          <div role="radiogroup" aria-label="體重區間" className="mt-3 grid grid-cols-3 gap-2">
            {(['1W', '1M', '3M'] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={props.range === r}
                className={cn(
                  'h-11 rounded-full text-base',
                  props.range === r ? 'bg-secondary font-semibold text-foreground' : 'text-muted-foreground',
                )}
                onClick={() => props.onRange(r)}
              >
                {RANGE_UI[r]}
              </button>
            ))}
          </div>
          <div className="flex min-h-[34px] items-center">
            {w.endAvg == null ? (
              <p className="text-base font-normal text-muted-foreground">還不到 7 天</p>
            ) : (
              <div className="text-[34px] font-bold tnum">{formatKg(w.endAvg)} kg</div>
            )}
          </div>
          <p className="text-muted-foreground">
            {w.deltaKg == null ? '7 日平均' : `7 日平均，${RANGE_THIS[props.range]}${deltaWord(w.deltaKg)}`}
          </p>
          <div key={props.range} className="fl-fade mt-4">
            {showWeightSkeleton ? (
              <>
                <div className="h-40" aria-busy="true">
                  <SkeletonBlock className="h-40 w-full" announce />
                </div>
                <div className="mt-1 h-6" />
              </>
            ) : (
              <WeightChart series={w} today={props.today} spanDays={WEIGHT_RANGE_DAYS[props.range]} summary={chartSummary} />
            )}
          </div>
          {!showWeightSkeleton && (
            <p className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground" aria-hidden="true">
              <span><span className="mr-1 inline-block size-2 rounded-full bg-[var(--chart-weight)]" />每日</span>
              <span><span className="mr-1 inline-block w-4 border-t-[3px] border-[var(--chart-weight-avg)] align-middle" />7 日平均</span>
              {showExpected && <span><span className="mr-1 inline-block w-4 border-t-2 border-dashed border-[var(--chart-expected)] align-middle" />預期</span>}
            </p>
          )}
          {!showWeightSkeleton && showExpected && w.expectedDeltaKg != null && w.deltaKg != null && (
            <p className="text-muted-foreground">依赤字預期{deltaWord(w.expectedDeltaKg)}，實際{deltaWord(w.deltaKg)}</p>
          )}
          <span className="sr-only">
            {chartSummary}
            {` ${RANGE_THIS[props.range]}`}
            {showExpected && w.expectedDeltaKg != null ? `；依赤字預期${deltaWord(w.expectedDeltaKg)}` : ''}。
          </span>
        </section>
      )}
    </div>
  )
}
