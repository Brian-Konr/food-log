// 手動新增／編輯自建品項（沒有店家）。從品項頁或搜尋的「手動新增」開。
import { useActions } from '@/app/services'
import { useUi } from '@/app/ui'
import { ItemForm } from '@/components/ItemForm'
import { useToast } from '@/features/toast/ToastProvider'

export function ItemFormFeature() {
  const ui = useUi()
  const actions = useActions()
  const { guard } = useToast()
  return (
    <ItemForm
      open={ui.itemFormOpen}
      onOpenChange={ui.setItemFormOpen}
      initial={ui.itemForm ?? undefined}
      onSave={(v) => {
        const form = ui.itemForm
        void guard(
          actions.saveItem({
            ...(form?.id ? { id: form.id } : {}),
            name: v.name,
            src: v.src,
            serving: v.serving,
            servingG: v.servingG,
            kcal: v.kcal,
            protein: v.protein,
            fat: v.fat,
            carb: v.carb,
            ...(form?.storeId ? { storeId: form.storeId } : {}),
          }),
        )
        ui.setItemFormOpen(false)
      }}
    />
  )
}
