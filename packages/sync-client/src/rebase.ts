// Rebase（計畫 §3.5）：把一頁 pull 的結果套進本機，一個 Dexie 交易做完。
//
//   0. 多頁 pull（more=true 的中間頁）：只把列放進 srv_*（reset：第一頁先清空 srv_*）、存 cookie，**畫面表完全不動**，
//      也不重播 pending；收到的鍵（reset 時再加上清掉之前 srv／畫面表的所有鍵）累積在 meta.pullRun.dirty（持久化：
//      中途斷線、App 重啟後下一次 pull 從 cookie 接著拉，最後一頁仍然知道前面頁收到哪些鍵）。
//      這樣 reset 的過程中畫面不會變空、也不會因為「重播時列還沒到」而誤記本機失敗；每次 pull 只重播一次。
//      （pullRun 存在 = 畫面表和 srv_* 暫時不一致，checkViewInvariant 在這段期間不檢查。）
//   1. 收到的變更放進 srv_*。
//   2. 最後一頁（more=false）才處理確認：pending 裡 mutationId <= lastMutationId 的丟掉，
//      有錯誤的（resp.errors）移到 failed。（更早的頁不處理：cursor 只有在列都到齊之後才可信，見 core/server/pull.ts。）
//   3. 髒鍵 = 這一輪 pull 收到的變更的鍵（所有頁）∪ 「所有 pending 的 touched」，**包含這一輪剛被確認或丟掉的**。
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

/** 多頁 pull 進行中的狀態（meta.pullRun）。 */
export interface PullRun {
  /** 這一輪 pull 是否有 reset（任何一頁 reset=true）。 */
  reset: boolean
  /** 這一輪已經收到的鍵（`<table>:<key>`），reset 時還包含清掉之前的 srv／畫面表的所有鍵。 */
  dirty: string[]
}

export const getPullRun = (db: FoodLogDb): Promise<PullRun | null> => db.getMeta<PullRun | null>('pullRun', null)

/** 髒鍵的畫面列退回 srv，再依序重播 pending。 */
async function rebuildView(db: FoodLogDb, userId: string, dirty: ReadonlySet<string>, pending: readonly PendingRow[], now: number): Promise<void> {
  await resetKeysFromSrv(db, dirty)
  await replayPending(db, userId, pending, now)
}

/** 目前 srv 與畫面表裡所有列的鍵（reset 時，這些鍵最後都要依新的 srv 重建）。 */
async function allKeys(db: FoodLogDb, into: Set<string>): Promise<void> {
  for (const t of TABLES) {
    for (const k of await db.srv(t).toCollection().primaryKeys()) into.add(touchKey(t, k))
    for (const k of await db.view(t).toCollection().primaryKeys()) into.add(touchKey(t, k))
  }
}

/** 套用一頁 pull。在一個 rw 交易裡。 */
export async function applyPullPage(db: FoodLogDb, resp: PullResponse, now: number): Promise<void> {
  await db.transaction('rw', db.allTables, async () => {
    const userId = await db.getMeta<string>('userId', 'local')
    const run = await getPullRun(db)
    const dirty = new Set<string>(run?.dirty ?? [])
    const reset = (run?.reset ?? false) || resp.reset

    if (resp.reset) {
      // 只清 srv；畫面表留著（UI 繼續顯示舊資料），最後一頁才依新的 srv 重建。
      await allKeys(db, dirty)
      for (const t of TABLES) await db.srv(t).clear()
    }

    for (const t of TABLES) {
      const rows = resp.changes[t] as never[]
      if (rows.length === 0) continue
      await putRows(db.srv(t) as never, t, rows)
      for (const r of rows) dirty.add(touchKey(t, keyOfRow(t, r)))
    }

    if (resp.more) {
      // 中間頁：不碰畫面表、pending、lastMutationId。cookie 每頁都存（斷線後從這裡繼續）。
      await db.setMeta('pullRun', { reset, dirty: [...dirty] } satisfies PullRun)
      await db.setMeta('cookie', resp.cookie)
      return
    }

    const allPending = await db.pending.orderBy('mutationId').toArray()
    // 所有 pending 的 touched 都是髒鍵（含這輪要丟掉的）。
    for (const p of allPending) for (const k of p.touched) dirty.add(k)

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
    const remaining = allPending.filter((p) => p.mutationId > resp.lastMutationId)
    const prevLast = await db.getMeta<number>('lastMutationId', 0)
    await db.setMeta('lastMutationId', reset ? resp.lastMutationId : Math.max(prevLast, resp.lastMutationId))
    await db.setMeta('lastPullAt', now)

    // 整輪只重建／重播一次。
    await rebuildView(db, userId, dirty, remaining, now)
    await db.meta.delete('pullRun')
    await db.setMeta('cookie', resp.cookie)
  })
}

/**
 * push 判定「毒藥」mutation（伺服器永遠回 4xx，永遠不會成功）：從 pending 移除、記進 failed（source=server），
 * 然後重建畫面（它寫過的鍵退回 srv，其餘 pending 重播）。failed 的列由呼叫端組好。
 * 若多頁 pull 進行中（srv 暫時不完整），不能現在重建：把它的鍵併進 pullRun.dirty，最後一頁一起處理。
 */
export async function dropPoisonedPending(db: FoodLogDb, failedRows: readonly FailedRow[], now: number): Promise<void> {
  if (failedRows.length === 0) return
  await db.transaction('rw', db.allTables, async () => {
    const ids = new Set(failedRows.map((f) => f.mutationId))
    const all = await db.pending.orderBy('mutationId').toArray()
    const dropped = all.filter((p) => ids.has(p.mutationId))
    const remaining = all.filter((p) => !ids.has(p.mutationId))
    await db.pending.bulkDelete([...ids])
    await db.failed.bulkPut([...failedRows])
    const dirty = new Set<string>()
    for (const p of dropped) for (const k of p.touched) dirty.add(k)
    const run = await getPullRun(db)
    if (run) {
      for (const k of dirty) if (!run.dirty.includes(k)) run.dirty.push(k)
      await db.setMeta('pullRun', run)
      return
    }
    for (const p of remaining) for (const k of p.touched) dirty.add(k)
    const userId = await db.getMeta<string>('userId', 'local')
    await rebuildView(db, userId, dirty, remaining, now)
  })
}
