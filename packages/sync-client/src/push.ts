// push：把 pending 依序、每批最多 MAX_PUSH_MUTATIONS 筆送出（計畫 §3.4）。
//   - ok：什麼都不動。pending 留著，等下一次 pull 確認（lastMutationId 涵蓋它）才丟掉，畫面不會閃一下。
//   - 錯誤（業務錯誤）：先記進 failed（source=server），pending 一樣留到 pull 確認。
//   - 4xx（非 401、409、408、429）= 請求本身有問題（壞請求）：整批可能只有一筆有毒。二分：一筆一筆重送，還是 4xx 的那筆
//     （永遠不會成功）移到 failed（source=server、error=bad_request、訊息用伺服器回的）並從 pending 移除，畫面重建；其餘繼續。
//   - 回應掉了或請求失敗：丟錯給 loop（NetworkError…），pending 不動；下次重送，伺服器依 mutationId 去重（只生效一次）。
// sentUpTo 只在記憶體：同一個 session 內不重複送已經有答案的；重啟後從 meta.lastMutationId 之後全部再送一次（伺服器去重）。
import { MAX_PUSH_MUTATIONS, taipeiIso } from '@food-log/core'
import type { PushResponse, PushResult } from '@food-log/core'
import type { FailedRow, FoodLogDb, PendingRow } from './db'
import { dropPoisonedPending } from './rebase'
import { HttpError } from './transport'
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

/** 「請求本身有問題」的 4xx：永遠不會成功的毒藥候選。401（登入）、409（版本）另有處理；408、429 是暫時性的，不算。 */
function isBadRequest(e: unknown): e is HttpError {
  return e instanceof HttpError && e.status >= 400 && e.status < 500 && ![401, 408, 409, 429].includes(e.status)
}

const toRequest = (clientId: string, batch: readonly PendingRow[]) => ({
  clientId,
  mutations: batch.map((p) => ({ id: p.mutationId, name: p.name, args: p.args, clientTs: p.clientTs })),
})

function badRequestRow(p: PendingRow, e: HttpError, at: string): FailedRow {
  return {
    mutationId: p.mutationId,
    name: p.name,
    args: p.args,
    error: 'bad_request',
    message: e.serverMessage ?? e.message,
    details: { status: e.status },
    at,
    source: 'server',
  }
}

/** 整批被 4xx 拒絕：一筆一筆重送。還是 4xx 的丟掉（記 failed），其他錯誤（網路、5xx、401…）照常丟出，已處理的不再重送。 */
async function bisect(env: PushEnv, clientId: string, batch: readonly PendingRow[], batchError: HttpError): Promise<void> {
  const { db, transport, cursor } = env
  for (const p of batch) {
    let error: HttpError | null = null
    if (batch.length === 1) {
      error = batchError // 已經是單筆：不用再送
    } else {
      try {
        const res = await transport.push(toRequest(clientId, [p]))
        await recordResults(db, [p], res.results, taipeiIso(env.now()))
      } catch (e) {
        if (!isBadRequest(e)) throw e
        error = e
      }
    }
    if (error) await dropPoisonedPending(db, [badRequestRow(p, error, taipeiIso(env.now()))], env.now())
    cursor.sentUpTo = p.mutationId
    env.onChanged?.()
  }
}

/** 送完所有待送的 mutation。任何傳輸錯誤直接丟出去（毒藥 4xx 除外，見 bisect）。 */
export async function pushPending(env: PushEnv): Promise<void> {
  const { db, transport, cursor } = env
  const clientId = await db.getMeta<string>('clientId', '')
  for (;;) {
    const batch = await nextBatch(db, cursor)
    if (batch.length === 0) return
    let res: PushResponse
    try {
      res = await transport.push(toRequest(clientId, batch))
    } catch (e) {
      if (!isBadRequest(e)) throw e
      await bisect(env, clientId, batch, e)
      continue
    }
    await recordResults(db, batch, res.results, taipeiIso(env.now()))
    cursor.sentUpTo = batch[batch.length - 1]!.mutationId
    env.onChanged?.()
  }
}
