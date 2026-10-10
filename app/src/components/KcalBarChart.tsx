import { useState } from 'react'
import type { DaySlot } from '@/types'
import { formatInt, formatMacro, formatShortDate } from '@/lib/format'

export function KcalBarChart(props: {
  slots: DaySlot[]
  target: number
  summary: string
  incompleteN: number
}) {
  const [sel, setSel] = useState<string | null>(null)
  const max = Math.max(props.target, ...props.slots.map((s) => s.kcal), 1)
  const picked = props.slots.find((s) => s.day === sel)
  return (
    <div>
      {picked && (
        <p className="mb-2">{formatShortDate(picked.day)} {formatInt(picked.kcal)} kcal · 蛋白質 {formatMacro(picked.protein)} g</p>
      )}
      <svg role="img" aria-label={props.summary} viewBox="0 0 280 120" overflow="visible" className="h-40 w-full">
        <title>{props.summary}</title>
        <defs>
          <pattern id="inc" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--chart-incomplete)" strokeWidth="2" />
          </pattern>
        </defs>
        {props.slots.map((s, i) => {
          const x = i * 10
          const h = s.slot === 'future' ? 0 : (s.kcal / max) * 90
          const y = 100 - h
          const fill = s.slot === 'incomplete' ? 'url(#inc)' : 'var(--chart-bar)'
          const opacity = s.slot === 'today' ? 0.5 : 1
          return (
            <g key={s.day}>
              {i % 7 === 0 && i !== 0 && <line x1={x} y1="8" x2={x} y2="100" stroke="var(--border)" strokeWidth="1" />}
              <rect x={x + 1} y={8} width="8" height="92" fill="transparent" onClick={() => setSel(s.day)} />
              {h > 0 && <rect x={x + 2} y={y} width="6" height={h} fill={fill} opacity={opacity} stroke={s.slot === 'incomplete' ? 'var(--chart-incomplete)' : 'none'} />}
              {s.slot === 'incomplete' && <text x={x + 5} y={Math.max(y - 2, 13)} textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--chart-incomplete)">!</text>}
              {s.slot === 'today' && <text x={Math.min(x + 5, 280)} y="118" textAnchor={i >= props.slots.length - 2 ? 'end' : 'middle'} fontSize="14" fill="var(--muted-foreground)">今天</text>}
            </g>
          )
        })}
        <line x1="0" y1={100 - (props.target / max) * 90} x2="280" y2={100 - (props.target / max) * 90} stroke="var(--chart-goal)" strokeDasharray="5 4" />
      </svg>
      <p className="text-base text-muted-foreground">{formatShortDate(props.slots[0]?.day ?? '')} – {formatShortDate(props.slots.at(-1)?.day ?? '')}</p>
      {props.incompleteN > 0 && <p className="text-muted-foreground">! 記錄不完整 {props.incompleteN} 天</p>}
      <p className="mt-1">{props.summary}</p>
    </div>
  )
}
