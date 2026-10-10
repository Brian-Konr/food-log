import { useCallback, useEffect, useMemo, useState } from 'react'
import { createApi, type Api, type ApiStatus } from '@/api'
import type { Adapter } from '@/api/types'
import type { CatalogItem, Snapshot } from '@/types'
import { decodeSnapshot } from '@/data/codec'
import { mergeCatalog, parseFavIds } from '@/data/catalog'
import { networkState, RECHECK_AFTER_FAIL_MS } from '@/data/network'
import { loadSnapshot } from '@/data/catalog'

export function useFoodLog(opts: {
  adapter: Adapter | null
  storage?: Storage
  now?: () => number
  catalog?: CatalogItem[]
}) {
  const api = useMemo(() => {
    if (!opts.adapter) return null
    return createApi({ adapter: opts.adapter, storage: opts.storage, now: opts.now })
  }, [opts.adapter, opts.storage, opts.now])

  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  const [failStreak, setFailStreak] = useState(0)
  const [snapshotItems, setSnapshotItems] = useState<CatalogItem[]>(opts.catalog ?? [])

  useEffect(() => {
    if (opts.catalog) { setSnapshotItems(opts.catalog); return }
    void loadSnapshot().then(setSnapshotItems)
  }, [opts.catalog])

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      setSnap(await api.load())
    } catch { /* keep */ }
    const ok = api.status().online
    setFailStreak((n) => (ok ? 0 : n + 1))
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onStatus((s) => { setStatus(s); const p = api.peek(); if (p) setSnap(p) })
  }, [api])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!api) return
    const onOnline = () => { setBrowserOnline(true); void refresh() }
    const onOffline = () => setBrowserOnline(false)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 120_000)
    addEventListener('online', onOnline)
    addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      removeEventListener('online', onOnline)
      removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, refresh])

  const pending = status?.pending ?? 0
  const online = status?.online ?? true
  useEffect(() => {
    if (!api) return
    if (!(pending > 0 || !online)) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') void api.flush() }, 20_000)
    return () => clearInterval(t)
  }, [api, pending, online])

  useEffect(() => {
    if (failStreak !== 1 || !browserOnline) return
    const t = setTimeout(() => { void refresh() }, RECHECK_AFTER_FAIL_MS)
    return () => clearTimeout(t)
  }, [failStreak, browserOnline, refresh])

  const data = snap ? decodeSnapshot(snap) : null
  const items = useMemo(
    () => mergeCatalog(snapshotItems, data?.items ?? [], parseFavIds(data?.config.fav_ids)),
    [snapshotItems, data],
  )

  return {
    api,
    data,
    items,
    snapshotItems,
    network: networkState({ browserOnline, backendOk: status?.online ?? true, pending, failStreak }),
    queuedCount: pending,
    failedCount: status?.failed.length ?? 0,
    refresh,
  }
}

export type FoodLogApi = Api
