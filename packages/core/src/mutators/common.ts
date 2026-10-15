import type { Ctx } from '../actor'
import { badRecord } from '../errors'
import { taipeiDayOfTs, taipeiIso, taipeiToday } from '../time'
import type { RowInput, Table } from '../schema/rows'
import type { Tx } from '../tx'

/** 和 legacy/gas/Code.gs 相同的訊息。 */
export const NUT_MSG = '紀錄必須有熱量、蛋白質、脂肪、碳水'

/** 成功結果：被忽略（列已被刪除；或要復原的列本來就沒被刪）。不產生寫入，伺服器版本號不變。 */
export type IgnoredResult = { ignored: 'deleted' | 'not_deleted' }
/** 成功結果：重複的 id（冪等重送）。不產生寫入。 */
export type DuplicateResult = { duplicate: true }
/** 成功結果：寫入了一列。 */
export type RowResult = { rowId: string }

export type Write = { [T in Table]: { table: T; row: RowInput<T> } }[Table]

/**
 * mutator 先「規劃」（所有讀取 + 驗證，不寫入），再一次套用寫入：
 * 這樣符合「先讀後寫」，也讓 logs.add 能把品項和紀錄的規劃合在同一個交易裡。
 */
export type Plan<R> = { result: R; writes: Write[] }

export function write<T extends Table>(table: T, row: RowInput<T>): Write {
  return { table, row } as Write
}

export function applyWrites(tx: Tx, writes: readonly Write[]): void {
  for (const w of writes) tx.put(w.table, w.row as never)
}

export async function runPlan<R>(tx: Tx, plan: Plan<R>): Promise<R> {
  applyWrites(tx, plan.writes)
  return plan.result
}

export const nowIso = (ctx: Ctx): string => taipeiIso(ctx.now())

export function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function nutritionOk(rec: { kcal: unknown; protein: unknown; fat: unknown; carb: unknown }): boolean {
  return isFiniteNonNeg(rec.kcal) && isFiniteNonNeg(rec.protein) && isFiniteNonNeg(rec.fat) && isFiniteNonNeg(rec.carb)
}

/** ts 必須是台北時間 ISO（…+08:00）：D1 的 CHECK 也這樣擋，這裡先擋才不會變成寫不進去的毒訊息。 */
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/

/** day 必須等於 ts 的台北日、不能是未來日期（Code.gs 的 day／未來日期檢查）。 */
export function checkDayTs(day: string, ts: string, ctx: Ctx): void {
  if (!TS_RE.test(ts)) throw badRecord('ts 格式不對，必須是台北時間（+08:00）')
  const tsDay = taipeiDayOfTs(ts)
  if (tsDay === null || day !== tsDay) throw badRecord('day 必須等於台北日')
  if (day > taipeiToday(ctx.now())) throw badRecord('不能記未來的日期')
}

/** serving_g／grams：未填、或大於 0 的有限數字。 */
export function optionalPositive(v: number | null | undefined): boolean {
  return v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0)
}

/** 讀到的列 → 可以再 put 回去的內容（去掉 user_id 與 version）。 */
export function stripKeys<T extends { user_id: string; version: number }>(row: T): Omit<T, 'user_id' | 'version'> {
  const { user_id: _u, version: _v, ...rest } = row
  return rest
}
