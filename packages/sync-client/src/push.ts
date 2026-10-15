// push：把 pending 依序、每批最多 MAX_PUSH_MUTATIONS 筆送出（計畫 §3.4）。
//   - ok：什麼都不動。pending 留著，等下一次 pull 確認（lastMutationId 涵蓋它）才丟掉，畫面不會閃一下。
//   - 錯誤（業務錯誤）：先記進 failed（source=server），pending 一樣留到 pull 確認。
//   - 回應掉了或請求失敗：丟錯給 loop（NetworkError…），pending 不動；下次重送，伺服器依 mutationId 去重（只生效一次）。
// sentUpTo 只在記憶體：同一個 session 內不重複送已經有答案的；重啟後從 meta.lastMutationId 之後全部再送一次（伺服器去重）。
import { MAX_PUSH_MUTATIONS, taipeiIso } from '@food-log/core'
import type { PushResult } from '@food-log/core'
import type { FailedRow, FoodLogDb, PendingRow } from './db'
import type { Transport } from './transport'

export class PushCursor {
  /** 這個 session 已經收到答案的最大 mutationId。 */
  sentUpTo = 0
}

export interface PushEnv {
  db: FoodLogDb
  transport: Transport
  cursor: PushCursor
  now: () => number
  /** pending／failed 變了（更新狀態）。 */
  onChanged?: (() => void) | undefined
}

/** 取下一批要送的 pending。 */
async function nextBatch(db: FoodLogDb, cursor: PushCursor): Promise<PendingRow[]> {
  const confirmed = await db.getMeta<number>('lastMutationId', 0)
  const from = Math.max(cursor.sentUpTo, confirmed)
  return db.pending.where('mutationId').above(from).limit(MAX_PUSH_MUTATIONS).toArray()
}

async function recordResults(db: FoodLogDb, batch: readonly PendingRow[], results: readonly PushResult[], at: string): Promise<void> {
  const byId = new Map(batch.map((p) => [p.mutationId, p]))
  const rows: FailedRow[] = []
  for (const r of results) {
    if (r.ok) continue
    const p = byId.get(r.id)
    rows.push({
      mutationId: r.id,
      name: p?.name ?? '',
      args: p?.args ?? null,
      error: r.error,
      message: r.message,
      details: r.details,
      at,
      source: 'server',
    })
  }
  if (rows.length) await db.failed.bulkPut(rows)
}

/** 送完所有待送的 mutation。任何傳輸錯誤直接丟出去。 */
export async function pushPending(env: PushEnv): Promise<void> {
  const { db, transport, cursor } = env
  const clientId = await db.getMeta<string>('clientId', '')
  for (;;) {
    const batch = await nextBatch(db, cursor)
    if (batch.length === 0) return
    const res = await transport.push({
      clientId,
      mutations: batch.map((p) => ({ id: p.mutationId, name: p.name, args: p.args, clientTs: p.clientTs })),
    })
    await recordResults(db, batch, res.results, taipeiIso(env.now()))
    cursor.sentUpTo = batch[batch.length - 1]!.mutationId
    env.onChanged?.()
  }
}
