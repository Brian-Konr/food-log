// 店家流程：選店（建立）、店家 Sheet（品項、改名、刪除）、新增／改店家品項、快速記錄的表單。
import { useAppData } from '@/app/data'
import { useActions } from '@/app/services'
import { useUi } from '@/app/ui'
import { duplicateStoreOf } from '@/data/actions'
import { StoreForm } from '@/components/StoreForm'
import { StoreItemForm } from '@/components/StoreItemForm'
import { StorePicker } from '@/components/StorePicker'
import { StoreSheet } from '@/components/StoreSheet'
import { useLogHandlers } from '@/features/log/useLogHandlers'
import { useToast } from '@/features/toast/ToastProvider'
import { Sheet, SheetContent, SheetTitle } from '@food-log/ui'

export function StoresFeature() {
  const d = useAppData()
  const ui = useUi()
  const actions = useActions()
  const { showToast, guard } = useToast()
  const { saveQuick } = useLogHandlers()
  const { storeUi, dupStore } = ui

  async function createStore(name: string) {
    try {
      const { id } = await actions.createStore(name)
      ui.setDupStore(null)
      ui.setStoreUi({ page: 'store', id })
    } catch (e) {
      const dup = duplicateStoreOf(e)
      if (dup) ui.setDupStore(dup)
      else void guard(Promise.reject(e))
    }
  }

  async function renameStore(id: string, name: string) {
    const cur = d.stores.find((s) => s.id === id)
    if (!cur) return
    try {
      await actions.renameStore(cur, name)
      ui.setDupStore(null)
      ui.setStoreUi({ page: 'store', id })
    } catch (e) {
      const dup = duplicateStoreOf(e)
      if (dup) ui.setDupStore(dup)
      else void guard(Promise.reject(e))
    }
  }

  async function saveStoreItem(v: { name: string; kcal: number; protein: number; fat: number; carb: number }, thenPortion: boolean) {
    if (storeUi?.page !== 'item') return
    const { storeId, itemId } = storeUi
    const old = itemId ? d.itemsById.get(itemId) : undefined
    const saved = await guard(actions.saveStoreItem({ storeId, ...(itemId ? { itemId } : {}), ...v }))
    if (!saved) return
    if (itemId && old && (v.kcal !== old.kcal || v.protein !== old.protein)) {
      showToast(`已更新 ${v.name}，之後記錄會用新的營養素`)
    }
    if (thenPortion) {
      const storeName = d.stores.find((s) => s.id === storeId)?.name ?? ''
      ui.setPortionItem({
        id: saved.id, src: 'custom', name: v.name, cat: '', serving: '1 份', servingG: null, perPack: 1,
        kcal: v.kcal, protein: v.protein, fat: v.fat, carb: v.carb, fav: false, createdBy: 'app',
        override: false, needsFill: false, sheetSrc: '其他', storeId, storeName,
      })
      ui.setStoreUi(null)
    } else {
      ui.setStoreUi({ page: 'store', id: storeId })
    }
  }

  return (
    <>
      <StorePicker
        open={storeUi?.page === 'picker'}
        onOpenChange={(v) => {
          if (!v) ui.setStoreUi(null)
        }}
        stores={d.stores}
        remainLine={d.remainLine}
        onQuick={() => ui.setStoreUi({ page: 'quick' })}
        onOpenStore={ui.openStore}
        onCreate={(name) => void createStore(name)}
        duplicateName={dupStore?.name}
        duplicateId={dupStore?.id}
      />
      <StoreSheet
        open={storeUi?.page === 'store'}
        store={storeUi?.page === 'store' ? d.stores.find((s) => s.id === storeUi.id) ?? null : null}
        items={storeUi?.page === 'store' ? d.items.filter((i) => i.storeId === storeUi.id) : []}
        logs={d.logs}
        remainLine={d.remainLine}
        onOpenItem={(item) => ui.setPortionItem(item)}
        onAddItem={() => {
          if (storeUi?.page === 'store') ui.setStoreUi({ page: 'item', storeId: storeUi.id })
        }}
        onRename={() => {
          if (storeUi?.page === 'store') {
            ui.setDupStore(null)
            ui.setStoreUi({ page: 'rename', id: storeUi.id })
          }
        }}
        onDelete={() => {
          if (storeUi?.page !== 'store') return
          const s = d.stores.find((x) => x.id === storeUi.id)
          if (!s) return
          ui.setStoreUi(null)
          void guard(actions.deleteStore(s.id)).then((r) => {
            if (r) showToast(`已刪除 ${s.name}`, r.undo)
          })
        }}
        onClose={() => ui.setStoreUi(null)}
      />
      <StoreItemForm
        open={storeUi?.page === 'item' || storeUi?.page === 'quick'}
        mode={storeUi?.page === 'quick' ? 'quick' : 'store'}
        initial={storeUi?.page === 'item' && storeUi.itemId ? d.itemsById.get(storeUi.itemId) : undefined}
        online={d.network === 'online'}
        onBack={() => {
          if (storeUi?.page === 'item') ui.setStoreUi({ page: 'store', id: storeUi.storeId })
          else ui.setStoreUi(null)
        }}
        onCloseAll={() => {
          ui.setStoreUi(null)
          ui.setSearchOpen(false)
        }}
        onRecord={(v) => {
          if (storeUi?.page === 'quick') saveQuick(v)
          else void saveStoreItem(v, true)
        }}
        onSaveOnly={storeUi?.page === 'item' ? (v) => void saveStoreItem(v, false) : undefined}
      />
      {storeUi?.page === 'rename' && (
        <Sheet
          open
          onOpenChange={(o) => {
            if (!o) ui.setStoreUi({ page: 'store', id: storeUi.id })
          }}
        >
          <SheetContent className="top-[calc(var(--safe-top)+8px)] bottom-0 h-auto">
            <SheetTitle className="px-4">改名</SheetTitle>
            <StoreForm
              initialName={d.stores.find((s) => s.id === storeUi.id)?.name}
              submitLabel="儲存"
              duplicateName={dupStore?.name}
              onSubmit={(name) => void renameStore(storeUi.id, name)}
              onOpenExisting={dupStore ? () => ui.openStore(dupStore.id) : undefined}
            />
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}
