import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogRecord, MergedItem } from '@/types'
import { canUseGrams, formatRemain, fromGrams, fromQty, itemMacros, lastPortion, parseNonNeg, remaining } from '@/lib/nutrition'
import { formatMacro } from '@/lib/format'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './ui/sheet'
import { cn } from '@/lib/utils'

const QTYS = [0.5, 1, 1.5, 2] as const
const QTY_LABEL: Record<number, string> = { 0.5: '½', 1: '1', 1.5: '1.5', 2: '2' }

export function PortionSheet(props: {
  open: boolean
  onOpenChange: (v: boolean) => void
  item: MergedItem | null
  logs: LogRecord[]
  remain: { kcal: number; protein: number; fat: number; carb: number }
  targets: { kcal: number; protein: number; fat: number; carb: number }
  todayKnown?: boolean
  onToggleFav: (item: MergedItem) => void
  onRecord: (args: {
    item: MergedItem
    qty: number
    grams: number | null
    fill?: { protein: number; fat: number; carb: number }
    nutrition?: { kcal: number; protein: number; fat: number; carb: number }
  }) => void
  onSaveNutrition?: (item: MergedItem, n: { kcal: number; protein: number; fat: number; carb: number }) => void
}) {
  const item = props.item
  const needs = !!item?.needsFill
  const [step, setStep] = useState<'fill' | 'portion'>(needs ? 'fill' : 'portion')
  const [protein, setProtein] = useState('')
  const [fat, setFat] = useState('')
  const [carb, setCarb] = useState('')
  const [mode, setMode] = useState<'qty' | 'grams'>('qty')
  const [qty, setQty] = useState(1)
  const [grams, setGrams] = useState('')
  const [editNut, setEditNut] = useState(false)
  const [nKcal, setNKcal] = useState('')
  const [nPro, setNPro] = useState('')
  const [nFat, setNFat] = useState('')
  const [nCarb, setNCarb] = useState('')
  const recordRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!props.open || !item) return
    setStep(item.needsFill ? 'fill' : 'portion')
    setProtein(''); setFat(''); setCarb('')
    const last = lastPortion(props.logs, item.id)
    if (last.mode === 'grams' && last.grams != null) {
      setMode('grams'); setGrams(String(last.grams)); setQty(last.qty)
    } else {
      setMode('qty'); setQty(last.qty); setGrams('')
    }
    setEditNut(false)
    setNKcal(item.kcal != null ? String(item.kcal) : '')
    setNPro(item.protein != null ? String(item.protein) : '')
    setNFat(item.fat != null ? String(item.fat) : '')
    setNCarb(item.carb != null ? String(item.carb) : '')
    // 只在打開或換品項時重設；logs 變動不能把使用者正在選的份量或打的數字清掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, item?.id])

  useEffect(() => {
    if (!props.open) return
    const id = window.setTimeout(() => {
      if (step === 'portion') recordRef.current?.focus()
      else boxRef.current?.focus()
    }, 0)
    return () => clearTimeout(id)
  }, [props.open, step])

  const p = parseNonNeg(protein)
  const f = parseNonNeg(fat)
  const c = parseNonNeg(carb)
  const nk = parseNonNeg(nKcal)
  const np = parseNonNeg(nPro)
  const nf = parseNonNeg(nFat)
  const nc = parseNonNeg(nCarb)
  const nutOk = nk != null && np != null && nf != null && nc != null
  const missing = [p, f, c].filter((x) => x == null).length
  const filledItem = useMemo(() => {
    if (!item) return null
    if (editNut && nutOk) {
      return { ...item, kcal: nk, protein: np, fat: nf, carb: nc, needsFill: false }
    }
    if (item.needsFill && p != null && f != null && c != null) {
      return { ...item, protein: p, fat: f, carb: c, needsFill: false }
    }
    return item
  }, [item, p, f, c, editNut, nutOk, nk, np, nf, nc])

  const macrosPer = filledItem ? itemMacros(filledItem) : null
  const gramsN = Number(grams)
  const factorOk = mode === 'grams' ? Number.isFinite(gramsN) && gramsN > 0 && canUseGrams(item ?? { servingG: null }) : qty > 0
  const scaled = macrosPer && factorOk
    ? (mode === 'grams' && item && item.servingG ? fromGrams(macrosPer, gramsN, item.servingG).macros : fromQty(macrosPer, qty))
    : null
  const storedQty = mode === 'grams' && item?.servingG ? gramsN / item.servingG : qty
  const previewRemain = scaled
    ? remaining(props.targets, {
        kcal: (props.targets.kcal - props.remain.kcal) + scaled.kcal,
        protein: (props.targets.protein - props.remain.protein) + scaled.protein,
        fat: (props.targets.fat - props.remain.fat) + scaled.fat,
        carb: (props.targets.carb - props.remain.carb) + scaled.carb,
      })
    : props.remain

  if (!item) return null
  const remainLine = `${formatRemain(props.remain.kcal, 'kcal')} · ${formatRemain(props.remain.protein, 'g')} 蛋白質`

  function submit() {
    if (!item || !scaled) return
    props.onRecord({
      item: filledItem ?? item,
      qty: storedQty,
      grams: mode === 'grams' ? gramsN : null,
      fill: item.needsFill && p != null && f != null && c != null ? { protein: p, fat: f, carb: c } : undefined,
      nutrition: editNut && nutOk ? { kcal: nk, protein: np, fat: nf, carb: nc } : undefined,
    })
  }
  const todayKnown = props.todayKnown !== false

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <div ref={boxRef} tabIndex={-1} className="outline-none">
          <SheetDescription className="px-4 text-center text-muted-foreground">{remainLine}</SheetDescription>
          {step === 'fill' ? (
            <div className="px-4 pb-4">
              <div className="text-muted-foreground">步驟 1 / 2</div>
              <SheetTitle>先補上營養素</SheetTitle>
              <p className="mt-1 text-muted-foreground">這個品項只有熱量，補上一次之後就不用再填。</p>
              <div className="mt-3 rounded-xl bg-secondary p-3">
                <div className="font-semibold">{item.name}</div>
                <div className="text-muted-foreground">{item.sheetSrc} · {item.serving} · {item.kcal} kcal</div>
              </div>
              <label className="mt-3 block">
                <span>蛋白質（g，每份）</span>
                <input inputMode="decimal" className="mt-1 h-12 w-full rounded-xl border border-input bg-card px-3" placeholder="必填，可以填 0" value={protein} onChange={(e) => setProtein(e.target.value)} />
              </label>
              <label className="mt-3 block">
                <span>碳水（g，每份）</span>
                <input inputMode="decimal" className="mt-1 h-12 w-full rounded-xl border border-input bg-card px-3" placeholder="必填，可以填 0" value={carb} onChange={(e) => setCarb(e.target.value)} />
              </label>
              <label className="mt-3 block">
                <span>脂肪（g，每份）</span>
                <input inputMode="decimal" className="mt-1 h-12 w-full rounded-xl border border-input bg-card px-3" placeholder="必填，可以填 0" value={fat} onChange={(e) => setFat(e.target.value)} />
              </label>
              {missing > 0 && <p className="mt-2 text-muted-foreground">還差 {missing} 項才能下一步</p>}
              <button
                type="button"
                disabled={missing > 0}
                onClick={() => setStep('portion')}
                className={cn('mt-4 h-14 w-full rounded-[28px] text-lg font-bold', missing > 0 ? 'bg-secondary text-muted-foreground' : 'bg-primary text-primary-foreground')}
              >
                下一步
              </button>
              <button type="button" className="mt-2 h-11 w-full" onClick={() => props.onOpenChange(false)}>取消</button>
            </div>
          ) : (
            <div className="px-4 pb-4">
              <SheetTitle>{item.name}</SheetTitle>
              <div className="text-muted-foreground">
                {item.sheetSrc} · {item.serving} ·
                <button type="button" className="ml-1 min-h-11 px-1" onClick={() => props.onToggleFav(item)}>
                  {item.fav ? '★ 收藏' : '☆ 收藏'}
                </button>
              </div>
              {scaled && (
                <div className="my-3.5 grid grid-cols-4 gap-2">
                  {[
                    ['熱量', scaled.kcal, ''],
                    ['蛋白質', formatMacro(scaled.protein), 'var(--macro-protein)'],
                    ['碳水', formatMacro(scaled.carb), ''],
                    ['脂肪', formatMacro(scaled.fat), ''],
                  ].map(([lab, n, col]) => (
                    <div key={String(lab)} className="rounded-xl bg-secondary px-2.5 py-2">
                      <b className="block text-lg font-bold tnum" style={col ? { color: String(col) } : undefined}>{n}</b>
                      <span className="text-muted-foreground">{lab}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="font-semibold">份量</div>
              <div className="mt-2 flex gap-2">
                {QTYS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    aria-pressed={mode === 'qty' && qty === q}
                    onClick={() => { setMode('qty'); setQty(q) }}
                    className={cn('h-12 flex-1 rounded-xl border border-border font-semibold', mode === 'qty' && qty === q && 'border-primary bg-primary text-primary-foreground')}
                  >
                    {QTY_LABEL[q]}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={!canUseGrams(item)}
                  aria-disabled={!canUseGrams(item)}
                  onClick={() => canUseGrams(item) && setMode('grams')}
                  className={cn('h-12 flex-1 rounded-xl border border-border font-semibold disabled:opacity-50', mode === 'grams' && 'border-primary bg-primary text-primary-foreground')}
                >
                  克數
                </button>
              </div>
              {!canUseGrams(item) && <p className="mt-1 text-muted-foreground">這個品項沒有每份克數</p>}
              {mode === 'grams' && (
                <input inputMode="decimal" className="mt-2 h-12 w-full rounded-xl border border-input px-3" value={grams} onChange={(e) => setGrams(e.target.value)} placeholder="克數" />
              )}
              {item.storeId && (
                <button type="button" className="mt-2 h-11" onClick={() => setEditNut((v) => !v)}>改營養素</button>
              )}
              {editNut && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {([['熱量', nKcal, setNKcal], ['蛋白質', nPro, setNPro], ['碳水', nCarb, setNCarb], ['脂肪', nFat, setNFat]] as const).map(([lab, v, set]) => (
                    <label key={lab} className="block">
                      <span>{lab}</span>
                      <input inputMode="decimal" className="mt-1 h-11 w-full rounded-xl border border-input px-3" value={v} onChange={(e) => set(e.target.value)} />
                    </label>
                  ))}
                  <button
                    type="button"
                    disabled={!nutOk}
                    className="col-span-2 h-11 rounded-xl bg-secondary font-semibold"
                    onClick={() => nutOk && filledItem && props.onSaveNutrition?.(filledItem, { kcal: nk, protein: np, fat: nf, carb: nc })}
                  >
                    儲存營養素
                  </button>
                </div>
              )}
              <p className={cn('mt-3', todayKnown && previewRemain.kcal < 0 && 'text-[var(--over)]')}>
                {!todayKnown
                  ? '同步後顯示剩餘'
                  : previewRemain.kcal < 0 ? `記錄後${formatRemain(previewRemain.kcal, 'kcal')}` : `記錄後還剩 ${formatRemain(previewRemain.kcal, 'kcal')} · ${formatRemain(previewRemain.protein, 'g')} 蛋白質`}
              </p>
              <button
                ref={recordRef}
                type="button"
                aria-label="記錄"
                disabled={!scaled}
                onClick={submit}
                className="mt-3 h-14 w-full rounded-[28px] bg-primary text-lg font-bold text-primary-foreground disabled:bg-secondary disabled:text-muted-foreground"
              >
                記錄
              </button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
