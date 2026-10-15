// 所有 provider 的順序：SyncProvider（sync-client）→ 服務（時鐘、動作、主題）→ toast → 畫面狀態 → 資料 → 路由。
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/history'
import { SyncProvider, useSyncStatus } from '@food-log/sync-client'
import type { SyncClient } from '@food-log/sync-client'
import { ToastProvider } from '@/features/toast/ToastProvider'
import type { CatalogItem } from '@/types'
import { ControlsContext } from './controls'
import type { Controls } from './controls'
import { DataProvider } from './data'
import { createAppHashHistory } from './history'
import { createAppRouter } from './router'
import { ServicesProvider } from './services'
import { SessionTracker } from './session'
import { checkForUpdate } from './sw'
import { UiProvider } from './ui'

/** 409 client_too_old：同步已經停了。先去找新版，讓 UpdatePrompt 的「重新載入」換得上（Dexie 的資料和待送佇列都還在）。 */
function UpdateWatcher() {
  const status = useSyncStatus()
  const tooOld = status.phase === 'too_old'
  useEffect(() => {
    if (tooOld) void checkForUpdate()
  }, [tooOld])
  return null
}

export function AppProviders(props: {
  client: SyncClient
  controls: Controls
  now?: () => number
  catalogItems?: CatalogItem[]
  history?: RouterHistory
  /** 開始自動同步（預設 true）。測試要手動控制同步時給 false。 */
  autoStart?: boolean
  children?: ReactNode
}) {
  const { client } = props
  const [tracker] = useState(() => new SessionTracker(client))
  const [router] = useState(() => createAppRouter(props.history ?? createAppHashHistory()))
  // tracker 的壽命和 client 一樣長（不在 effect cleanup 裡 dispose：StrictMode 會把 effect 跑兩次）
  const autoStart = props.autoStart !== false
  useEffect(() => {
    if (!autoStart) return
    client.start()
    return () => client.stop()
  }, [client, autoStart])
  return (
    <SyncProvider client={client}>
      <ControlsContext.Provider value={props.controls}>
        <ServicesProvider tracker={tracker} now={props.now} catalogItems={props.catalogItems}>
          <ToastProvider>
            <UiProvider>
              <DataProviderWithRouter router={router} />
              <UpdateWatcher />
              {props.children}
            </UiProvider>
          </ToastProvider>
        </ServicesProvider>
      </ControlsContext.Provider>
    </SyncProvider>
  )
}

function DataProviderWithRouter(props: { router: ReturnType<typeof createAppRouter> }) {
  return (
    <DataProvider>
      <RouterProvider router={props.router} />
    </DataProvider>
  )
}
