// 份量 Sheet（記一筆）與編輯紀錄 Sheet。
import { useAppData } from '@/app/data'
import { useActions } from '@/app/services'
import { useUi } from '@/app/ui'
import { EditLogSheet } from '@/components/EditLogSheet'
import { PortionSheet } from '@/components/PortionSheet'
import { useToast } from '@/features/toast/ToastProvider'
import { useLogHandlers } from './useLogHandlers'

export function LogFeature() {
  const d = useAppData()
  const ui = useUi()
  const actions = useActions()
  const { showToast, guard } = useToast()
  const { onRecord } = useLogHandlers()

  const editLog = ui.editLog
  const failedOf = (logId: string) => {
    const id = d.failedByLogId.get(logId)
    return id === undefined ? undefined : d.failed.find((f) => f.mutationId === id)
  }

  return (
    <>
      <PortionSheet
        open={!!ui.portionItem}
        onOpenChange={(o) => {
          if (!o) ui.setPortionItem(null)
        }}
        item={ui.portionItem}
        logs={d.logs}
        remain={d.remain}
        targets={d.targets}
        todayKnown={d.todayKnown}
        onToggleFav={(i) => {
          void guard(actions.setFavorite(i.id, !i.fav))
        }}
        onRecord={onRecord}
        onSaveNutrition={(item, n) => {
          void guard(actions.saveNutrition(item, n)).then((r) => {
            if (r) showToast(`已更新 ${item.name}，之後記錄會用新的營養素`)
          })
        }}
      />
      <EditLogSheet
        open={!!editLog}
        onOpenChange={(o) => {
          if (!o) ui.setEditLog(null)
        }}
        log={editLog}
        item={editLog ? d.itemsById.get(editLog.item_id) ?? null : null}
        today={d.today}
        onSave={(log, patch) => {
          ui.setEditLog(null)
          void guard(actions.updateLog(log, patch)).then((r) => {
            if (r) showToast('已更新紀錄', r.undo)
          })
        }}
        onDelete={(log) => {
          ui.setEditLog(null)
          const failed = log.__write === 'failed' ? failedOf(log.id) : undefined
          if (failed) {
            // 失敗的新增：捨棄失敗列（不打網路）；復原 = 放回失敗清單
            void actions.discardFailed(failed).then((r) => showToast(`已刪除 ${log.name || '快速記錄'}`, r.undo))
            return
          }
          void guard(actions.deleteLog(log.id)).then((r) => {
            if (r) showToast(`已刪除 ${log.name || '快速記錄'}`, r.undo)
          })
        }}
        onRetry={(log) => {
          const f = failedOf(log.id)
          if (f) void guard(actions.retryFailed(f.mutationId))
        }}
        onDiscard={(log) => {
          const f = failedOf(log.id)
          if (f) void actions.discardFailed(f)
          ui.setEditLog(null)
        }}
      />
    </>
  )
}
