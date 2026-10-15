// Rebase（計畫 §3.5）：把一頁 pull 的結果套進本機，一個 Dexie 交易做完。
//
//   1. 收到的變更放進 srv_*（reset：先清空 srv_* 和畫面表）。
//   2. 最後一頁（more=false）才處理確認：pending 裡 mutationId <= lastMutationId 的丟掉，
//      有錯誤的（resp.errors）移到 failed。（更早的頁不處理：cursor 只有在列都到齊之後才可信，見 core/server/pull.ts。）
//   3. 髒鍵 = 收到的變更的鍵 ∪ 「所有 pending 的 touched」，**包含這一輪剛被確認或丟掉的**。
//      （spike 發現的 bug：剛確認／失敗的 mutation 不在 pending 裡了，但畫面上它寫的列要退回伺服器的答案，
//       所以它的 touched 一定要算進髒鍵。）
//   4. 每個髒鍵：畫面表 = srv 表（srv 沒有就刪掉）。
//   5. 依序重播剩下的 pending。重播丟 MutationError → 本機記一筆 failed(source=local)，但 pending 留在佇列
//      （伺服器可能依不同的順序得到不同的結果，等它回答）；重播成功就清掉本機記的 failed。
//      重播寫到的鍵併進 pending.touched（聯集），下一輪才知道要重設它們。
//
// 不變式：畫面表 == fullRebuild(srv, pending)（testing/full-rebuild.ts；property test 每一步驗證）。
// 證明概要：不在髒鍵裡的鍵，沒有任何 pending 寫過，所以畫面 == srv；髒鍵先退回 srv 再依序重播，
// 重播讀到的就是「srv + 之前的 pending 的結果」，和從頭重建一樣。
import { isMutationError, taipeiIso } from '@food-log/core'
import type { PullResponse, Table } from '@food-log/core'
import { TABLES } from '@food-log/core'
import { CONFIG_KEY, deleteRows, getRows, keyOfRow, parseTouchKey, putRows, touchKey } from './db'
import type { FailedRow, FoodLogDb, PendingRow } from './db'
import { runLocal } from './local-tx'

/** 把髒鍵的畫面列退回 srv 的內容。 */
async function resetKeysFromSrv(db: FoodLogDb, dirty: ReadonlySet<string>): Promise<void> {
  const byTable = new Map<Table, string[]>()
  for (const k of dirty) {
    const { table, key } = parseTouchKey(k)
    const list = byTable.get(table)
    if (list) list.push(key)
    else byTable.set(table, [key])
  }
  for (const [table, keys] of byTable) {
    const srvRows = await getRows(db.srv(table) as never, table, keys)
    const put: never[] = []
    const del: string[] = []
    keys.forEach((key, i) => {
      const r = srvRows[i]
      if (r) put.push(r as never)
      else del.push(key)
    })
    if (table === 'config') {
      // config 的鍵固定是 'config'
      if (del.length) await db.view('config').delete(CONFIG_KEY)
    } else {
      await deleteRows(db.view(table) as never, del)
    }
    await putRows(db.view(table) as never, table, put)
  }
}

/** 依序重播 pending（在交易裡）。回傳不需要，副作用：畫面表、pending.touched、本機 failed。 */
export async function replayPending(db: FoodLogDb, userId: string, pending: readonly PendingRow[], now: number): Promise<void> {
  for (const p of pending) {
    try {
      const { tx } = await runLocal(db, userId, p.name, p.args, p.clientTs)
      const touched = tx.touchedKeys()
      await tx.flush()
      const merged = [...new Set([...p.touched, ...touched])]
      if (merged.length !== p.touched.length) await db.pending.update(p.mutationId, { touched: merged })
      const f = await db.failed.get(p.mutationId)
      if (f && f.source === 'local') await db.failed.delete(p.mutationId)
    } catch (e) {
      if (!isMutationError(e)) throw e
      const row: FailedRow = {
        mutationId: p.mutationId,
        name: p.name,
        args: p.args,
        error: e.code,
        message: e.message,
        details: e.details,
        at: taipeiIso(now),
        source: 'local',
      }
      const existing = await db.failed.get(p.mutationId)
      // 伺服器已經回過這筆的錯誤（push 結果）就不要被本機的覆蓋。
      if (!existing || existing.source === 'local') await db.failed.put(row)
    }
  }
}

/** 套用一頁 pull。在一個 rw 交易裡。 */
export async function applyPullPage(db: FoodLogDb, resp: PullResponse, now: number): Promise<void> {
  await db.transaction('rw', db.allTables, async () => {
    const userId = await db.getMeta<string>('userId', 'local')
    const dirty = new Set<string>()

    if (resp.reset) {
      for (const t of TABLES) {
        await db.srv(t).clear()
        await db.view(t).clear()
      }
    }

    for (const t of TABLES) {
      const rows = resp.changes[t] as never[]
      if (rows.length === 0) continue
      await putRows(db.srv(t) as never, t, rows)
      for (const r of rows) dirty.add(touchKey(t, keyOfRow(t, r)))
    }

    const allPending = await db.pending.orderBy('mutationId').toArray()
    // 所有 pending 的 touched 都是髒鍵（含這輪要丟掉的）。
    for (const p of allPending) for (const k of p.touched) dirty.add(k)

    let remaining = allPending
    if (!resp.more) {
      const confirmed = allPending.filter((p) => p.mutationId <= resp.lastMutationId)
      const confirmedById = new Map(confirmed.map((p) => [p.mutationId, p]))
      const errorIds = new Set<number>()
      for (const e of resp.errors) {
        errorIds.add(e.mutationId)
        const prev = await db.failed.get(e.mutationId)
        const failed: FailedRow = {
          mutationId: e.mutationId,
          name: e.name,
          args: confirmedById.get(e.mutationId)?.args ?? prev?.args ?? null,
          error: e.error,
          message: e.message,
          details: e.details,
          at: e.at,
          source: 'server',
        }
        await db.failed.put(failed)
      }
      for (const p of confirmed) {
        if (errorIds.has(p.mutationId)) continue
        // 伺服器接受了：本機重播時記的失敗不成立。
        const f = await db.failed.get(p.mutationId)
        if (f && f.source === 'local') await db.failed.delete(p.mutationId)
      }
      await db.pending.bulkDelete(confirmed.map((p) => p.mutationId))
      remaining = allPending.filter((p) => p.mutationId > resp.lastMutationId)
      const prevLast = await db.getMeta<number>('lastMutationId', 0)
      await db.setMeta('lastMutationId', resp.reset ? resp.lastMutationId : Math.max(prevLast, resp.lastMutationId))
      await db.setMeta('lastPullAt', now)
    }

    await resetKeysFromSrv(db, dirty)
    // 重播要用最新的 touched（上面沒改過 remaining 的內容，touched 還是讀出來的那份）。
    await replayPending(db, userId, remaining, now)
    await db.setMeta('cookie', resp.cookie)
  })
}
