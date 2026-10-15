// items.upsert / items.delete / items.restore。規則來自 legacy/gas/Code.gs 的 upsertItem_、softDelete_、restore_。
import { createdByOf } from '../actor'
import type { Ctx } from '../actor'
import { badRecord, forbidden, notFound } from '../errors'
import {
  KYU_MSG,
  canDeleteOrRestoreItem,
  canUpsertOverrideItem,
  canUpsertUserItem,
  isBot,
  isOfficialItemId,
} from '../permissions'
import type { IdArgs, ItemsUpsertArgs } from '../schema/args'
import type { ItemRow } from '../schema/rows'
import type { Tx } from '../tx'
import { NUT_MSG, nowIso, nutritionOk, optionalPositive, runPlan, stripKeys, write } from './common'
import type { IgnoredResult, Plan, RowResult } from './common'

export type ItemsUpsertResult = RowResult | IgnoredResult

export async function planUpsertItem(tx: Tx, ctx: Ctx, a: ItemsUpsertArgs): Promise<Plan<ItemsUpsertResult>> {
  // 讀：店家、既有品項。全部在第一個 put 之前。
  const id = a.id
  if (!id) throw badRecord('缺少 id')
  const storeId = a.store_id ?? ''
  if (isOfficialItemId(id)) throw forbidden('不能改官方品項')
  if (id.startsWith('ov:')) {
    if (!canUpsertOverrideItem(ctx.actor)) throw forbidden(KYU_MSG)
    if (a.kind !== '補填') throw badRecord('補填的 kind 必須是補填')
    if (a.base_id !== id.slice(3)) throw badRecord('base_id 必須等於官方 id')
    // created_by 由 actor 決定：只有 owner 能寫 ov:，所以一定是 app（Code.gs 要求 created_by === 'app'）。
  } else if (id.startsWith('u:')) {
    if (a.kind !== '自建') throw badRecord('自建的 kind 必須是自建')
    if (a.base_id) throw badRecord('自建的 base_id 必須空白')
    if (storeId) {
      if (a.src !== '其他') throw badRecord('src 只能是 7-11、全家或其他')
      const store = await tx.get('stores', storeId)
      if (!store || store.deleted_at !== null) throw badRecord('找不到這家店')
    }
    // Code.gs 這裡有「Kyujin 沒有店家的品項，created_by 必須是 kyujin」；v2 的 created_by 依 actor，天生成立。
  } else {
    throw badRecord('id 格式不對')
  }
  if (typeof a.name !== 'string' || !a.name) throw badRecord('name 不能空白')
  if (typeof a.serving !== 'string' || !a.serving) throw badRecord('serving 不能空白')
  if (!optionalPositive(a.serving_g)) throw badRecord('serving_g 格式不對')
  if (!nutritionOk(a)) throw badRecord(NUT_MSG)
  const existing = await tx.get('items', id)
  if (existing && existing.deleted_at !== null) return { result: { ignored: 'deleted' }, writes: [] }
  const existStore = existing?.store_id ?? ''
  const isStoreItem = !!(storeId || existStore)
  if (isBot(ctx.actor)) {
    if (!id.startsWith('u:')) throw forbidden(KYU_MSG)
    if (!canUpsertUserItem(ctx.actor, { isStoreItem, existingCreatedBy: existing?.created_by })) throw forbidden(KYU_MSG)
  }
  const now = nowIso(ctx)
  const row: Omit<ItemRow, 'user_id' | 'version'> = {
    id,
    kind: a.kind,
    base_id: a.base_id ? a.base_id : null,
    src: a.src,
    name: a.name,
    serving: a.serving,
    serving_g: a.serving_g ?? null,
    kcal: a.kcal,
    protein: a.protein,
    fat: a.fat,
    carb: a.carb,
    store_id: storeId || existStore || null,
    // created_by 建立後不變（既有列保留原值）。
    created_by: existing ? existing.created_by : createdByOf(ctx.actor),
    ts: a.ts || existing?.ts || now,
    cascade_of: null,
    deleted_at: null,
    updated_at: now,
  }
  return { result: { rowId: id }, writes: [write('items', row)] }
}

export async function runItemsUpsert(tx: Tx, ctx: Ctx, a: ItemsUpsertArgs): Promise<ItemsUpsertResult> {
  return runPlan(tx, await planUpsertItem(tx, ctx, a))
}

export type ItemsDeleteResult = RowResult | IgnoredResult

export async function runItemsDelete(tx: Tx, ctx: Ctx, a: IdArgs): Promise<ItemsDeleteResult> {
  if (!canDeleteOrRestoreItem(ctx.actor)) throw forbidden(KYU_MSG)
  const row = await tx.get('items', a.id)
  if (!row) return { ignored: 'missing' } // v1.1.4：不存在也回成功，不寫入
  if (row.deleted_at !== null) return { ignored: 'deleted' }
  const now = nowIso(ctx)
  // 直接刪除的品項不屬於任何「連帶刪除」，cascade_of 維持 null。
  tx.put('items', { ...stripKeys(row), deleted_at: now, cascade_of: null, updated_at: now })
  return { rowId: a.id }
}

export async function runItemsRestore(tx: Tx, ctx: Ctx, a: IdArgs): Promise<ItemsDeleteResult> {
  if (!canDeleteOrRestoreItem(ctx.actor)) throw forbidden(KYU_MSG)
  const row = await tx.get('items', a.id)
  if (!row) throw notFound('找不到這筆紀錄：' + a.id)
  if (row.deleted_at === null) return { ignored: 'not_deleted' }
  // 有意與 Code.gs 不同：店家品項不能在店已刪除（或不存在）時單獨復活，否則會出現「未刪除的品項在已刪除的店」。
  // 要先復原店家（stores.restore 會連帶還原 cascade_of = storeId 的品項）。讀都在 put 之前。
  if (row.store_id) {
    const store = await tx.get('stores', row.store_id)
    if (!store || store.deleted_at !== null) throw badRecord('這家店已經刪除')
  }
  tx.put('items', { ...stripKeys(row), deleted_at: null, cascade_of: null, updated_at: nowIso(ctx) })
  return { rowId: a.id }
}
