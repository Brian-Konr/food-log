// 外框：連線橫幅、目前的頁（路由 Outlet）、搜尋列、分頁列，以及會從任何頁打開的 Sheet 與 toast。
// 沒有資料狀態：資料在 data.tsx，畫面狀態在 ui.tsx，動作在 data/actions.ts。
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useSyncStatus } from '@food-log/sync-client'
import { NetworkBanner } from '@/components/NetworkBanner'
import { TabBar } from '@/components/TabBar'
import { ItemFormFeature } from '@/features/items/ItemFormFeature'
import { LogFeature } from '@/features/log/LogFeature'
import { SearchDockFeature, SearchSheetFeature } from '@/features/search/SearchFeature'
import { StoresFeature } from '@/features/stores/StoresFeature'
import { FailedToasts } from '@/features/toast/FailedToasts'
import { ToastView } from '@/features/toast/ToastProvider'
import { WeightFeature } from '@/features/weight/WeightFeature'
import type { Tab } from '@/types'
import { useAppData } from './data'
import { UpdatePrompt } from '@/features/update/UpdatePrompt'
import { useMinClientVersion } from './update-info'
import { useNeedRefresh } from './sw'

/** 回滾用的 kill switch：Worker 設 MIN_CLIENT_VERSION=9999，所有 push 都回 409（見計畫第 6 節）。 */
export const RETIRED_MIN_CLIENT_VERSION = 9999

const TABS: readonly Tab[] = ['today', 'trends', 'items', 'settings']

/** `#weight` 是今天頁上開著記體重 Sheet。 */
export function tabOf(pathname: string): Tab {
  const t = pathname.replace(/^\//, '')
  if (t === 'weight') return 'today'
  return (TABS as readonly string[]).includes(t) ? (t as Tab) : 'today'
}

export function AppShell() {
  const d = useAppData()
  const navigate = useNavigate()
  const status = useSyncStatus()
  const needRefresh = useNeedRefresh()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const tab = tabOf(pathname)
  const minClientVersion = useMinClientVersion()

  return (
    <div data-load-state={d.loadState} data-ready={String(d.ready)} className="relative h-full min-h-dvh min-h-full bg-background pt-[var(--safe-top)] text-foreground">
      <UpdatePrompt open={status.phase === 'too_old' || needRefresh} retired={minClientVersion !== null && minClientVersion >= RETIRED_MIN_CLIENT_VERSION} />
      <NetworkBanner network={d.network} mock={d.mode === 'trial'} />
      <Outlet />
      {tab === 'today' && <SearchDockFeature />}
      <TabBar tab={tab} onChange={(t) => void navigate({ to: `/${t}`, replace: true })} />
      <SearchSheetFeature />
      <StoresFeature />
      <LogFeature />
      <WeightFeature />
      <ItemFormFeature />
      <FailedToasts />
      <ToastView dock={tab === 'today'} />
    </div>
  )
}
