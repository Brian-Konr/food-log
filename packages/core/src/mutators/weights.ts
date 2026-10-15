// weights.upsert / weights.delete / weights.restore。規則來自 legacy/gas/Code.gs 的 upsertWeight_、softDelete_、restore_。
import type { Ctx } from '../actor'
import { badRecord, forbidden, notFound } from '../errors'
import { KYU_MSG, canDeleteOrRestoreWeight } from '../permissions'
import type { IdArgs, WeightsUpsertArgs } from '../schema/args'
import type { WeightRow } from '../schema/rows'
import type { Tx } from '../tx'
import { checkDayTs, nowIso, stripKeys } from './common'
import type { DuplicateResult, IgnoredResult, RowResult } from './common'

/** 當天沒有紀錄：新增，overwritten=false、prevKg=null；當天已有：覆寫 kg 和 ts、保留原 id，回前一個 kg（undo 用）。 */
export type WeightsUpsertResult = (RowResult & { overwritten: boolean; prevKg: number | null }) | DuplicateResult

export async function runWeightsUpsert(tx: Tx, ctx: Ctx, a: WeightsUpsertArgs): Promise<WeightsUpsertResult> {
  const kg = a.kg
  if (typeof kg !== 'number' || !Number.isFinite(kg) || kg < 30 || kg > 250) throw badRecord('kg 必須在 30 到 250 之間')
  if (Math.round(kg * 10) / 10 !== kg) throw badRecord('kg 最多一位小數')
  if (!a.ts || !a.day || !a.id) throw badRecord('缺少 id、ts 或 day')
  checkDayTs(a.day, a.ts, ctx)
  const dup = await tx.get('weights', a.id)
  if (dup) return { duplicate: true }
  const live = await tx.liveWeightOnDay(a.day)
  const now = nowIso(ctx)
  if (live) {
    tx.put('weights', { ...stripKeys(live), kg, ts: a.ts, updated_at: now })
    return { rowId: live.id, overwritten: true, prevKg: live.kg }
  }
  const row: Omit<WeightRow, 'user_id' | 'version'> = { id: a.id, day: a.day, ts: a.ts, kg, deleted_at: null, updated_at: now }
  tx.put('weights', row)
  return { rowId: a.id, overwritten: false, prevKg: null }
}

export type WeightsDeleteResult = RowResult | IgnoredResult

export async function runWeightsDelete(tx: Tx, ctx: Ctx, a: IdArgs): Promise<WeightsDeleteResult> {
  if (!canDeleteOrRestoreWeight(ctx.actor)) throw forbidden(KYU_MSG)
  const row = await tx.get('weights', a.id)
  if (!row) throw notFound('找不到這筆紀錄：' + a.id)
  if (row.deleted_at !== null) return { ignored: 'deleted' }
  const now = nowIso(ctx)
  tx.put('weights', { ...stripKeys(row), deleted_at: now, updated_at: now })
  return { rowId: a.id }
}

export async function runWeightsRestore(tx: Tx, ctx: Ctx, a: IdArgs): Promise<WeightsDeleteResult> {
  if (!canDeleteOrRestoreWeight(ctx.actor)) throw forbidden(KYU_MSG)
  const row = await tx.get('weights', a.id)
  if (!row) throw notFound('找不到這筆紀錄：' + a.id)
  if (row.deleted_at === null) return { ignored: 'not_deleted' }
  const live = await tx.liveWeightOnDay(row.day)
  if (live && live.id !== a.id) throw badRecord('這天已經有一筆體重')
  tx.put('weights', { ...stripKeys(row), deleted_at: null, updated_at: nowIso(ctx) })
  return { rowId: a.id }
}
