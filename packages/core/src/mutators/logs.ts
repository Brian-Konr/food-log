// logs.add / logs.update / logs.delete / logs.restore。規則來自 legacy/gas/Code.gs 的 appendLog_、updateLog_、softDelete_、restore_、
// resolveLogSource_、bumpLastEaten_。檢查順序（含 Kyujin 的 forbidden 先於 not_found）和 Code.gs 一致。
import type { Actor, Ctx } from '../actor'
import { badRecord, forbidden, notFound } from '../errors'
import { KYU_MSG, canAddLogWithSource, canWriteLogRow, isBot } from '../permissions'
import type { IdArgs, LogInput, LogsAddArgs, LogsUpdateArgs } from '../schema/args'
import type { LogSource } from '../schema/enums'
import type { LogRow } from '../schema/rows'
import type { Tx } from '../tx'
import { NUT_MSG, checkDayTs, nowIso, nutritionOk, optionalPositive, runPlan, stripKeys, write } from './common'
import type { DuplicateResult, IgnoredResult, RowResult, Write } from './common'
import { planUpsertItem } from './items'

/** Code.gs 的 logSourceOf_：不認得的值當 app。 */
function logSourceOf(v: unknown): LogSource {
  return v === 'quick' || v === 'kyujin' ? v : 'app'
}

/** Code.gs 的 resolveLogSource_。 */
function resolveLogSource(actor: Actor, source: string | null | undefined): LogSource {
  if (isBot(actor)) {
    if (!canAddLogWithSource(actor, source)) throw forbidden(KYU_MSG)
    return 'kyujin'
  }
  if (source === 'kyujin') throw badRecord('不能寫 kyujin 的 source')
  if (!source) return 'app'
  if (source !== 'app' && source !== 'quick') throw badRecord('source 只能是 app、quick 或 kyujin')
  return source
}

export type LogsAddResult = RowResult | DuplicateResult

async function planAddLog(tx: Tx, ctx: Ctx, a: LogInput): Promise<{ result: LogsAddResult; writes: Write[] }> {
  if (!a.id || !a.ts || !a.day || !a.src || a.qty == null) throw badRecord('缺少必填欄位')
  const source = resolveLogSource(ctx.actor, a.source)
  const itemId = a.item_id ?? ''
  const name = String(a.name ?? '').trim()
  const storeId = a.store_id ?? ''
  if (itemId === '') {
    // 沒有品項：快速記錄，或 Kyujin 的估算（qty=1、沒有 grams、src=其他、沒有店家）。
    if (!nutritionOk(a)) throw badRecord(NUT_MSG)
    if (a.qty !== 1) throw badRecord('qty 必須是大於 0 的數字')
    if (a.grams != null) throw badRecord('grams 格式不對')
    if (a.src !== '其他') throw badRecord('src 只能是 7-11、全家或其他')
    if (storeId) throw badRecord('找不到這家店')
  } else {
    if (!name) throw badRecord('缺少必填欄位')
    if (!nutritionOk(a)) throw badRecord(NUT_MSG)
    if (typeof a.qty !== 'number' || !Number.isFinite(a.qty) || a.qty <= 0) throw badRecord('qty 必須是大於 0 的數字')
    if (!optionalPositive(a.grams)) throw badRecord('grams 格式不對')
  }
  checkDayTs(a.day, a.ts, ctx)
  const store = storeId ? await tx.get('stores', storeId) : undefined
  if (storeId && !store) throw badRecord('找不到這家店')
  const existing = await tx.get('logs', a.id)
  if (existing) return { result: { duplicate: true }, writes: [] }
  const now = nowIso(ctx)
  const row: Omit<LogRow, 'user_id' | 'version'> = {
    id: a.id,
    day: a.day,
    ts: a.ts,
    item_id: itemId || null,
    name,
    src: a.src,
    qty: a.qty,
    grams: a.grams ?? null,
    kcal: a.kcal,
    protein: a.protein,
    fat: a.fat,
    carb: a.carb,
    source,
    store_id: storeId || null,
    deleted_at: null,
    updated_at: now,
  }
  const writes: Write[] = [write('logs', row)]
  // last_eaten_at 只往後更新（往回補記不把時間撥回）。
  if (store && (!store.last_eaten_at || store.last_eaten_at < a.ts)) {
    writes.push(write('stores', { ...stripKeys(store), last_eaten_at: a.ts, updated_at: now }))
  }
  return { result: { rowId: a.id }, writes }
}

