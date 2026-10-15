// 「記一筆」和「快速記錄」：關掉 Sheet、送出動作、跳 toast（附復原）。畫面先關，不等寫入。
import { useAppData } from '@/app/data'
import type { Macros4 } from '@/app/data'
import { useActions } from '@/app/services'
import { useUi } from '@/app/ui'
import type { RecordLogInput } from '@/data/actions'
import { formatLoggedToast } from '@/lib/format'
import { useToast } from '@/features/toast/ToastProvider'

export function useLogHandlers() {
  const actions = useActions()
  const ui = useUi()
  const { showToast, guard } = useToast()
  const d = useAppData()

  function onRecord(args: RecordLogInput) {
    ui.setPortionItem(null)
    ui.setSearchOpen(false)
    ui.setStoreUi(null)
    void guard(actions.recordLog(args)).then((r) => {
      if (r) showToast(formatLoggedToast(args.item.name, r.qty, r.grams), r.undo)
    })
  }

  function saveQuick(v: { name: string } & Macros4) {
    ui.setStoreUi(null)
    ui.setSearchOpen(false)
    void guard(actions.quickLog(v)).then((r) => {
      if (r) showToast(formatLoggedToast(v.name.trim() || '快速記錄', 1, null), r.undo)
    })
  }

  return { onRecord, saveQuick, failed: d.failed }
}
