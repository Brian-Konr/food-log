import { useState } from 'react'
import { cn } from '@/lib/utils'
import { formatInt } from '@/lib/format'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

const TARGETS: { key: 'target_kcal' | 'target_protein' | 'target_carb' | 'target_fat'; label: string; toast: string }[] = [
  { key: 'target_kcal', label: '熱量', toast: '已更新熱量目標' },
  { key: 'target_protein', label: '蛋白質', toast: '已更新蛋白質目標' },
  { key: 'target_carb', label: '碳水', toast: '已更新碳水目標' },
  { key: 'target_fat', label: '脂肪', toast: '已更新脂肪目標' },
]

export function SettingsScreen(props: {
  config: Record<string, string>
  theme: 'dark' | 'light'
  onTheme: (t: 'dark' | 'light') => void
  onSetConfig: (key: string, value: string) => void
  onToast: (msg: string) => void
  onEditConnection?: () => void
}) {
  const [edit, setEdit] = useState<(typeof TARGETS)[number] | null>(null)
  const [val, setVal] = useState('')
  const [tdee, setTdee] = useState(props.config.tdee ?? '')
  const [tdeeErr, setTdeeErr] = useState(false)
  const meals = (props.config.remind_meal_times || '').split(',').map((s) => s.trim())
  const [m1, setM1] = useState(meals[0] || '')
  const [m2, setM2] = useState(meals[1] || '')
  const [wt, setWt] = useState(props.config.remind_weight_time || '')
  const targetKcal = Number(props.config.target_kcal) || 0
  const tdeeN = tdee.trim() === '' ? null : Number(tdee)
  const hint = tdeeN == null ? null : tdeeN - targetKcal > 0
    ? `比熱量目標多 ${formatInt(tdeeN - targetKcal)} kcal，代表每天的預期赤字約 ${formatInt(tdeeN - targetKcal)} kcal。`
    : tdeeN - targetKcal < 0
      ? `熱量目標比每日消耗多 ${formatInt(targetKcal - tdeeN)} kcal，照目標吃體重會上升。`
      : '跟熱量目標一樣，照目標吃體重會維持。'

  function saveTdee() {
    const v = tdee.trim()
    if (v === '') { props.onSetConfig('tdee', ''); props.onToast('已更新每日消耗'); setTdeeErr(false); return }
    if (!/^\d+$/.test(v) || Number(v) < 1200 || Number(v) > 5000) { setTdeeErr(true); return }
    setTdeeErr(false)
    props.onSetConfig('tdee', v)
    props.onToast('已更新每日消耗')
  }

  return (
    <div className="px-4 pb-[calc(var(--tabbar-h)+var(--safe-bottom)+16px)] pt-2">
      <h1 className="text-[34px] font-bold">設定</h1>
      <h2 className="mt-6 text-muted-foreground">每日目標</h2>
      <div className="mt-2 overflow-hidden rounded-2xl bg-card">
        {TARGETS.map((t) => (
          <button key={t.key} type="button" className="flex min-h-[52px] w-full items-center justify-between px-4" onClick={() => { setEdit(t); setVal(props.config[t.key] ?? '') }}>
            <span>{t.label}</span>
            <span className="tnum text-muted-foreground">{props.config[t.key]} ›</span>
          </button>
        ))}
      </div>
      <h2 className="mt-6 text-muted-foreground">每日消耗</h2>
      <div className="mt-2 rounded-2xl bg-card p-4">
        <div className="flex items-center gap-2">
          <input
            inputMode="numeric"
            value={tdee}
            onChange={(e) => setTdee(e.target.value)}
            onBlur={saveTdee}
            className={cn('h-12 flex-1 rounded-xl border px-3', tdeeErr && 'border-destructive')}
          />
          <span>kcal</span>
        </div>
        <p className="mt-2 text-muted-foreground">InBody 的基礎代謝 × 活動量估算，可以自己改。趨勢頁用它算赤字（每日消耗 − 攝取）。</p>
        {tdeeErr && <p className="text-destructive">請輸入 1,200 到 5,000 之間的數字</p>}
        {hint && <p className={cn('mt-2', tdeeN != null && tdeeN - targetKcal < 0 && 'text-[var(--over)]')}>{hint}</p>}
      </div>
      <h2 className="mt-6 text-muted-foreground">提醒（Kyujin 傳訊息）</h2>
      <div className="mt-2 rounded-2xl bg-card p-4">
        <label className="block">午餐<input type="time" className="mt-1 h-12 w-full rounded-xl border px-3" value={m1} onChange={(e) => setM1(e.target.value)} onBlur={() => props.onSetConfig('remind_meal_times', [m1, m2].filter(Boolean).join(','))} /></label>
        <label className="mt-3 block">晚餐<input type="time" className="mt-1 h-12 w-full rounded-xl border px-3" value={m2} onChange={(e) => setM2(e.target.value)} onBlur={() => props.onSetConfig('remind_meal_times', [m1, m2].filter(Boolean).join(','))} /></label>
        <label className="mt-3 block">量體重<input type="time" className="mt-1 h-12 w-full rounded-xl border px-3" value={wt} onChange={(e) => setWt(e.target.value)} onBlur={() => props.onSetConfig('remind_weight_time', wt)} /></label>
        <p className="mt-2 text-muted-foreground">App 不會推播，時間到了由 Kyujin 傳訊息</p>
      </div>
      <h2 className="mt-6 text-muted-foreground">外觀</h2>
      <div className="mt-2 overflow-hidden rounded-2xl bg-card">
        {(['dark', 'light'] as const).map((t) => (
          <button key={t} type="button" className="flex min-h-[52px] w-full items-center justify-between px-4" onClick={() => props.onTheme(t)}>
            <span>{t === 'dark' ? '深色（預設）' : '淺色'}</span>
            {props.theme === t && <span>✓</span>}
          </button>
        ))}
      </div>
      {props.onEditConnection && (
        <>
          <h2 className="mt-6 text-muted-foreground">連線</h2>
          <button type="button" className="mt-2 flex min-h-[52px] w-full items-center justify-between rounded-2xl bg-card px-4" onClick={props.onEditConnection}>
            <span>連線</span><span className="text-muted-foreground">›</span>
          </button>
        </>
      )}
      <Sheet open={!!edit} onOpenChange={(o) => { if (!o) setEdit(null) }}>
        <SheetContent>
          <div className="px-4 pb-4">
            <SheetTitle>{edit?.label}</SheetTitle>
            <input inputMode="decimal" className="mt-4 h-12 w-full rounded-xl border px-3" value={val} onChange={(e) => setVal(e.target.value)} />
            <button
              type="button"
              className="mt-4 h-14 w-full rounded-[28px] bg-primary font-bold text-primary-foreground"
              onClick={() => {
                if (!edit || val.trim() === '') return
                if (edit.key === 'target_kcal' && (!/^\d+$/.test(val) || Number(val) < 0)) return
                if (Number(val) < 0) return
                props.onSetConfig(edit.key, val)
                props.onToast(edit.toast)
                setEdit(null)
              }}
            >
              儲存
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
