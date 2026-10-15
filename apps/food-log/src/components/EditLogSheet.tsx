import { useEffect, useState } from 'react'
import type { LogRecord, MergedItem } from '@/types'
import { canUseGrams, parseNonNeg, rescaleLog } from '@/lib/nutrition'
import { taipeiDay } from '@/lib/day'
import { Sheet, SheetContent, SheetTitle } from './ui/sheet'
import { cn } from '@/lib/utils'

export function EditLogSheet(props: {
  open: boolean
  onOpenChange: (v: boolean) => void
  log: LogRecord | null
  item: MergedItem | null
  today: string
  onSave: (log: LogRecord, patch: Partial<LogRecord>) => void
  onDelete: (log: LogRecord) => void
  onRetry?: (log: LogRecord) => void
  onDiscard?: (log: LogRecord) => void
}) {
  const log = props.log
  const quick = !!log && (log.item_id === '' || log.source === 'quick')
  const [qty, setQty] = useState(1)
  const [grams, setGrams] = useState('')
  const [mode, setMode] = useState<'qty' | 'grams'>('qty')
  const [local, setLocal] = useState('')
  const [name, setName] = useState('')
  const [kcal, setKcal] = useState('')
  const [protein, setProtein] = useState('')
  const [fat, setFat] = useState('')
  const [carb, setCarb] = useState('')

  useEffect(() => {
    if (!log) return
    if (log.grams != null) { setMode('grams'); setGrams(String(log.grams)); setQty(log.qty) }
    else { setMode('qty'); setQty(log.qty); setGrams('') }
    setLocal(log.ts.slice(0, 16))
    setName(log.name)
    setKcal(String(log.kcal))
    setProtein(String(log.protein))
    setFat(String(log.fat))
    setCarb(String(log.carb))
  }, [log])

  if (!log) return null
  const ts = local.length >= 16 ? `${local}:00+08:00` : log.ts
  const day = taipeiDay(new Date(ts))
  const future = day > props.today
  const gramsN = Number(grams)
  const scaled = mode === 'grams' && props.item?.servingG
    ? rescaleLog(log, props.item, qty, gramsN, props.item.servingG)
    : rescaleLog(log, props.item, qty, null, props.item?.servingG ?? null)
  const kn = parseNonNeg(kcal), p = parseNonNeg(protein), f = parseNonNeg(fat), c = parseNonNeg(carb)
  const quickOk = kn != null && p != null && f != null && c != null
  const failed = log.__write === 'failed'

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <div className="px-4 pb-4">
          <SheetTitle>編輯紀錄</SheetTitle>
          {failed && (
            <div className="mb-3">
              <p className="text-destructive">{log.__failMessage || '沒有存到'}</p>
              <button type="button" aria-label="重試" className="mt-2 h-12 w-full rounded-[var(--radius)] bg-primary font-bold text-primary-foreground" onClick={() => props.onRetry?.(log)}>重試</button>
              <button type="button" aria-label="捨棄" className="mt-2 h-12 w-full rounded-[var(--radius)] bg-secondary font-semibold" onClick={() => props.onDiscard?.(log)}>捨棄</button>
            </div>
          )}
          {quick ? (
            <>
              <label className="mt-2 block">品名
                <input className="mt-1 h-12 w-full rounded-xl border px-3" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              {([['熱量', kcal, setKcal], ['蛋白質', protein, setProtein], ['碳水', carb, setCarb], ['脂肪', fat, setFat]] as const).map(([lab, v, set]) => (
                <label key={lab} className="mt-3 block">{lab}
                  <input inputMode="decimal" className="mt-1 h-12 w-full rounded-xl border px-3" value={v} onChange={(e) => set(e.target.value)} />
                </label>
              ))}
            </>
          ) : (
            <>
              <p className="font-semibold">{log.name}</p>
              <div className="mt-3 flex gap-2">
                {[0.5, 1, 1.5, 2].map((q) => (
                  <button key={q} type="button" onClick={() => { setMode('qty'); setQty(q) }} className={cn('h-12 flex-1 rounded-xl border', mode === 'qty' && qty === q && 'bg-primary text-primary-foreground')}>{q === 0.5 ? '½' : q}</button>
                ))}
                <button type="button" disabled={!canUseGrams(props.item ?? { servingG: null })} onClick={() => setMode('grams')} className={cn('h-12 flex-1 rounded-xl border disabled:opacity-50', mode === 'grams' && 'bg-primary text-primary-foreground')}>克數</button>
              </div>
              {mode === 'grams' && <input inputMode="decimal" className="mt-2 h-12 w-full rounded-xl border px-3" value={grams} onChange={(e) => setGrams(e.target.value)} />}
            </>
          )}
          <label className="mt-4 block">時間
            <input type="datetime-local" className="mt-1 h-12 w-full rounded-xl border px-3" value={local} onChange={(e) => setLocal(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={future || (quick ? !quickOk : (mode === 'grams' && !(gramsN > 0)))}
            className="mt-4 h-14 w-full rounded-[28px] bg-primary text-lg font-bold text-primary-foreground disabled:bg-secondary disabled:text-muted-foreground"
            onClick={() => {
              if (quick && quickOk) {
                props.onSave(log, { name: name.trim(), kcal: kn, protein: p, fat: f, carb: c, ts, day, qty: 1, grams: null })
              } else {
                props.onSave(log, { qty: scaled.qty, grams: scaled.grams, ...scaled.macros, ts, day })
              }
            }}
          >
            儲存
          </button>
          <button type="button" className="mt-2 h-12 w-full text-destructive" onClick={() => props.onDelete(log)}>刪除</button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
