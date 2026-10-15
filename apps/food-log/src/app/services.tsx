// 整個 App 共用的服務（不是資料）：時鐘、官方品項快照、動作（actions）、主題、session 追蹤。
// 資料一律來自 sync-client 的 hooks（見 data.tsx），這裡沒有狀態機。
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useSyncClient } from '@food-log/sync-client'
import { loadSnapshot } from '@/data/catalog'
import { createActions } from '@/data/actions'
import type { Actions } from '@/data/actions'
import { KEYS, readLocal, writeLocal } from '@/lib/local-storage'
import { THEME_COLOR_DARK, THEME_COLOR_LIGHT } from '@/lib/format'
import type { CatalogItem } from '@/types'
import type { SessionTracker } from './session'

export type Theme = 'dark' | 'light'

export interface Services {
  now: () => number
  catalogItems: CatalogItem[]
  actions: Actions
  tracker: SessionTracker
  theme: Theme
  setTheme: (t: Theme) => void
}

const ServicesContext = createContext<Services | null>(null)

export function useServices(): Services {
  const s = useContext(ServicesContext)
  if (!s) throw new Error('useServices 必須在 <ServicesProvider> 底下使用')
  return s
}

export const useActions = (): Actions => useServices().actions

export function ServicesProvider(props: {
  tracker: SessionTracker
  now?: () => number
  catalogItems?: CatalogItem[]
  children?: ReactNode
}) {
  const client = useSyncClient()
  const now = useMemo(() => props.now ?? (() => Date.now()), [props.now])
  const actions = useMemo(() => createActions({ client, now }), [client, now])
  const [snapshotItems, setSnapshotItems] = useState<CatalogItem[]>(props.catalogItems ?? [])
  const [theme, setThemeState] = useState<Theme>(() => (readLocal(KEYS.theme) === 'light' ? 'light' : 'dark'))

  useEffect(() => {
    if (props.catalogItems) {
      setSnapshotItems(props.catalogItems)
      return
    }
    let cancelled = false
    void loadSnapshot().then((items) => {
      if (!cancelled) setSnapshotItems(items)
    })
    return () => {
      cancelled = true
    }
  }, [props.catalogItems])

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'light' ? THEME_COLOR_LIGHT : THEME_COLOR_DARK)
  }, [theme])

  const value = useMemo<Services>(
    () => ({
      now,
      catalogItems: snapshotItems,
      actions,
      tracker: props.tracker,
      theme,
      setTheme: (t) => {
        setThemeState(t)
        writeLocal(KEYS.theme, t)
      },
    }),
    [now, snapshotItems, actions, props.tracker, theme],
  )
  return <ServicesContext.Provider value={value}>{props.children}</ServicesContext.Provider>
}
