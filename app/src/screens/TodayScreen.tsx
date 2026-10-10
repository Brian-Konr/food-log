import { Scale } from 'lucide-react'
import type { LoadState } from '@/data/loadstate'
import type { LogRecord, MergedItem, StoreRecord } from '@/types'
import { formatLongDate } from '@/lib/format'
import { RemainingSummary } from '@/components/RemainingSummary'
import { LogRow } from '@/components/LogRow'
import { SyncBadge } from '@/components/SyncBadge'
import { SkeletonBlock } from '@/components/SkeletonBlock'

export function TodayScreen(props: {
  today: string
  remain: { kcal: number; protein: number; fat: number; carb: number }
  eaten: { kcal: number; protein: number; fat: number; carb: number }
  targets: { kcal: number; protein: number; fat: number; carb: number }
  logs: LogRecord[]
  itemsById: Map<string, MergedItem>
  stores: StoreRecord[]
  onWeight: () => void
  onOpenLog: (log: LogRecord) => void
  loadState: LoadState
  staleToday: boolean
  errorReason?: string | null
  errorCodeLine?: string | null
  retrying?: boolean
  onRetry: () => void
  pending: number
  online: boolean
  now?: number
  failedLogCount?: number
  hasToast?: boolean
}) {
  const skeletonToday = props.loadState === 'skeleton' || props.loadState === 'error-empty' || props.staleToday
  const live = props.logs.filter((l) => !l.deleted).sort((a, b) => a.ts.localeCompare(b.ts))
  const cached = props.loadState === 'cached-syncing' || props.loadState === 'error-cached'
  const emptyOk = (props.loadState === 'fresh' || (props.loadState === 'cached-syncing' && !props.staleToday)) && live.length === 0

  return (
    <div
      className="mx-auto w-full max-w-xl px-4 pt-1"
      style={{ paddingBottom: `calc(var(--dock-h) + var(--tabbar-h) + var(--safe-bottom) + 16px + ${props.hasToast ? '64px' : '0px'})` }}
    >
      <div className="sticky top-0 z-20 flex items-center justify-between bg-background py-2">
        <span className="font-medium text-muted-foreground">{formatLongDate(props.today)}</span>
        <div className="flex items-center">
          <SyncBadge
            loadState={props.loadState}
            pending={props.pending}
            online={props.online}
            onRetry={props.onRetry}
            retrying={props.retrying}
          />
          <button type="button" aria-label="記體重" onClick={props.onWeight} className="grid size-11 place-items-center text-muted-foreground">
            <Scale size={22} strokeWidth={2} />
          </button>
        </div>
      </div>
      {props.loadState === 'error-empty' ? (
        <section className="rounded-[var(--radius)] border border-border bg-card p-5">
          <h2 className="text-xl font-bold">讀不到今天的資料</h2>
          {props.errorReason && <p className="mt-2">{props.errorReason}</p>}
          {props.errorCodeLine && <p className="mt-1 text-muted-foreground">{props.errorCodeLine}</p>}
          <button
            type="button"
            disabled={props.retrying}
            className="mt-4 h-12 w-full rounded-[var(--radius)] bg-primary font-bold text-primary-foreground disabled:bg-secondary disabled:text-muted-foreground"
            onClick={props.onRetry}
          >
            {props.retrying ? '重試中…' : '重試'}
          </button>
        </section>
      ) : (
        <div className={skeletonToday || props.loadState === 'fresh' ? 'fade-in' : undefined}>
          <RemainingSummary
            remain={props.remain}
            eaten={props.eaten}
            targets={props.targets}
            skeleton={skeletonToday}
            muted={cached}
            cached={cached}
            failedCount={props.failedLogCount}
          />
        </div>
      )}
      {props.loadState !== 'error-empty' && (
        <>
          <div className="mt-5 flex items-center justify-between px-2">
            <h2 className="text-xl font-bold">今天的紀錄</h2>
            {!skeletonToday && <span className="text-muted-foreground">{live.length} 筆</span>}
          </div>
          <div className="mt-2 overflow-hidden rounded-[var(--radius)] border border-border bg-card">
            {skeletonToday ? (
              <div aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex min-h-[60px] items-center gap-3 border-b border-border px-4 last:border-0">
                    <SkeletonBlock className="h-4 w-10" announce={i === 0} />
                    <div className="min-w-0 flex-1">
                      <SkeletonBlock className="h-4 w-40" />
                      <SkeletonBlock className="mt-1 h-4 w-24" />
                    </div>
                    <SkeletonBlock className="h-4 w-10" />
                  </div>
                ))}
              </div>
            ) : emptyOk ? (
              <p className="px-4 py-6 text-muted-foreground">今天還沒有紀錄</p>
            ) : live.map((l) => (
              <LogRow key={l.id} log={l} item={props.itemsById.get(l.item_id)} stores={props.stores} onOpen={props.onOpenLog} now={props.now} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
