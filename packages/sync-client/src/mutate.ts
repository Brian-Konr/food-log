// mutate(name, args)（計畫 §3.5）：本機優先。
//
// 一個 Dexie rw 交易：LocalTx 跑 mutator →（成功）寫畫面表 + 配 mutationId + 寫進 pending。
//   - MutationError：交易中止，什麼都沒寫（連 mutationId 都不配），原樣丟出給 UI（取代 v1 的 App.findDup）。
//   - 成功：回傳 mutator 的結果；之後排程 push（`onQueued`）。沒有寫入的 mutation（ignored、duplicate…）也照樣進佇列：
//     本機看到「不存在」不代表伺服器也是，伺服器要自己再判斷一次，cursor 也要前進。
//   - 試用模式（trial）：同時寫畫面表和 srv 表，不配 mutationId、不進 pending、永遠不 push。
import type { MutationArgs, MutationName, MutationResult } from '@food-log/core'
import type { FoodLogDb, Mode, PendingRow } from './db'
import { runLocal } from './local-tx'

export interface MutateEnv {
  db: FoodLogDb
  mode: Mode
  now: () => number
  /** 本機寫入完成後呼叫（排程 push）。不等它。 */
  onQueued?: (() => void) | undefined
}

/** 參數先過一次 JSON：本機 mutator、pending 裡存的、送給伺服器的是同一份（undefined 欄位消失、Date 變字串）。 */
function jsonClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

export async function mutateUntyped(env: MutateEnv, name: string, rawArgs: unknown): Promise<unknown> {
  const { db } = env
  const args = jsonClone(rawArgs)
  const clientTs = env.now()
  const trial = env.mode === 'trial'
  const queued = await db.transaction('rw', db.allTables, async () => {
    const userId = await db.getMeta<string>('userId', 'local')
    const { result, tx } = await runLocal(db, userId, name, args, clientTs)
    const touched = tx.touchedKeys()
    await tx.flush({ alsoSrv: trial })
    if (trial) return { result, queued: false }
    const mutationId = await db.getMeta<number>('nextMutationId', 1)
    await db.setMeta('nextMutationId', mutationId + 1)
    const row: PendingRow = { mutationId, name, args, clientTs, touched }
    await db.pending.add(row)
    return { result, queued: true }
  })
  if (queued.queued) env.onQueued?.()
  return queued.result
}

export function mutate<N extends MutationName>(env: MutateEnv, name: N, args: MutationArgs<N>): Promise<MutationResult<N>> {
  return mutateUntyped(env, name, args) as Promise<MutationResult<N>>
}
