// @vitest-environment jsdom
// Dexie 的 liveQuery 需要全域有 indexedDB（瀏覽器本來就有）；每台裝置仍然用自己的 IDBFactory。
import 'fake-indexeddb/auto'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SyncProvider, useConfig, useFailed, useFavorites, useItems, useLogsForDay, useLogsRange, usePendingKeys, useStores, useSyncStatus, useWeights } from '../src/hooks'
import { logArgs, newServer, noonOf, openDevice, storeArgs, sync, weightArgs } from './helpers'
import type { Device } from './helpers'

afterEach(cleanup)

const wrap = (d: Device) => ({ children }: { children: ReactNode }) => createElement(SyncProvider, { client: d.client, children })

describe('hooks（useLiveQuery）', () => {
  it('useLogsForDay／useLogsRange：本機寫入立刻出現，刪除後消失；undefined 表示還在載入', async () => {
    const d = await openDevice({ server: newServer() })
    const day = renderHook(() => useLogsForDay('2026-10-11'), { wrapper: wrap(d) })
    const range = renderHook(() => useLogsRange('2026-10-01', '2026-10-31'), { wrapper: wrap(d) })
    expect(day.result.current).toBeUndefined()
    await waitFor(() => expect(day.result.current).toEqual([]))
    await act(async () => {
      await d.client.mutate('logs.add@1', { log: logArgs({ id: 'a', ts: noonOf('2026-10-11', '13:00') }) })
      await d.client.mutate('logs.add@1', { log: logArgs({ id: 'b', ts: noonOf('2026-10-11', '08:00') }) })
      await d.client.mutate('logs.add@1', { log: logArgs({ id: 'c', day: '2026-10-10', ts: noonOf('2026-10-10') }) })
    })
    await waitFor(() => expect(day.result.current?.map((l) => l.id)).toEqual(['b', 'a'])) // 依 ts
    await waitFor(() => expect(range.result.current?.map((l) => l.id)).toEqual(['c', 'b', 'a']))
    await act(async () => {
      await d.client.mutate('logs.delete@1', { id: 'a' })
    })
    await waitFor(() => expect(day.result.current?.map((l) => l.id)).toEqual(['b']))
  })

  it('useItems／useStores／useWeights／useFavorites／useConfig', async () => {
    const d = await openDevice({ server: newServer() })
    const w = wrap(d)
    const stores = renderHook(() => useStores(), { wrapper: w })
    const items = renderHook(() => useItems(), { wrapper: w })
    const weights = renderHook(() => useWeights({ from: '2026-10-10' }), { wrapper: w })
    const favs = renderHook(() => useFavorites(), { wrapper: w })
    const config = renderHook(() => useConfig(), { wrapper: w })
    await waitFor(() => expect(config.result.current).toMatchObject({ target_kcal: 2000 })) // 沒有設定 → 預設值
    await act(async () => {
      await d.client.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '店' }))
      await d.client.mutate('items.upsert@1', { id: 'u:1', kind: '自建', src: '其他', name: '乳清', serving: '1 匙', kcal: 1, protein: 1, fat: 1, carb: 1 })
      await d.client.mutate('weights.upsert@1', weightArgs({ id: 'w1', day: '2026-10-09', ts: noonOf('2026-10-09') }))
      await d.client.mutate('weights.upsert@1', weightArgs({ id: 'w2', day: '2026-10-11', ts: noonOf('2026-10-11'), kg: 71 }))
      await d.client.mutate('favorites.set@1', { item_id: 'fm:1', fav: true })
      await d.client.mutate('config.set@1', { key: 'target_kcal', value: 1800 })
    })
    await waitFor(() => expect(stores.result.current?.map((s) => s.id)).toEqual(['s:1']))
    await waitFor(() => expect(items.result.current?.map((s) => s.id)).toEqual(['u:1']))
    await waitFor(() => expect(weights.result.current?.map((x) => x.id)).toEqual(['w2'])) // from 過濾
    await waitFor(() => expect(favs.result.current).toEqual(['fm:1']))
    await waitFor(() => expect(config.result.current?.target_kcal).toBe(1800))
    await act(async () => {
      await d.client.mutate('favorites.set@1', { item_id: 'fm:1', fav: false })
      await d.client.mutate('stores.delete@1', { id: 's:1' })
    })
    await waitFor(() => expect(favs.result.current).toEqual([]))
    await waitFor(() => expect(stores.result.current).toEqual([]))
  })

  it('usePendingKeys／useFailed／useSyncStatus：同步後 pending 清空，業務錯誤出現在 failed', async () => {
    const server = newServer()
    const a = await openDevice({ server })
    const b = await openDevice({ server })
    const pending = renderHook(() => usePendingKeys(), { wrapper: wrap(b) })
    const failed = renderHook(() => useFailed(), { wrapper: wrap(b) })
    const status = renderHook(() => useSyncStatus(), { wrapper: wrap(b) })
    expect(status.result.current.pendingCount).toBe(0)
    await act(async () => {
      await b.client.mutate('stores.upsert@1', storeArgs({ id: 's:b', name: '同名店' }))
      await a.client.mutate('stores.upsert@1', storeArgs({ id: 's:a', name: '同名店' }))
      await sync(a)
    })
    await waitFor(() => expect([...(pending.result.current ?? [])]).toEqual(['stores:s:b']))
    await waitFor(() => expect(status.result.current.pendingCount).toBe(1))
    await act(async () => {
      await sync(b)
    })
    await waitFor(() => expect(pending.result.current?.size).toBe(0))
    await waitFor(() => expect(failed.result.current?.map((f) => f.error)).toEqual(['duplicate_name']))
    await waitFor(() => expect(status.result.current).toMatchObject({ pendingCount: 0, failed: 1, hasServerData: true }))
  })

  it('沒有 Provider 就丟錯', () => {
    expect(() => renderHook(() => useStores())).toThrow(/SyncProvider/)
  })
})
