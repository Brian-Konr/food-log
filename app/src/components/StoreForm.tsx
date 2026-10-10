import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export function StoreForm(props: {
  initialName?: string
  submitLabel: string
  duplicateName?: string
  onSubmit: (name: string) => void
  onOpenExisting?: () => void
}) {
  const [name, setName] = useState(props.initialName ?? '')
  useEffect(() => { setName(props.initialName ?? '') }, [props.initialName])
  const empty = name.trim() === ''
  return (
    <div className="px-4 pb-4">
      <label className="block">
        <span className="sr-only">店名</span>
        <input
          aria-label="店名"
          enterKeyHint="done"
          className="mt-2 h-12 w-full rounded-xl border border-input bg-card px-3"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {props.duplicateName && (
        <p className="mt-2 text-destructive">
          已經有『{props.duplicateName}』
          {props.onOpenExisting && (
            <button type="button" className="ml-2 h-11 text-primary" onClick={props.onOpenExisting}>打開這家店</button>
          )}
        </p>
      )}
      <button
        type="button"
        disabled={empty}
        className={cn('mt-4 h-12 w-full rounded-[var(--radius)] font-bold', empty ? 'bg-secondary text-muted-foreground' : 'bg-primary text-primary-foreground')}
        onClick={() => !empty && props.onSubmit(name.trim())}
      >
        {props.submitLabel}
      </button>
    </div>
  )
}
