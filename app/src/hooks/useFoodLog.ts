import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createApi, type Api, type ApiStatus } from '@/api'
import type { Adapter } from '@/api/types'
import type { CatalogItem, Snapshot } from '@/types'
import type { Kv } from '@/data/kv'
import { decodeSnapshot } from '@/data/codec'
import { mergeCatalog, parseFavIds } from '@/data/catalog'
import { networkState, RECHECK_AFTER_FAIL_MS } from '@/data/network'
import { loadSnapshot } from '@/data/catalog'
import { classifyError, deriveLoadState, errorCopy, type ErrorKind, type LoadState } from '@/data/loadstate'
import type { CachedSnapshot } from '@/data/cache'
import { isStaleToday } from '@/data/cache'
import { taipeiToday } from '@/lib/day'

export function useFoodLog(opts: {
  adapter: Adapter | null
  storage?: Storage
  now?: () => number
  catalog?: CatalogItem[]
  kv?: Kv
}) {
  const api = useMemo(() => {
    if (!opts.adapter) return null
    return createApi({ adapter: opts.adapter, storage: opts.storage, now: opts.now, kv: opts.kv })
  }, [opts.adapter, opts.storage, opts.now, opts.kv])

  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [browserOnline, setBrowserOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  const [failStreak, setFailStreak] = useState(0)
  const [snapshotItems, setSnapshotItems] = useState<CatalogItem[]>(opts.catalog ?? [])
  const [booting, setBooting] = useState(true)
  const [fresh, setFresh] = useState(false)
  const [error, setError] = useState<{ kind: ErrorKind; code: string } | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [cache, setCache] = useState<CachedSnapshot | null>(null)
  const inflight = useRef<Promise<void> | null>(null)
  const autoOnline = useRef(false)
  const autoVis = useRef(false)
  const freshRef = useRef(false)
  freshRef.current = fresh

  useEffect(() => {
    if (opts.catalog) { setSnapshotItems(opts.catalog); return }
    void loadSnapshot().then(setSnapshotItems)
  }, [opts.catalog])

  const refresh = useCallback(async () => {
    if (!api) return
    if (inflight.current) return inflight.current
    inflight.current = (async () => {
      setRetrying(true)
      try {
        const s = await api.load()
        setSnap(s)
        setCache(api.cache())
        setError(null)
        setFresh(true)
        autoOnline.current = false
        autoVis.current = false
        setFailStreak(0)
      } catch (err) {
        const classified = classifyError(err, typeof navigator === 'undefined' ? browserOnline : navigator.onLine)
        const p = api.peek()
        if (p) setSnap(p)
        setCache(api.cache())
        if (classified.kind === 'offline' && freshRef.current) {
          // 已成功 read 過：離線時不要改成 error-cached，頂列才能顯示「離線 · N 筆待上傳」
        } else {
          setError(classified)
          setFailStreak((n) => n + 1)
        }
      } finally {
        setRetrying(false)
        inflight.current = null
      }
    })()
    return inflight.current
  }, [api, browserOnline])

  useEffect(() => {
    if (!api) { setBooting(false); return }
    let cancelled = false
    void (async () => {
      await api.ready
      if (cancelled) return
      setCache(api.cache())
      const p = api.peek()
      if (p) setSnap(p)
      setBooting(false)
      void refresh()
    })()
    return () => { cancelled = true }
  }, [api, refresh])

  useEffect(() => {
    if (!api) return
    return api.onStatus((s) => {
      setStatus(s)
      const p = api.peek()
      if (p) setSnap(p)
      if (typeof navigator !== 'undefined') setBrowserOnline(navigator.onLine)
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    const onOnline = () => {
      setBrowserOnline(true)
      void api.flush()
      if (error && !autoOnline.current) {
        autoOnline.current = true
        void refresh()
      }
    }
    const onOffline = () => setBrowserOnline(false)
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void api.flush()
      if (error && !autoVis.current) {
        autoVis.current = true
        void refresh()
      }
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (typeof navigator !== 'undefined' && !navigator.onLine) return
      void refresh()
    }, 120_000)
    addEventListener('online', onOnline)
    addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      removeEventListener('online', onOnline)
      removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, refresh, error])

  const pending = status?.pending ?? 0
  const queuedOnline = status?.online ?? true
  useEffect(() => {
    if (failStreak !== 1 || !browserOnline) return
    const t = setTimeout(() => { void refresh() }, RECHECK_AFTER_FAIL_MS)
    return () => clearTimeout(t)
  }, [failStreak, browserOnline, refresh])

  const data = useMemo(() => (snap ? decodeSnapshot(snap) : null), [snap])
  const items = useMemo(
    () => mergeCatalog(snapshotItems, data?.items ?? [], parseFavIds(data?.config.fav_ids), data?.stores ?? []),
    [snapshotItems, data],
  )

  const nowMs = opts.now?.() ?? Date.now()
  const today = taipeiToday(nowMs)
  const staleToday = isStaleToday(cache, today)
  const loadState: LoadState = deriveLoadState({ booting, cache, fresh, error })
  const copy = error ? errorCopy(error.kind, error.code) : null

  return {
    api,
    data,
    items,
    stores: data?.stores ?? [],
    snapshotItems,
    network: networkState({ browserOnline, backendOk: queuedOnline, pending, failStreak }),
    queuedCount: pending,
    failedCount: status?.failed.length ?? 0,
    failed: status?.failed ?? [],
    refresh,
    loadState,
    errorKind: error?.kind ?? null,
    errorCode: error?.code ?? null,
    errorReason: copy?.reason ?? null,
    errorCodeLine: copy?.codeLine ?? null,
    staleToday,
    retrying,
    cache,
    booting,
  }
}

export type FoodLogApi = Api
