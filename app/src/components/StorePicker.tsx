import { Store } from 'lucide-react'
import type { StoreRecord } from '@/types'
import { Sheet, SheetContent, SheetTitle } from './ui/sheet'
import { StoreForm } from './StoreForm'

export function StorePicker(props: {
  open: boolean
  onOpenChange: (v: boolean) => void
  stores: StoreRecord[]
  remainLine: string
  onQuick: () => void
  onOpenStore: (id: string) => void
  onCreate: (name: string) => void
  duplicateName?: string
  duplicateId?: string
}) {
  const live = props.stores.filter((s) => !s.deleted).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="top-[calc(var(--safe-top)+8px)] bottom-0 h-auto">
        <p className="px-4 text-center text-muted-foreground">{props.remainLine}</p>
        <SheetTitle className="px-4">新增店家</SheetTitle>
        <button
          type="button"
          aria-label="不指定店家"
          className="flex min-h-[60px] w-full items-center px-4 text-left font-semibold text-primary"
          onClick={props.onQuick}
        >
          不指定店家
        </button>
        {live.map((s) => (
          <button
            key={s.id}
            type="button"
            className="flex min-h-[60px] w-full items-center gap-2 border-t border-border px-4 text-left"
            onClick={() => props.onOpenStore(s.id)}
          >
            <Store size={16} aria-hidden />
            {s.name}
          </button>
        ))}
        <StoreForm
          submitLabel="建立"
          duplicateName={props.duplicateName}
          onSubmit={props.onCreate}
          onOpenExisting={props.duplicateId ? () => props.onOpenStore(props.duplicateId!) : undefined}
        />
      </SheetContent>
    </Sheet>
  )
}
