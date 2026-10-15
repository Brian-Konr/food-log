// 設定頁的「沒有存到」清單：sync-client 的 failed 表。重試 = 用新的 mutationId 再 mutate 一次；捨棄 = 刪掉這列。
import type { FailedRow } from '@food-log/sync-client'
import { failureLabel } from '@/data/failures'
import type { NameLookup } from '@/data/failures'

export function FailedSection(props: {
  failed: FailedRow[]
  nameOf?: NameLookup
  onRetry: (f: FailedRow) => void
  onDiscard: (f: FailedRow) => void
}) {
  if (props.failed.length === 0) return null
  return (
    <>
      <h2 className="mt-6 text-muted-foreground">沒有存到</h2>
      <div className="mt-2 overflow-hidden rounded-2xl bg-card">
        {props.failed.map((f) => (
          <div key={f.mutationId} className="border-b border-border px-4 py-3 last:border-0">
            <p className="font-semibold">{failureLabel(f, props.nameOf)} 沒有存到</p>
            {f.message && <p className="text-muted-foreground">{f.message}</p>}
            <div className="flex items-center gap-3 text-destructive">
              <button type="button" className="h-11" onClick={() => props.onRetry(f)}>
                重試
              </button>
              <button type="button" className="h-11" onClick={() => props.onDiscard(f)}>
                捨棄
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
