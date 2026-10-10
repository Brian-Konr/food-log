import { formatInt, formatMacro } from '@/lib/format'
import { formatRemain } from '@/lib/nutrition'
import { MacroBar } from './MacroBar'

export function RemainingSummary(props: {
  remain: { kcal: number; protein: number; fat: number; carb: number }
  eaten: { kcal: number; protein: number; fat: number; carb: number }
  targets: { kcal: number; protein: number; fat: number; carb: number }
}) {
  const overKcal = props.remain.kcal < 0
  const overPro = props.remain.protein < 0
  const title = overKcal ? '今天超過' : '今天還剩'
  const kcalText = overKcal ? `超過 ${formatInt(Math.abs(props.remain.kcal))}` : formatInt(props.remain.kcal)
  const proText = overPro ? `超過 ${formatMacro(Math.abs(props.remain.protein))} g` : formatMacro(props.remain.protein)
  const aria = overKcal
    ? `今天超過 ${formatInt(Math.abs(props.remain.kcal))} 大卡，蛋白質 ${overPro ? '超過 ' + formatMacro(Math.abs(props.remain.protein)) : formatMacro(props.remain.protein)} 公克`
    : `今天還剩 ${formatInt(props.remain.kcal)} 大卡，蛋白質 ${formatMacro(props.remain.protein)} 公克`
  return (
    <section className="rounded-[var(--radius)] border border-border bg-card p-5" aria-label={aria}>
      <div className="font-semibold text-muted-foreground">{title}</div>
      <div className="flex items-baseline gap-2">
        <b className="text-hero font-bold tracking-[-1.5px] tnum">{kcalText}</b>
        <span className="text-muted-foreground">kcal</span>
      </div>
      <div className="mb-4 flex items-baseline gap-2">
        <b className={overPro ? 'text-2xl font-bold tnum text-[var(--over)]' : 'text-2xl font-bold tnum text-[var(--macro-protein)]'}>{proText}</b>
        {!overPro && <span className="text-muted-foreground">g 蛋白質</span>}
      </div>
      <MacroBar eaten={props.eaten} targets={props.targets} />
      <span className="sr-only">{formatRemain(props.remain.kcal, 'kcal')} {formatRemain(props.remain.protein, 'g')}</span>
    </section>
  )
}
