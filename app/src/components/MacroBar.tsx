import { formatInt, formatMacro } from '@/lib/format'
import { remaining } from '@/lib/nutrition'
import { cn } from '@/lib/utils'
import { SkeletonBlock } from './SkeletonBlock'

export type MacroKey = 'kcal' | 'protein' | 'carb' | 'fat'

const META: { key: MacroKey; label: string; unit: 'kcal' | 'g'; color: string }[] = [
  { key: 'kcal', label: '熱量', unit: 'kcal', color: 'var(--macro-kcal)' },
  { key: 'protein', label: '蛋白質', unit: 'g', color: 'var(--macro-protein)' },
  { key: 'carb', label: '碳水', unit: 'g', color: 'var(--macro-carb)' },
  { key: 'fat', label: '脂肪', unit: 'g', color: 'var(--macro-fat)' },
]

export function MacroBar(props: {
  eaten: { kcal: number; protein: number; fat: number; carb: number }
  targets: { kcal: number; protein: number; fat: number; carb: number }
  skeleton?: boolean
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {META.map((m) => {
        const eaten = props.eaten[m.key]
        const target = props.targets[m.key]
        const rem = remaining(props.targets, props.eaten)[m.key]
        const over = rem < 0
        const ratio = target <= 0 ? 0 : Math.min(1, eaten / target)
        const right = over
          ? `超過 ${m.unit === 'kcal' ? formatInt(Math.abs(rem)) : formatMacro(Math.abs(rem))} ${m.unit}`
          : target <= 0
            ? `${m.unit === 'kcal' ? formatInt(eaten) : formatMacro(eaten)} ${m.unit}`
            : `${m.unit === 'kcal' ? formatInt(eaten) : formatMacro(eaten)} / ${m.unit === 'kcal' ? formatInt(target) : formatMacro(target)} ${m.unit}`
        const valuetext = over
          ? `${m.label} ${m.unit === 'kcal' ? formatInt(eaten) : formatMacro(eaten)} / ${m.unit === 'kcal' ? formatInt(target) : formatMacro(target)} ${m.unit === 'kcal' ? '大卡' : '公克'}，超過 ${m.unit === 'kcal' ? formatInt(Math.abs(rem)) : formatMacro(Math.abs(rem))} ${m.unit === 'kcal' ? '大卡' : '公克'}`
          : `${m.label} ${m.unit === 'kcal' ? formatInt(eaten) : formatMacro(eaten)} / ${m.unit === 'kcal' ? formatInt(target) : formatMacro(target)} ${m.unit === 'kcal' ? '大卡' : '公克'}`
        return (
          <div key={m.key} className="bar">
            <div className="flex justify-between font-medium">
              <span>{m.label}</span>
              {props.skeleton ? <SkeletonBlock className="h-4 w-24" /> : (
                <span className={cn('tnum', over ? 'font-semibold text-[var(--over)]' : 'text-muted-foreground')}>{right}</span>
              )}
            </div>
            <div
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--track)]"
              role="progressbar"
              aria-valuenow={props.skeleton ? 0 : eaten}
              aria-valuemax={target || 0}
              aria-valuetext={props.skeleton ? '載入中' : valuetext}
            >
              <div
                className="h-full origin-left rounded-full transition-transform duration-[var(--dur-bar)]"
                style={{ transform: `scaleX(${props.skeleton ? 0 : ratio})`, background: over ? 'var(--over)' : m.color }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
