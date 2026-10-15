// 測試用：fullRebuild(srv, pending)。從伺服器狀態（srv）出發，依序重播所有 pending，得到「畫面應該長的樣子」。
// rebase 的不變式：Dexie 的畫面表 == fullRebuild(srv_*, pending)（多頁 pull 進行中除外，見 checkViewInvariant）。
// 這裡刻意不用 LocalTx／Dexie，而是用 core 的 MemoryTx：兩個獨立實作的 Tx 對得上，才能證明 LocalTx 沒有偏離 mutator 的語意。
// 重播的規則和 rebase 相同：ctx.now = 該 mutation 的 clientTs；丟 MutationError 的就跳過（沒有寫入）；寫入蓋上 version 0。
import { MemoryDb, MemoryTx } from '@food-log/core/testing'
import { TABLES, executeMutation, isMutationError, rowKey } from '@food-log/core'
import type { Row, Table } from '@food-log/core'
import type { FoodLogDb, PendingRow } from '../db'
import { localCtx } from '../local-tx'

export type TableSnapshot = { [T in Table]: Row<T>[] }
type PendingLike = Pick<PendingRow, 'name' | 'args' | 'clientTs'>

export function sortRows<T extends Table>(t: T, rows: readonly Row<T>[]): Row<T>[] {
  return [...rows].sort((a, b) => {
    const ka = rowKey(t, a as never)
    const kb = rowKey(t, b as never)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

export async function fullRebuild(srv: TableSnapshot, pending: readonly PendingLike[], userId: string): Promise<TableSnapshot> {
  const db = new MemoryDb(userId)
  for (const t of TABLES) for (const r of srv[t]) db.seed(t, structuredClone(r) as never)
  for (const p of pending) {
    const tx = new MemoryTx(db)
    try {
      await executeMutation(tx, localCtx(p.clientTs), p.name, structuredClone(p.args))
    } catch (e) {
      if (isMutationError(e)) continue
      throw e
    }
    tx.applyTo(db, 0)
  }
  const out = {} as Record<Table, unknown[]>
  for (const t of TABLES) out[t] = sortRows(t, db.all(t))
  return out as unknown as TableSnapshot
}

/** key 順序固定的 JSON（比對用）。 */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  )
}

/** 讀 Dexie 某一組表（畫面表或 srv 表）的全部內容，依主鍵排序。 */
export async function readTables(db: FoodLogDb, which: 'view' | 'srv'): Promise<TableSnapshot> {
  const out = {} as Record<Table, unknown[]>
  for (const t of TABLES) {
    const tbl = (which === 'view' ? db.view(t) : db.srv(t)) as unknown as { toArray(): Promise<Row<Table>[]> }
    out[t] = sortRows(t, await tbl.toArray())
  }
  return out as unknown as TableSnapshot
}

/** 這台裝置的不變式：畫面表 == fullRebuild(srv 表, pending)。通過回 null，否則回描述差異的字串。 */
export async function checkViewInvariant(db: FoodLogDb): Promise<string | null> {
  // 多頁 pull 進行中：srv 已經收了一部分、畫面表刻意還是舊的（最後一頁才重建），不變式只在 pull 結束後成立。
  if ((await db.getMeta<unknown>('pullRun', null)) !== null) return null
  const userId = await db.getMeta<string>('userId', 'local')
  const [view, srv, pending] = await Promise.all([readTables(db, 'view'), readTables(db, 'srv'), db.pending.orderBy('mutationId').toArray()])
  const expected = await fullRebuild(srv, pending, userId)
  for (const t of TABLES) {
    const a = canon(view[t])
    const b = canon(expected[t])
    if (a !== b) {
      return `${t}: view != fullRebuild\n  view:     ${a}\n  expected: ${b}\n  pending:  ${JSON.stringify(pending.map((p) => [p.mutationId, p.name, p.args]))}`
    }
  }
  return null
}
