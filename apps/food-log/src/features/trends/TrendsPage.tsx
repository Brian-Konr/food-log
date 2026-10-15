import { useState } from 'react'
import { parseWeightRange } from '@food-log/core'
import type { WeightRange } from '@food-log/core'
import { useAppData } from '@/app/data'
import { useActions } from '@/app/services'
import { KEYS, readLocal, writeLocal } from '@/lib/local-storage'
import { TrendsScreen } from '@/screens/TrendsScreen'
import { useWeightSheet } from '@/features/weight/WeightFeature'

export function TrendsPage() {
  const d = useAppData()
  const actions = useActions()
  const { openWeight } = useWeightSheet()
  const [range, setRange] = useState<WeightRange>(() => parseWeightRange(readLocal(KEYS.weightRange)))
  // 失敗的「記體重」：在體重卡上顯示「<kg> kg 沒有存到 · 重試」
  const failedWeight = d.failed.find((f) => f.name === 'weights.upsert@1')
  const failedKg = (failedWeight?.args as { kg?: number } | null | undefined)?.kg
  const weightFail =
    failedWeight && typeof failedKg === 'number'
      ? { kg: failedKg, onRetry: () => void actions.retryFailed(failedWeight.mutationId) }
      : null
  const known = d.loadState !== 'skeleton' && d.loadState !== 'error-empty'
  return (
    <TrendsScreen
      today={d.today}
      logs={d.logs}
      weights={d.weights}
      config={d.config}
      onWeight={openWeight}
      loadState={d.loadState}
      pending={d.pending}
      online={d.network !== 'offline'}
      onRetry={d.retry}
      retrying={d.retrying}
      staleToday={d.staleToday}
      weightFail={weightFail}
      range={range}
      onRange={(r) => {
        setRange(r)
        writeLocal(KEYS.weightRange, r)
      }}
      weightDays={known ? 90 : undefined}
    />
  )
}