export async function runLogsAdd(tx: Tx, ctx: Ctx, args: LogsAddArgs): Promise<LogsAddResult> {
  const { log, item } = args
  const writes: Write[] = []
  if (item) {
    // 補填的 id 是 ov:<官方 id>，log.item_id 是官方 id；自建的兩者相同。
    const itemId = log.item_id ?? ''
    if (!itemId || (item.id !== itemId && item.id !== 'ov:' + itemId)) throw badRecord('item 必須是這筆紀錄的品項')
    // 品項先規劃（先寫），取代 v1 的 groupId。品項已被刪除（ignored）不擋記錄。
    writes.push(...(await planUpsertItem(tx, ctx, item)).writes)
  }
  const logPlan = await planAddLog(tx, ctx, log)
  if ('duplicate' in logPlan.result) return logPlan.result // 重送：什麼都不寫
  writes.push(...logPlan.writes)
  return runPlan(tx, { result: logPlan.result, writes })
}

export type LogsUpdateResult = RowResult | IgnoredResult

export async function runLogsUpdate(tx: Tx, ctx: Ctx, a: LogsUpdateArgs): Promise<LogsUpdateResult> {
  const existing = await tx.get('logs', a.id)
  if (!canWriteLogRow(ctx.actor, existing)) throw forbidden(KYU_MSG)
  if (!existing) throw notFound('找不到這筆紀錄：' + a.id)
  if (existing.deleted_at !== null) return { ignored: 'deleted' }
  const patch = a.patch ?? {}
  if (patch.source != null && logSourceOf(patch.source) !== logSourceOf(existing.source)) throw badRecord('不能改 source')
  // 白名單欄位合併進既有列，再用合併後的列重新驗證。
  const merged = { ...stripKeys(existing) }
  if (patch.qty !== undefined) merged.qty = patch.qty
  if (patch.grams !== undefined) merged.grams = patch.grams
  if (patch.kcal !== undefined) merged.kcal = patch.kcal
  if (patch.protein !== undefined) merged.protein = patch.protein
  if (patch.fat !== undefined) merged.fat = patch.fat
  if (patch.carb !== undefined) merged.carb = patch.carb
  if (patch.ts !== undefined) merged.ts = patch.ts
  if (patch.day !== undefined) merged.day = patch.day
  if (patch.name !== undefined) merged.name = patch.name === null ? '' : patch.name
  merged.name = String(merged.name ?? '').trim()
  if ((merged.item_id ?? '') === '' || existing.source === 'quick') {
    if (merged.qty !== 1) throw badRecord('qty 必須是大於 0 的數字')
    if (merged.grams != null) throw badRecord('grams 格式不對')
  } else {
    // Code.gs 不重驗這兩項；D1 的 CHECK 會擋，所以這裡一併擋下，避免寫不進去的毒訊息。
    if (typeof merged.qty !== 'number' || !Number.isFinite(merged.qty) || merged.qty <= 0) throw badRecord('qty 必須是大於 0 的數字')
    if (!optionalPositive(merged.grams)) throw badRecord('grams 格式不對')
  }
  if (!nutritionOk(merged)) throw badRecord(NUT_MSG)
  checkDayTs(merged.day, merged.ts, ctx)
  merged.updated_at = nowIso(ctx)
  tx.put('logs', merged)
  return { rowId: a.id }
}

export type LogsDeleteResult = RowResult | IgnoredResult

export async function runLogsDelete(tx: Tx, ctx: Ctx, a: IdArgs): Promise<LogsDeleteResult> {
  const row = await tx.get('logs', a.id)
  if (!canWriteLogRow(ctx.actor, row)) throw forbidden(KYU_MSG)
  if (!row) throw notFound('找不到這筆紀錄：' + a.id)
  if (row.deleted_at !== null) return { ignored: 'deleted' }
  const now = nowIso(ctx)
  tx.put('logs', { ...stripKeys(row), deleted_at: now, updated_at: now })
  return { rowId: a.id }
}

export async function runLogsRestore(tx: Tx, ctx: Ctx, a: IdArgs): Promise<LogsDeleteResult> {
  const row = await tx.get('logs', a.id)
  if (!canWriteLogRow(ctx.actor, row)) throw forbidden(KYU_MSG)
  if (!row) throw notFound('找不到這筆紀錄：' + a.id)
  if (row.deleted_at === null) return { ignored: 'not_deleted' }
  tx.put('logs', { ...stripKeys(row), deleted_at: null, updated_at: nowIso(ctx) })
  return { rowId: a.id }
}
