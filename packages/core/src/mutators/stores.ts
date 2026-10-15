// stores.upsert / stores.delete / stores.restore。規則來自 legacy/gas/Code.gs 的 upsertStore_、softDelete_、restore_。
// 連帶刪除改用 items.cascade_of = storeId 標記，取代 v1 比對相同 updated_at 的做法。
import { createdByOf } from '../actor'
import type { Ctx } from '../actor'
import { badRecord, duplicateName, forbidden, notFound } from '../errors'
import { normName } from '../norm'
import { KYU_MSG, canDeleteOrRestoreStore } from '../permissions'
import type { IdArgs, StoresUpsertArgs } from '../schema/args'
import type { StoreRow } from '../schema/rows'
import type { Tx } from '../tx'
import { nowIso, runPlan, stripKeys, write } from './common'
import type { IgnoredResult, Plan, RowResult, Write } from './common'

export type StoresUpsertResult = RowResult | IgnoredResult

export async function runStoresUpsert(tx: Tx, ctx: Ctx, a: StoresUpsertArgs): Promise<StoresUpsertResult> {
  if (!a.id) throw badRecord('缺少 id')
  const id = a.id
  if (!id.startsWith('s:')) throw badRecord('id 格式不對')
  const existing = await tx.get('stores', id)
  if (existing && existing.deleted_at !== null) return { ignored: 'deleted' }
  const name = String(a.name ?? '').trim()
  if (!name) throw badRecord('店名不能空白')
  const norm = normName(name)
  const dup = await tx.liveStoreByNorm(norm, id)
  if (dup) throw duplicateName('已經有「' + dup.name + '」', { existingId: dup.id, existingName: dup.name })
  const now = nowIso(ctx)
  const row: Omit<StoreRow, 'user_id' | 'version'> = {
    id,
    name,
    name_norm: norm,
    // last_eaten_at 不是參數，只由 logs.add 往後更新。
    last_eaten_at: existing?.last_eaten_at ?? null,
    // created_by 新建時依 actor；改名保留原本的。
    created_by: existing ? existing.created_by : createdByOf(ctx.actor),
    ts: a.ts || existing?.ts || now,
    deleted_at: null,
    updated_at: now,
  }
  return runPlan(tx, { result: { rowId: id }, writes: [write('stores', row)] } satisfies Plan<StoresUpsertResult>)
}

export type StoresDeleteResult = RowResult | IgnoredResult

export async function runStoresDelete(tx: Tx, ctx: Ctx, a: IdArgs): Promise<StoresDeleteResult> {
  if (!canDeleteOrRestoreStore(ctx.actor)) throw forbidden(KYU_MSG)
  const row = await tx.get('stores', a.id)
  if (!row) return { ignored: 'missing' } // v1.1.4：不存在也回成功，不寫入
  if (row.deleted_at !== null) return { ignored: 'deleted' }
  const items = await tx.itemsOfStore(a.id)
  const now = nowIso(ctx)
  const writes: Write[] = [write('stores', { ...stripKeys(row), deleted_at: now, updated_at: now })]
  for (const it of items) {
    if (it.deleted_at !== null) continue // 早就刪掉的品項不動，也不標記 cascade_of
    writes.push(write('items', { ...stripKeys(it), deleted_at: now, cascade_of: a.id, updated_at: now }))
  }
  return runPlan(tx, { result: { rowId: a.id }, writes })
}

export async function runStoresRestore(tx: Tx, ctx: Ctx, a: IdArgs): Promise<StoresDeleteResult> {
  if (!canDeleteOrRestoreStore(ctx.actor)) throw forbidden(KYU_MSG)
  const row = await tx.get('stores', a.id)
  if (!row) throw notFound('找不到這筆紀錄：' + a.id)
  if (row.deleted_at === null) return { ignored: 'not_deleted' }
  // Code.gs 沒檢查；但 D1 有「未刪除店名唯一」的部分唯一索引，復原後撞名會寫不進去，所以這裡擋下並回 duplicate_name。
  const dup = await tx.liveStoreByNorm(row.name_norm, a.id)
  if (dup) throw duplicateName('已經有「' + dup.name + '」', { existingId: dup.id, existingName: dup.name })
  const items = await tx.itemsOfStore(a.id)
  const now = nowIso(ctx)
  const writes: Write[] = [write('stores', { ...stripKeys(row), deleted_at: null, updated_at: now })]
  for (const it of items) {
    // 只還原「因為這家店被刪而連帶刪除」的品項；之前就被刪除的不動。
    if (it.deleted_at === null || it.cascade_of !== a.id) continue
    writes.push(write('items', { ...stripKeys(it), deleted_at: null, cascade_of: null, updated_at: now }))
  }
  return runPlan(tx, { result: { rowId: a.id }, writes })
}
