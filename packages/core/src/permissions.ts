// 權限（純函式）。對照 PRD §3.1 的 Kyujin 權限矩陣與 legacy/gas/Code.gs 的 kyujin 旗標。
// 這裡只回答「可不可以」；錯誤碼、錯誤訊息與判斷順序由各個 mutator 決定（順序和 Code.gs 一致）。
// 表格式測試（test/permissions.matrix.test.ts）逐格覆蓋矩陣。
import type { Actor } from './actor'
import type { CreatedBy, LogSource } from './schema/enums'

/** Code.gs 的 KYU_MSG。 */
export const KYU_MSG = 'Kyujin 只能寫入自建品項或體重'

export const isBot = (actor: Actor): boolean => actor.kind === 'bot'

/** 讀取、summary、trends、history：兩種身分都可以。 */
export function canRead(_actor: Actor): boolean {
  return true
}

/** 官方品項（`fm:`、`711:`）不能被任何人改，也不進 D1。 */
export function isOfficialItemId(id: string): boolean {
  return id.startsWith('fm:') || id.startsWith('711:')
}

/** `ov:` 補填只有 owner 能寫。 */
export function canUpsertOverrideItem(actor: Actor): boolean {
  return !isBot(actor)
}

/**
 * `u:` 自建品項。owner 都可以；Kyujin：
 * - 店家品項（新的或原本就有店家）可以，連 App 建的也可以改；
 * - 沒有店家的品項只能寫自己建的（新建，或既有列的 created_by 是 kyujin）。
 */
export function canUpsertUserItem(actor: Actor, target: { isStoreItem: boolean; existingCreatedBy: CreatedBy | undefined }): boolean {
  if (!isBot(actor)) return true
  if (target.isStoreItem) return true
  return target.existingCreatedBy === undefined || target.existingCreatedBy === 'kyujin'
}

/** 新增 log：Kyujin 只能寫 source=kyujin；owner 不能寫 source=kyujin（後者是 bad_record，不是 forbidden）。 */
export function canAddLogWithSource(actor: Actor, source: string | null | undefined): boolean {
  return isBot(actor) ? source === 'kyujin' : true
}

/** 改、刪、復原既有 log：Kyujin 只限 source=kyujin 的列（列不存在也算不可以，Code.gs 先回 forbidden 再回 not_found）。 */
export function canWriteLogRow(actor: Actor, existing: { source: LogSource } | undefined): boolean {
  if (!isBot(actor)) return true
  return existing !== undefined && existing.source === 'kyujin'
}

/** 新增或改名店家：兩種身分都可以（新建時 created_by 依 actor；改名保留原本的）。 */
export function canUpsertStore(_actor: Actor): boolean {
  return true
}

/** 刪除或復原店家（含連帶品項）：只有 owner。 */
export function canDeleteOrRestoreStore(actor: Actor): boolean {
  return !isBot(actor)
}

/** 刪除或復原品項：只有 owner。 */
export function canDeleteOrRestoreItem(actor: Actor): boolean {
  return !isBot(actor)
}

/** 體重 upsert：兩種身分都可以。 */
export function canUpsertWeight(_actor: Actor): boolean {
  return true
}

/** 體重刪除或復原：只有 owner。 */
export function canDeleteOrRestoreWeight(actor: Actor): boolean {
  return !isBot(actor)
}

/** 設定：只有 owner。 */
export function canSetConfig(actor: Actor): boolean {
  return !isBot(actor)
}

/** 收藏：只有 owner。 */
export function canSetFavorite(actor: Actor): boolean {
  return !isBot(actor)
}
