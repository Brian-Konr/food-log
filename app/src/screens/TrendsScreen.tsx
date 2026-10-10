import { useMemo, useState } from 'react'
import type { LogRecord, WeightRecord } from '@/types'
import { addDays, weekStart } from '@/lib/day'
import { formatInt, formatKg, formatShortDate } from '@/lib/format'
import { parseTargets } from '@/lib/nutrition'
import { trendsView } from '@/lib/trends'
import { TrendKpi } from '@/components/TrendKpi'
import { KcalBarChart } from '@/components/KcalBarChart'
import { WeightChart } from '@/components/WeightChart'

export function TrendsScreen(props: {
  today: string
  logs: LogRecord[]
  weights: WeightRecord[]
  config: Record<string, string>
  onWeight: () => void
}) {
  const thisMon = weekStart(props.today)
  const oldest = addDays(thisMon, -21)
  const [mon, setMon] = useState(thisMon)
  const view = useMemo(() => trendsView(props.logs, props.weights, props.config, props.today, mon), [props.logs, props.weights, props.config, props.today, mon])
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

  return (
    <div className="px-4 pb-[calc(var(--tabbar-h)+var(--safe-bottom)+16px)] pt-2">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[34px] font-bold">趨勢</h1>
          <p className="text-muted-foreground">{range}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="h-11 px-2" disabled={!canPrev} onClick={() => setMon(addDays(mon, -7))}>‹ 上週</button>
          {!isThis && <button type="button" className="h-11 px-2" disabled={!canNext} onClick={() => setMon(addDays(mon, 7))}>下週 ›</button>}
        </div>
      </div>

      {view.insufficient ? (
        <p className="mt-6 text-muted-foreground">還沒有足夠的紀錄，記滿 3 天就會出現趨勢。</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <TrendKpi label="平均攝取" value={s.avgKcal == null ? '—' : formatInt(s.avgKcal)} unit={s.avgKcal == null ? undefined : 'kcal/天'} />
            <TrendKpi label="平均赤字" value={s.avgDeficit == null ? '—' : s.avgDeficit < 0 ? formatInt(Math.abs(s.avgDeficit)) : formatInt(s.avgDeficit)} unit={s.avgDeficit == null || s.avgDeficit < 0 ? undefined : 'kcal/天'} over={s.avgDeficit != null && s.avgDeficit < 0} />
            <TrendKpi label="蛋白質達標" value={`${s.proteinHit}/${s.proteinDenom} 天`} protein />
          </div>
          {s.avgDeficit != null && s.avgDeficit < 0 && <p className="mt-1 text-[var(--over)]">{deficitLabel}</p>}
          {s.incompleteDays > 0 && <p className="mt-1 text-muted-foreground">不含記錄不完整的 {s.incompleteDays} 天</p>}
          {(props.config.tdee ?? '') === '' && <p className="mt-1 text-muted-foreground">先到設定填每日消耗，就能看到赤字</p>}
          <h2 className="mt-6 font-bold">每日熱量・近 4 週</h2>
          <KcalBarChart slots={view.slots} target={targets.kcal} summary={summary} incompleteN={view.chartIncompleteN} />
          <button type="button" className="mt-2 h-11" onClick={() => setTable((v) => !v)}>看每日數字</button>
          {table && (
            <table className="mt-2 w-full text-left">
              <thead><tr><th>日期</th><th>熱量</th><th>蛋白質</th><th>完整</th><th>體重</th></tr></thead>
              <tbody>
                {view.slots.map((sl) => (
                  <tr key={sl.day}>
                    <td>{formatShortDate(sl.day)}</td>
                    <td className="tnum">{sl.slot === 'future' ? '—' : formatInt(sl.kcal)}</td>
                    <td className="tnum">{sl.slot === 'future' ? '—' : sl.protein}</td>
                    <td>{sl.slot === 'incomplete' ? '不完整' : sl.slot === 'complete' ? '完整' : sl.slot === 'today' ? '今天' : '—'}</td>
                    <td className="tnum">{sl.kg == null ? '—' : formatKg(sl.kg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {hasWeight && (
        <section className="mt-8 rounded-[var(--radius)] border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold">體重</h2>
            <button type="button" className="h-11 px-2" onClick={props.onWeight}>＋ 記體重</button>
          </div>
          <div className="text-[34px] font-bold tnum">{w.endAvg == null ? '—' : formatKg(w.endAvg)} kg</div>
          <p className="text-muted-foreground">kg · 7 日平均，4 週{deltaWord(w.deltaKg)}</p>
          <WeightChart series={w} today={props.today} />
          {w.expectedDeltaKg != null && w.deltaKg != null && (
            <p className="text-muted-foreground">依赤字預期{deltaWord(w.expectedDeltaKg).replace(' kg', '')}，實際{deltaWord(w.deltaKg).replace(' kg', '')}</p>
          )}
          <span className="sr-only">
            體重 7 日平均 {w.endAvg == null ? '—' : formatKg(w.endAvg)} kg，4 週{deltaWord(w.deltaKg)}
            {w.expectedDeltaKg != null ? `；依赤字預期${deltaWord(w.expectedDeltaKg)}` : ''}。
          </span>
        </section>
      )}
    </div>
  )
}
