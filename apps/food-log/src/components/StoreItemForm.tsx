import { useEffect, useState } from 'react'
import type { MergedItem } from '@/types'
import { parseNonNeg } from '@/lib/nutrition'
import { Sheet, SheetContent, SheetTitle, cn } from '@food-log/ui'

const FIELDS = [
  { key: 'kcal', label: '熱量' },
  { key: 'protein', label: '蛋白質' },
  { key: 'carb', label: '碳水' },
  { key: 'fat', label: '脂肪' },
] as const

export function StoreItemForm(props: {
  open: boolean
  mode: 'store' | 'quick'
  initial?: Partial<MergedItem> & { name?: string }
  online: boolean
  onBack: () => void
  onCloseAll?: () => void
  onRecord: (v: { name: string; kcal: number; protein: number; fat: number; carb: number }) => void
  onSaveOnly?: (v: { name: string; kcal: number; protein: number; fat: number; carb: number }) => void
  onKyujin?: () => void
}) {
  const [name, setName] = useState('')
  const [kcal, setKcal] = useState('')
  const [protein, setProtein] = useState('')
  const [carb, setCarb] = useState('')
  const [fat, setFat] = useState('')
  const [kyujinHelp, setKyujinHelp] = useState(false)

  useEffect(() => {
    if (!props.open) { setKyujinHelp(false); return }
    setName(props.initial?.name ?? '')
    setKcal(props.initial?.kcal != null ? String(props.initial.kcal) : '')
    setProtein(props.initial?.protein != null ? String(props.initial.protein) : '')
    setCarb(props.initial?.carb != null ? String(props.initial.carb) : '')
    setFat(props.initial?.fat != null ? String(props.initial.fat) : '')
  }, [props.open, props.initial])

  const kn = parseNonNeg(kcal), p = parseNonNeg(protein), f = parseNonNeg(fat), c = parseNonNeg(carb)
  const nameOk = props.mode === 'quick' || name.trim() !== ''
  const ok = nameOk && kn != null && p != null && f != null && c != null
  const values = { name: name.trim(), kcal: kn ?? 0, protein: p ?? 0, fat: f ?? 0, carb: c ?? 0 }

  return (
    <Sheet open={props.open} onOpenChange={(v) => { if (!v) props.onBack() }}>
      <SheetContent className="top-[calc(var(--safe-top)+8px)] bottom-0 h-auto">
        {kyujinHelp ? (
          <div className="px-4 pb-4">
            <SheetTitle>請 Kyujin 估算</SheetTitle>
            <p className="mt-3">傳照片或品名給 Kyujin，估好後會出現在這家店</p>
            <button type="button" aria-label="好" className="mt-4 h-12 w-full rounded-[var(--radius)] bg-primary font-bold text-primary-foreground" onClick={() => { setKyujinHelp(false); (props.onCloseAll ?? props.onBack)() }}>好</button>
          </div>
        ) : (
          <div className="px-4 pb-4">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="返回"
                className="inline-flex h-11 shrink-0 items-center whitespace-nowrap px-2"
                onClick={props.onBack}
              >
                ‹ 返回
              </button>
              <SheetTitle className="min-w-0 flex-1 truncate">
                {props.mode === 'quick' ? '快速記錄' : props.initial?.id ? '改營養素' : '新增品項'}
              </SheetTitle>
            </div>
            {props.mode === 'store' && (
              <button
                type="button"
                disabled={!props.online}
                className="mt-3 h-12 w-full rounded-[var(--radius)] bg-secondary font-semibold disabled:text-muted-foreground"
                onClick={() => { props.onKyujin?.(); setKyujinHelp(true) }}
              >
                {props.online ? '請 Kyujin 估算' : '需要網路'}
              </button>
            )}
            <label className="mt-3 block">
              <span>品名{props.mode === 'store' ? '' : '（可空白）'}</span>
              <input
                aria-label="品名"
                enterKeyHint="next"
                className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-base"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {FIELDS.map((fdef) => {
              const [v, set] = { kcal: [kcal, setKcal], protein: [protein, setProtein], carb: [carb, setCarb], fat: [fat, setFat] }[fdef.key] as [string, (s: string) => void]
              return (
                <label key={fdef.key} className="mt-3 block">
                  <span>{fdef.label}</span>
                  <input
                    inputMode="decimal"
                    placeholder="必填，可以填 0"
                    className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3"
                    value={v}
                    onChange={(e) => set(e.target.value)}
                  />
                </label>
              )
            })}
            <button
              type="button"
              aria-label="記錄"
              disabled={!ok}
              className={cn('mt-4 h-14 w-full rounded-[28px] text-lg font-bold', ok ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}
              onClick={() => ok && props.onRecord(values)}
            >
              記錄
            </button>
            {props.mode === 'store' && props.onSaveOnly && (
              <button type="button" aria-label="只存品項" disabled={!ok} className="mt-2 h-11 w-full" onClick={() => ok && props.onSaveOnly?.(values)}>只存品項</button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
