// 記體重 Sheet。開關跟著路由：`#weight` 深連結一打開就是開著的（今天頁在底下）；關掉回 `#today`。
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useAppData } from '@/app/data'
import { useActions } from '@/app/services'
import { WeightSheet } from '@/components/WeightSheet'
import { useToast } from '@/features/toast/ToastProvider'

export function useWeightSheet() {
  const navigate = useNavigate()
  const open = useRouterState({ select: (s) => s.location.pathname === '/weight' })
  return {
    open,
    openWeight: () => void navigate({ to: '/weight' }),
    closeWeight: () => void navigate({ to: '/today', replace: true }),
  }
}

export function WeightFeature() {
  const d = useAppData()
  const actions = useActions()
  const { showToast, guard } = useToast()
  const { open, closeWeight } = useWeightSheet()
  return (
    <WeightSheet
      open={open}
      onOpenChange={(v) => {
        if (!v) closeWeight()
      }}
      today={d.today}
      weights={d.weights}
      onSave={({ day, kg }) => {
        closeWeight()
        void guard(actions.recordWeight({ day, kg, today: d.today })).then((r) => {
          if (!r) return
          showToast(`已記錄 ${kg.toFixed(1)} kg（${day.slice(5, 7).replace(/^0/, '')}/${day.slice(8, 10).replace(/^0/, '')}）`, r.undo)
        })
      }}
    />
  )
}
