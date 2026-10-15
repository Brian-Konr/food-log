// @vitest-environment jsdom
// 畫面資料快照（app/data.tsx）：同一個 Dexie 交易讀所有表，但內容沒變的表要回同一個陣列，
// 這樣 pull 每次都寫 meta、或只動到紀錄時，items／itemsById／indexed（整個官方目錄的 mergeCatalog、buildIndex）不會重算。
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { SyncProvider } from '@food-log/sync-client'
import { DataProvider, createSnapshotCache, readSnapshot, useAppData, useNowTick } from '@/app/data'
import type { AppData } from '@/app/data'
import { ServicesProvider } from '@/app/services'
import { SessionTracker } from '@/app/session'
import { NOW, TODAY, chicken, openEnv, pasta } from './harness'

afterEach(cleanup)

const quick = (id: string) => ({
  log: { id, ts: '2026-10-10T12:00:00+08:00', day: TODAY, item_id: null, name: '豆漿', src: '其他' as const, qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 10, source: 'quick' as const, store_id: null },
})

test('readSnapshot：只寫 meta 或只動紀錄，沒動的表回同一個陣列；整張快照沒變就是同一個物件', async () => {
  const env = await openEnv({ synced: true })
  const { db } = env.client
  const cache = createSnapshotCache()
  const read = () => readSnapshot(db, 'user-1', '2026-09-01', TODAY, cache)
  const s1 = await read()

  await db.setMeta('pullRun', { reset: false, dirty: [] }) // 每次 pull 都會寫
  await db.setMeta('lastPullAt', NOW + 1)
  const s2 = await read()
  expect(s2).toBe(s1)

  await env.client.mutate('logs.add@1', quick('l1'))
  const s3 = await read()
  expect(s3).not.toBe(s1)
  expect(s3.logs).not.toBe(s1.logs)
  expect(s3.logs.map((l) => l.id)).toEqual(['l1'])
  expect(s3.items).toBe(s1.items)
  expect(s3.stores).toBe(s1.stores)
  expect(s3.favIds).toBe(s1.favIds)
  expect(s3.config).toBe(s1.config)
  expect(s3.weights).toBe(s1.weights)

  await env.client.mutate('favorites.set@1', { item_id: 'fm:1', fav: true })
  const s4 = await read()
  expect(s4.favIds).toEqual(['fm:1'])
  expect(s4.favIds).not.toBe(s3.favIds)
  expect(s4.logs).toBe(s3.logs) // 紀錄沒動

  // 同一秒內的兩次編輯（updated_at 一樣）也要看得出來：簽名是內容，不是時間戳
  await env.client.mutate('logs.update@1', { id: 'l1', patch: { kcal: 150 } })
  const s5 = await read()
  expect(s5.logs[0]!.kcal).toBe(150)
  await env.client.mutate('logs.update@1', { id: 'l1', patch: { kcal: 160 } })
  expect((await read()).logs[0]!.kcal).toBe(160)
})

function Probe(props: { sink: AppData[]; ticks: number[] }) {
  const d = useAppData()
  props.sink.push(d)
  props.ticks.push(useNowTick())
  return null
}

test('indexed／items／itemsById：pull 只動紀錄或只動 meta 時參照不變；品項真的變了才換；AppData 不因為待送時鐘每秒換', async () => {
  const env = await openEnv({ synced: true })
  const tracker = new SessionTracker(env.client)
  const sink: AppData[] = []
  const ticks: number[] = []
  render(
    <SyncProvider client={env.client}>
      <ServicesProvider tracker={tracker} now={() => NOW} catalogItems={[chicken, pasta]}>
        <DataProvider>
          <Probe sink={sink} ticks={ticks} />
        </DataProvider>
      </ServicesProvider>
    </SyncProvider>,
  )
  await waitFor(() => expect(sink.at(-1)?.ready).toBe(true))
  const first = sink.at(-1)!

  // 只動 meta（pull 的 cookie／pullRun）
  await act(async () => {
    await env.client.db.setMeta('pullRun', { reset: false, dirty: [] })
    await env.client.db.setMeta('lastPullAt', NOW + 5)
  })
  // 只動紀錄（別台裝置記了一筆，這台 pull 下來）
  await env.server.mutate('logs.add@1', quick('remote-1'))
  await act(async () => {
    await env.client.pullOnce()
  })
  await waitFor(() => expect(sink.at(-1)!.logs.map((l) => l.id)).toEqual(['remote-1']))
  const afterLogs = sink.at(-1)!
  expect(afterLogs.indexed).toBe(first.indexed)
  expect(afterLogs.items).toBe(first.items)
  expect(afterLogs.itemsById).toBe(first.itemsById)
  expect(afterLogs.stores).toBe(first.stores)

  // 品項真的變了：重算
  await act(async () => {
    await env.client.mutate('favorites.set@1', { item_id: chicken.id, fav: true })
  })
  await waitFor(() => expect(sink.at(-1)!.indexed).not.toBe(first.indexed))
  expect(sink.at(-1)!.items.find((i) => i.id === chicken.id)?.fav).toBe(true)
})

test('待送時鐘：有待送資料時 useNowTick 每秒更新，AppData 本身不換', async () => {
  const env = await openEnv({ synced: true })
  env.transport.online = false
  await env.client.mutate('favorites.set@1', { item_id: 'fm:1', fav: true })
  const tracker = new SessionTracker(env.client)
  const sink: AppData[] = []
  const ticks: number[] = []
  let clock = NOW
  render(
    <SyncProvider client={env.client}>
      <ServicesProvider tracker={tracker} now={() => clock} catalogItems={[chicken]}>
        <DataProvider>
          <Probe sink={sink} ticks={ticks} />
        </DataProvider>
      </ServicesProvider>
    </SyncProvider>,
  )
  await waitFor(() => expect(sink.at(-1)?.ready).toBe(true))
  const stable = sink.at(-1)!
  clock = NOW + 1000
  await waitFor(() => expect(ticks.at(-1)).toBe(NOW + 1000), { timeout: 3000 })
  clock = NOW + 2000
  await waitFor(() => expect(ticks.at(-1)).toBe(NOW + 2000), { timeout: 3000 })
  expect(sink.at(-1)).toBe(stable)
})
