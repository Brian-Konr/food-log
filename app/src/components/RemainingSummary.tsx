import { useEffect, useRef, useState } from 'react'
import { formatInt, formatMacro } from '@/lib/format'
import { formatRemain } from '@/lib/nutrition'
import { MacroBar } from './MacroBar'
import { SkeletonBlock } from './SkeletonBlock'

export function RemainingSummary(props: {
  remain: { kcal: number; protein: number; fat: number; carb: number }
  eaten: { kcal: number; protein: number; fat: number; carb: number }
  targets: { kcal: number; protein: number; fat: number; carb: number }
  skeleton?: boolean
  muted?: boolean
  cached?: boolean
  failedCount?: number
}) {
  if (props.skeleton) {
    return (
      <section data-remain-card className="rounded-[var(--radius)] border border-border bg-card p-5" aria-busy="true">
        <div className="font-semibold text-muted-foreground">今天還剩</div>
        <div className="flex h-14 items-end gap-2">
          <SkeletonBlock className="block h-14 w-[150px] shrink-0" announce />
          <span className="text-muted-foreground">kcal</span>
        </div>
        <div className="mb-4 flex h-9 items-end gap-2">
          <SkeletonBlock className="block h-9 w-24 shrink-0" />
          <span className="text-muted-foreground">g 蛋白質</span>
        </div>
        <MacroBar eaten={{ kcal: 0, protein: 0, fat: 0, carb: 0 }} targets={props.targets} skeleton />
      </section>
    )
  }
  const overKcal = props.remain.kcal < 0
  const overPro = props.remain.protein < 0
  const title = overKcal ? '今天超過' : '今天還剩'
  const kcalText = overKcal ? `超過 ${formatInt(Math.abs(props.remain.kcal))}` : formatInt(props.remain.kcal)
  const proText = overPro ? `超過 ${formatMacro(Math.abs(props.remain.protein))} g` : formatMacro(props.remain.protein)
  const ariaCore = overKcal
    ? `今天超過 ${formatInt(Math.abs(props.remain.kcal))} 大卡，蛋白質 ${overPro ? '超過 ' + formatMacro(Math.abs(props.remain.protein)) : formatMacro(props.remain.protein)} 公克`
    : `今天還剩 ${formatInt(props.remain.kcal)} 大卡，蛋白質 ${formatMacro(props.remain.protein)} 公克`
  const aria = props.cached ? `上次的資料，同步中，${ariaCore}` : ariaCore
  return (
    <section data-remain-card className="rounded-[var(--radius)] border border-border bg-card p-5" aria-label={aria}>
      <div className="font-semibold text-muted-foreground">{title}</div>
      <div className="flex h-14 items-end gap-2">
        <HeroNumber
          className={`font-display text-hero font-bold leading-[3.5rem] tracking-[-1.5px] tnum${props.muted ? ' text-muted-foreground' : ''}`}
          value={kcalText}
        />
        <span className="text-muted-foreground">kcal</span>
      </div>
      <div className="mb-4 flex h-9 items-end gap-2">
        <b className={`text-2xl font-bold leading-9 tnum ${overPro ? 'text-[var(--over)]' : props.muted ? 'text-muted-foreground' : 'text-[var(--macro-protein)]'}`}>{proText}</b>
        {!overPro && <span className="text-muted-foreground">g 蛋白質</span>}
      </div>
      <MacroBar eaten={props.eaten} targets={props.targets} />
      {!!props.failedCount && <p className="mt-2 text-muted-foreground">有 {props.failedCount} 筆沒有存到</p>}
      <span className="sr-only">{formatRemain(props.remain.kcal, 'kcal')} {formatRemain(props.remain.protein, 'g')}</span>
    </section>
  )
}

function HeroNumber(props: { value: string; className?: string }) {
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const [shown, setShown] = useState(props.value)
  const fromRef = useRef(props.value)
  useEffect(() => {
    if (reduce || props.value === fromRef.current) { setShown(props.value); fromRef.current = props.value; return }
    const from = Number(String(fromRef.current).replace(/[^\d.-]/g, ''))
    const to = Number(String(props.value).replace(/[^\d.-]/g, ''))
    if (!Number.isFinite(from) || !Number.isFinite(to) || String(props.value).includes('超過') || String(fromRef.current).includes('超過')) {
      setShown(props.value); fromRef.current = props.value; return
    }
    const t0 = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 300)
      const n = Math.round(from + (to - from) * p)
      setShown(formatInt(n))
      if (p < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = props.value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [props.value, reduce])
  return <b className={`${props.className ?? ''} transition-colors duration-200`}>{shown}</b>
}
