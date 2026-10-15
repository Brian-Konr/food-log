// 測試共用：每台模擬裝置一個 IDBFactory（彼此隔離的 IndexedDB）、共用一個 MemoryServer。
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { TABLES } from '@food-log/core'
import type { Row, Table } from '@food-log/core'
import { MemoryServer, TEST_NOW, itemArgs, logArgs, noonOf, storeArgs, weightArgs } from '@food-log/core/testing'
import { SyncClient } from '../src/client'
import type { SyncClientOptions } from '../src/client'
import type { LoopEnv } from '../src/loop'
import { MemoryTransport } from '../src/testing'
import type { MemoryTransportOptions } from '../src/testing'
import type { UserStore } from '@food-log/core'

export { TEST_NOW, itemArgs, logArgs, noonOf, storeArgs, weightArgs }
export const USER = 'user-1'
/** 預設使用者是 USER 的 MemoryServer（helper 和 server.db 都針對它）。 */
export const newServer = (): MemoryServer => new MemoryServer({ userId: USER })

export interface Device {
  factory: IDBFactory
  client: SyncClient
  transport: MemoryTransport
  name: string
}

let seq = 0

/** 假的前景／網路事件來源。 */
export class FakeLoopEnv implements LoopEnv {
  visible = true
  private visibleCbs = new Set<() => void>()
  private onlineCbs = new Set<() => void>()
  isVisible = () => this.visible
  onVisible = (cb: () => void) => {
    this.visibleCbs.add(cb)
    return () => void this.visibleCbs.delete(cb)
  }
  onOnline = (cb: () => void) => {
    this.onlineCbs.add(cb)
    return () => void this.onlineCbs.delete(cb)
  }
  fireVisible() {
    this.visible = true
    for (const c of [...this.visibleCbs]) c()
  }
  fireOnline() {
    for (const c of [...this.onlineCbs]) c()
  }
  listeners() {
    return this.visibleCbs.size + this.onlineCbs.size
  }
}

export interface DeviceOptions {
  server: MemoryServer
  userId?: string | null
  factory?: IDBFactory
  transport?: MemoryTransport
  transportOptions?: Partial<MemoryTransportOptions>
  loopEnv?: LoopEnv
  clientOptions?: Partial<SyncClientOptions>
  wrapStore?: (s: UserStore) => UserStore
}

export async function openDevice(o: DeviceOptions): Promise<Device> {
  const factory = o.factory ?? new IDBFactory()
  const userId = o.userId === undefined ? USER : o.userId
  const transport =
    o.transport ??
    new MemoryTransport({
      server: o.server,
      userId: userId ?? USER,
      ...(o.wrapStore ? { wrapStore: o.wrapStore } : {}),
      ...o.transportOptions,
    })
  const id = ++seq
  const client = await SyncClient.open({
    userId,
    ...(userId === null ? {} : { transport }),
    now: () => TEST_NOW,
    dexie: { indexedDB: factory, IDBKeyRange },
    newId: () => `client-${id}`,
    ...(o.loopEnv ? { loopEnv: o.loopEnv } : {}),
    ...o.clientOptions,
  })
  return { factory, client, transport, name: `device-${id}` }
}

/** 同一個 IndexedDB（同一個 factory）重新開一個用戶端 = App 重啟。 */
export async function restartDevice(d: Device, o: Omit<DeviceOptions, 'factory' | 'transport'> & { userId?: string | null }): Promise<Device> {
  d.client.close()
  return openDevice({ ...o, factory: d.factory, transport: d.transport })
}

/** 一次完整的同步循環（手動）：push 再 pull。 */
export async function sync(d: Device): Promise<void> {
  await d.client.pushOnce()
  await d.client.pullOnce()
}

export async function viewOf<T extends Table>(d: Device, t: T): Promise<Row<T>[]> {
  return (await d.client.db.view(t).toArray()) as Row<T>[]
}
export const liveViewOf = async <T extends Table>(d: Device, t: T): Promise<Row<T>[]> =>
  (await viewOf(d, t)).filter((r) => (r as { deleted_at: string | null }).deleted_at === null)

export function serverRows<T extends Table>(server: MemoryServer, t: T): Row<T>[] {
  return server.db.all(t)
}
export const liveServerRows = <T extends Table>(server: MemoryServer, t: T): Row<T>[] =>
  serverRows(server, t).filter((r) => (r as { deleted_at: string | null }).deleted_at === null)

export const ALL = TABLES
