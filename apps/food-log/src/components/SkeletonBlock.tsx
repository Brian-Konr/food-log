import { cn } from '@food-log/ui'

export function SkeletonBlock(props: { className: string; announce?: boolean }) {
  return (
    <span className={cn('skeleton-shimmer inline-block rounded-[6px] bg-muted', props.className)}>
      {props.announce && <span className="sr-only">載入中</span>}
    </span>
  )
}
