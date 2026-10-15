// favorites.set：取代 v1 的 Config.fav_ids 與 items.fav。只有 owner。
// 官方品項（fm:／711:）不在 D1，所以不檢查品項是否存在。
import type { Ctx } from '../actor'
import { badRecord, forbidden } from '../errors'
import { KYU_MSG, canSetFavorite } from '../permissions'
import type { FavoritesSetArgs } from '../schema/args'
import type { Tx } from '../tx'
import { nowIso, stripKeys } from './common'
import type { RowResult } from './common'

export type FavoritesSetResult = RowResult

export async function runFavoritesSet(tx: Tx, ctx: Ctx, a: FavoritesSetArgs): Promise<FavoritesSetResult> {
  if (!canSetFavorite(ctx.actor)) throw forbidden(KYU_MSG)
  if (!a.item_id) throw badRecord('缺少 item_id')
  const existing = await tx.get('favorites', a.item_id)
  const isFav = !!existing && existing.deleted_at === null
  if (a.fav === isFav) return { rowId: a.item_id } // 已經是這個狀態：不寫入，版本號不變
  const now = nowIso(ctx)
  tx.put('favorites', {
    ...(existing ? stripKeys(existing) : { item_id: a.item_id }),
    deleted_at: a.fav ? null : now,
    updated_at: now,
  })
  return { rowId: a.item_id }
}
