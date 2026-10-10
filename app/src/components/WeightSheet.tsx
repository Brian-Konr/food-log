import { useEffect, useMemo, useRef, useState } from 'react'
import type { WeightRecord } from '@/types'
import { formatKg, formatShortDate } from '@/lib/format'
import { Sheet, SheetContent, SheetTitle } from './ui/sheet'
import { cn } from '@/lib/utils'

function round1(n: number) { return Math.round(n * 10) / 10 }

export function WeightSheet(props: {
  open: boolean
  onOpenChange: (v: boolean) => void
  today: string
  weights: WeightRecord[]
  onSave: (args: { day: string; kg: number; overwrite: boolean; prevKg: number | null }) => void
}) {
  const live = useMemo(() => {
    const m = new Map<string, WeightRecord>()
    for (const w of props.weights) {
      if (w.deleted) continue
      const prev = m.get(w.day)
      if (!prev || w.updated_at > prev.updated_at) m.set(w.day, w)
    }
    return m
  }, [props.weights])
  const latest = useMemo(() => [...live.values()].sort((a, b) => b.day.localeCompare(a.day))[0] ?? null, [live])
  const [day, setDay] = useState(props.today)
  const [kg, setKg] = useState<number | null>(null)
  const [, setEditing] = useState(false)
  const [showDate, setShowDate] = useState(false)
  const [raw, setRaw] = useState('')
  const hold = useRef<number | null>(null)

  useEffect(() => {
    if (!props.open) return
    setDay(props.today)
    setShowDate(false)
    setEditing(false)
  }, [props.open, props.today])

  useEffect(() => {
    const existing = live.get(day)
    if (existing) { setKg(existing.kg); setRaw(formatKg(existing.kg)) }
    else if (latest) { setKg(latest.kg); setRaw(formatKg(latest.kg)) }
    else { setKg(null); setRaw('') }
    // 只在打開或換日期時帶入；資料重讀不能蓋掉正在調的數字
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, props.open])

  const existing = live.get(day)
  const valid = kg != null && kg >= 30 && kg <= 250 && round1(kg) === kg
  const hint = existing
    ? `這天已經記了 ${formatKg(existing.kg)} kg，記錄會取代它`
    : latest
      ? `上次 ${formatKg(latest.kg)} kg（${formatShortDate(latest.day)}）· 每按一下 0.1 kg`
      : '點數字輸入'
  const btn = existing ? '更新' : '記錄'

  function bump(delta: number) {
    setKg((k) => {
      const base = k ?? 70
      const n = round1(base + delta)
      setRaw(formatKg(n))
      return n
    })
    setEditing(false)
  }
  function startHold(delta: number) {
    bump(delta)
    const t = window.setTimeout(() => {
      hold.current = window.setInterval(() => bump(delta), 100)
    }, 500)
    const stop = () => {
      clearTimeout(t)
      if (hold.current) clearInterval(hold.current)
      hold.current = null
    }
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="px-4 pb-4">
          <SheetTitle>記體重</SheetTitle>
          {day !== props.today && <p className="text-muted-foreground">補記 {formatShortDate(day)}</p>}
          <div className="mt-3 flex min-h-11 items-center justify-between">
            <span>日期</span>
            <button type="button" className="min-h-11" onClick={() => setShowDate(true)}>{day === props.today ? '今天 ' : ''}{formatShortDate(day)} ›</button>
          </div>
          {showDate && (
            <input type="date" max={props.today} value={day} onChange={(e) => { const v = e.target.value; if (v && v <= props.today) setDay(v) }} className="mt-2 h-12 w-full rounded-xl border border-input px-3" />
          )}
          <div className="mt-6 flex items-center justify-center gap-4">
            <button type="button" className="size-16 rounded-full bg-secondary text-2xl" onPointerDown={() => startHold(-0.1)}>−</button>
            <input
                inputMode="decimal"
                aria-label="體重（kg）"
                placeholder="—"
                onFocus={() => setEditing(true)}
                onBlur={() => setEditing(false)}
                className="w-36 bg-transparent text-center text-[56px] font-bold tnum outline-none placeholder:text-foreground"
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value)
                  const n = Number(e.target.value)
                  setKg(Number.isFinite(n) ? n : null)
                }}
              />
            <button type="button" className="size-16 rounded-full bg-secondary text-2xl" onPointerDown={() => startHold(0.1)}>＋</button>
          </div>
          {!valid && kg != null && <p className="mt-2 text-center text-destructive">請輸入 30 到 250 之間的數字</p>}
          <p className="mt-3 text-center text-muted-foreground">{hint}</p>
          <button
            type="button"
            disabled={!valid}
            className={cn('mt-4 h-14 w-full rounded-[28px] text-lg font-bold', valid ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}
            onClick={() => valid && kg != null && day <= props.today && props.onSave({ day, kg, overwrite: !!existing, prevKg: existing?.kg ?? null })}
          >
            {btn}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
