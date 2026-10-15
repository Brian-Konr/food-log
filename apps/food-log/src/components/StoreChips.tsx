import { Store } from 'lucide-react'

export function StoreChip(props: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`店家 ${props.name}`}
      onClick={props.onClick}
      className="flex h-11 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3.5 font-semibold"
    >
      <Store size={16} className="shrink-0" aria-hidden />
      <span className="max-w-[9rem] truncate">{props.name}</span>
    </button>
  )
}
