// UI 測試共用：每個測試一台「裝置」= 獨立的 fake-indexeddb + SyncClient，接到共用的 MemoryServer（MemoryTransport，不經過網路）。
// 和 packages/sync-client/test/helpers.ts 同一套做法，但在 jsdom 裡把整個 App 掛起來。
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createMemoryHistory } from '@tanstack/history'
import { SyncClient } from '@food-log/sync-client'
import { MemoryTransport } from '@food-log/sync-client/testing'
import { MemoryServer } from '@food-log/core/testing'
import type { MutationArgs, MutationName } from '@food-log/core'
import App from '@/app/Root'
import type { AppProps } from '@/app/Root'
import type { CatalogItem } from '@/types'

export const NOW = Date.parse('2026-10-10T18:00:00+08:00')
export const TODAY = '2026-10-10'
export const USER = 'user-1'

export const chicken: CatalogItem = {
  id: 'fm:1032099', src: 'familymart', name: '法式香草嫩雞胸', cat: '小菜', serving: '1 份（100 g）',
  servingG: 100, perPack: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}
export const pasta: CatalogItem = {
  id: '711:89f35c5c37', src: '711', name: '晶英-麻辣奶油鮮蝦義大利麵', cat: '鮮食', serving: '1 份',
  servingG: null, perPack: 1, kcal: 586, protein: null, fat: null, carb: null,
}

export const newServer = (): MemoryServer => new MemoryServer({ userId: USER, now: () => NOW })

/** 直接對「伺服器」寫入（模擬別台裝置或 Kyujin 之前寫的資料）。 */
export async function seed<N extends MutationName>(server: MemoryServer, name: N, args: MutationArgs<N>): Promise<void> {
  const r = await server.mutate(name, args)
  if (!r.ok) throw new Error(`seed ${name} 失敗：${r.error} ${r.message}`)
}

export interface Env {
  server: MemoryServer
  factory: IDBFactory
  transport: MemoryTransport
  client: SyncClient
}

let seq = 0

/** 開一台裝置。trial = 本機試用（沒有 transport）。synced = 先完整同步一次（像「上次打開過」）。 */
export async function openEnv(o: { server?: MemoryServer; trial?: boolean; synced?: boolean; factory?: IDBFactory } = {}): Promise<Env> {
  const server = o.server ?? newServer()
  const factory = o.factory ?? new IDBFactory()
  const transport = new MemoryTransport({ server, userId: USER })
  const id = ++seq
  const client = await SyncClient.open({
    userId: o.trial ? null : USER,
    ...(o.trial ? {} : { transport }),
    now: () => NOW,
    dexie: { indexedDB: factory, IDBKeyRange },
    newId: () => `client-${id}`,
  })
  if (o.synced && !o.trial) {
    await client.pushOnce()
    await client.pullOnce()
  }
  return { server, factory, transport, client }
}

export function mountApp(env: Env, extra: Partial<AppProps> & { hash?: string } = {}) {
  const { hash, ...rest } = extra
  const history = createMemoryHistory({ initialEntries: [hash ?? '/today'] })
  const user = userEvent.setup()
  const view = render(<App client={env.client} catalogItems={[chicken, pasta]} now={() => NOW} history={history} {...rest} />)
  return { user, history, ...view }
}

/** 讓同步跑完（push + pull）。 */
export async function settle(env: Env): Promise<void> {
  await env.client.syncNow()
}

export const liveRows = <T extends { deleted_at: string | null }>(rows: T[]): T[] => rows.filter((r) => r.deleted_at === null)
