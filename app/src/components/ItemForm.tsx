import { useEffect, useState } from 'react'
import type { MergedItem, SheetSrc } from '@/types'
import { Sheet, SheetContent, SheetTitle } from './ui/sheet'
import { cn } from '@/lib/utils'

const SRCS: SheetSrc[] = ['7-11', '全家', '其他']

export function ItemForm(props: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: Partial<MergedItem> & { name?: string }
  onSave: (v: { name: string; src: SheetSrc; serving: string; servingG: number | null; kcal: number; protein: number; fat: number; carb: number }) => void
}) {
  const [name, setName] = useState('')
  const [src, setSrc] = useState<SheetSrc>('其他')
  const [serving, setServing] = useState('1 份')
  const [servingG, setServingG] = useState('')
  const [kcal, setKcal] = useState('')
  const [protein, setProtein] = useState('')
  const [fat, setFat] = useState('')
  const [carb, setCarb] = useState('')

  useEffect(() => {
    if (!props.open) return
    setName(props.initial?.name ?? '')
    setSrc(props.initial?.sheetSrc ?? '其他')
    setServing(props.initial?.serving ?? '1 份')
    setServingG(props.initial?.servingG != null ? String(props.initial.servingG) : '')
    setKcal(props.initial?.kcal != null ? String(props.initial.kcal) : '')
    setProtein(props.initial?.protein != null ? String(props.initial.protein) : '')
    setFat(props.initial?.fat != null ? String(props.initial.fat) : '')
    setCarb(props.initial?.carb != null ? String(props.initial.carb) : '')
  }, [props.open, props.initial])

  const kg = servingG.trim() === '' ? null : Number(servingG)
  const kn = Number(kcal), p = Number(protein), f = Number(fat), c = Number(carb)
  const ok = name.trim() && serving.trim() && Number.isInteger(kn) && kn >= 0 && [p, f, c].every((n) => Number.isFinite(n) && n >= 0) && (kg == null || (Number.isFinite(kg) && kg > 0))

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent>
        <div className="px-4 pb-4">
          <SheetTitle>{props.initial?.id ? '編輯品項' : '手動新增品項'}</SheetTitle>
          <label className="mt-3 block">品名<input className="mt-1 h-12 w-full rounded-xl border px-3" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="mt-3 flex gap-2">
            {SRCS.map((s) => (
              <button key={s} type="button" onClick={() => setSrc(s)} className={cn('h-12 flex-1 rounded-full border', src === s && 'bg-primary text-primary-foreground')}>{s}</button>
            ))}
          </div>
          <label className="mt-3 block">一份份量<input className="mt-1 h-12 w-full rounded-xl border px-3" value={serving} onChange={(e) => setServing(e.target.value)} /></label>
          <label className="mt-3 block">一份克數（選填）<input inputMode="decimal" className="mt-1 h-12 w-full rounded-xl border px-3" value={servingG} onChange={(e) => setServingG(e.target.value)} /></label>
          {(['熱量', '蛋白質', '碳水', '脂肪'] as const).map((lab, i) => {
            const [v, set] = [[kcal, setKcal], [protein, setProtein], [carb, setCarb], [fat, setFat]][i] as [string, (s: string) => void]
            return <label key={lab} className="mt-3 block">{lab}<input inputMode="decimal" className="mt-1 h-12 w-full rounded-xl border px-3" value={v} onChange={(e) => set(e.target.value)} /></label>
          })}
          <button
            type="button"
            disabled={!ok}
            className={cn('mt-4 h-14 w-full rounded-[28px] text-lg font-bold', ok ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}
            onClick={() => ok && props.onSave({ name: name.trim(), src, serving: serving.trim(), servingG: kg, kcal: kn, protein: p, fat: f, carb: c })}
          >
            儲存
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
