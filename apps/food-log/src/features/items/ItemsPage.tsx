import { useAppData } from '@/app/data'
import { useActions } from '@/app/services'
import { useUi } from '@/app/ui'
import { ItemsScreen } from '@/screens/ItemsScreen'
import { useToast } from '@/features/toast/ToastProvider'

export function ItemsPage() {
  const d = useAppData()
  const actions = useActions()
  const ui = useUi()
  const { showToast, guard } = useToast()
  return (
    <ItemsScreen
      items={d.items}
      stores={d.stores}
      onUnfav={(i) => {
        void guard(actions.setFavorite(i.id, false)).then((r) => r && showToast(`已取消收藏 ${i.name}`, r.undo))
      }}
      onOpenPortion={(i) => ui.setPortionItem(i)}
      onEdit={(i) => ui.openItemForm(i)}
      onDelete={(i) => {
        void guard(actions.deleteItem(i.id)).then((r) => r && showToast(`已刪除 ${i.name}`, r.undo))
      }}
      onCreate={() => ui.openItemForm({})}
      onOpenStore={ui.openStore}
      loadState={d.loadState}
      pending={d.pending}
      online={d.network !== 'offline'}
      onRetry={d.retry}
      retrying={d.retrying}
    />
  )
}
