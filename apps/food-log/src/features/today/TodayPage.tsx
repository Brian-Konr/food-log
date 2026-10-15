import { useAppData, useNowTick } from '@/app/data'
import { useUi } from '@/app/ui'
import { TodayScreen } from '@/screens/TodayScreen'
import { useToast } from '@/features/toast/ToastProvider'
import { useWeightSheet } from '@/features/weight/WeightFeature'

export function TodayPage() {
  const d = useAppData()
  const nowTick = useNowTick()
  const ui = useUi()
  const { toast } = useToast()
  const { openWeight } = useWeightSheet()
  // 失敗的新增排在今天的清單裡（標「沒有存到 · 重試」），不算進剩餘
  const listed = [...d.todayLogs, ...d.failedTodayLogs]
  return (
    <TodayScreen
      today={d.today}
      remain={d.remain}
      eaten={d.eaten}
      targets={d.targets}
      logs={listed}
      itemsById={d.itemsById}
      stores={d.stores}
      onWeight={openWeight}
      onOpenLog={ui.setEditLog}
      loadState={d.loadState}
      staleToday={d.staleToday}
      errorReason={d.errorReason}
      errorCodeLine={d.errorCodeLine}
      retrying={d.retrying}
      onRetry={d.retry}
      pending={d.pending}
      online={d.network !== 'offline'}
      now={nowTick}
      failedLogCount={d.failedTodayLogs.length}
      hasToast={!!toast}
    />
  )
}
