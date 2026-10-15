// 測試用工廠：mutation 參數、資料列、Ctx。測試資料一律是合成的（不放真實飲食資料）。
import { KYUJIN, OWNER } from '../actor'
import type { Actor, Ctx } from '../actor'
import type { ItemInput, LogInput, StoresUpsertArgs, WeightsUpsertArgs } from '../schema/args'
import type { ConfigRow, ItemRow, LogRow, StoreRow, WeightRow } from '../schema/rows'
import { TEST_NOW } from './memory-server'

export const TEST_TODAY = '2026-10-12'
export const TEST_YESTERDAY = '2026-10-11'

export function testCtx(actor: Actor = OWNER, now: () => number = () => TEST_NOW): Ctx {
  return { actor, now }
}
export const ownerCtx = (now?: () => number): Ctx => testCtx(OWNER, now)
export const kyujinCtx = (now?: () => number): Ctx => testCtx(KYUJIN, now)

/** 該台北日中午的 ISO 字串。 */
export const noonOf = (day: string, hhmm = '12:00'): string => `${day}T${hhmm}:00+08:00`

// ---- mutation 參數 ----

/** 一般品項的紀錄（item_id 非空）。 */
export function logArgs(over: Partial<LogInput> | Record<string, unknown> = {}): LogInput {
  return {
    id: 'log-1',
    ts: noonOf(TEST_YESTERDAY),
    day: TEST_YESTERDAY,
    item_id: 'fm:1',
    name: '雞胸',
    src: '全家',
    qty: 1,
    grams: null,
    kcal: 106,
    protein: 20.8,
    fat: 1.5,
    carb: 2.3,
    ...(over as Partial<LogInput>),
  }
}

/** 快速記錄。 */
export function quickLogArgs(over: Partial<LogInput> | Record<string, unknown> = {}): LogInput {
  return logArgs({
    id: 'q1',
    item_id: '',
    name: '',
    src: '其他',
    qty: 1,
    grams: null,
    kcal: 300,
    protein: 10,
    fat: 10,
    carb: 40,
    source: 'quick',
    ...(over as Partial<LogInput>),
  })
}

export function itemArgs(over: Partial<ItemInput> | Record<string, unknown> = {}): ItemInput {
  return {
    id: 'u:item-1',
    kind: '自建',
    base_id: null,
    src: '其他',
    name: '乳清',
    serving: '1 匙',
    serving_g: 30,
    kcal: 120,
    protein: 24,
    fat: 1,
    carb: 2,
    store_id: null,
    ts: noonOf(TEST_YESTERDAY),
    ...(over as Partial<ItemInput>),
  }
}

export function storeArgs(over: Partial<StoresUpsertArgs> | Record<string, unknown> = {}): StoresUpsertArgs {
  return { id: 's:1', name: '阿財牛肉麵', ts: noonOf(TEST_YESTERDAY), ...(over as Partial<StoresUpsertArgs>) }
}

export function weightArgs(over: Partial<WeightsUpsertArgs> | Record<string, unknown> = {}): WeightsUpsertArgs {
  return { id: 'w1', day: TEST_YESTERDAY, kg: 72.0, ts: noonOf(TEST_YESTERDAY, '08:00'), ...(over as Partial<WeightsUpsertArgs>) }
}

// ---- 資料列（直接放進 MemoryDb.seed）----

const ROW_TS = noonOf(TEST_YESTERDAY)
const rowCommon = { deleted_at: null, updated_at: ROW_TS } as const

export function storeRow(over: Partial<Omit<StoreRow, 'user_id' | 'version'>> = {}): Omit<StoreRow, 'user_id' | 'version'> {
  return { id: 's:1', name: '阿財牛肉麵', name_norm: '阿財牛肉麵', last_eaten_at: null, created_by: 'app', ts: ROW_TS, ...rowCommon, ...over }
}

export function itemRow(over: Partial<Omit<ItemRow, 'user_id' | 'version'>> = {}): Omit<ItemRow, 'user_id' | 'version'> {
  return {
    id: 'u:item-1', kind: '自建', base_id: null, src: '其他', name: '乳清', serving: '1 匙', serving_g: 30,
    kcal: 120, protein: 24, fat: 1, carb: 2, store_id: null, created_by: 'app', ts: ROW_TS, cascade_of: null, ...rowCommon, ...over,
  }
}

export function logRow(over: Partial<Omit<LogRow, 'user_id' | 'version'>> = {}): Omit<LogRow, 'user_id' | 'version'> {
  return {
    id: 'log-1', day: TEST_YESTERDAY, ts: ROW_TS, item_id: 'fm:1', name: '雞胸', src: '全家', qty: 1, grams: null,
    kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3, source: 'app', store_id: null, ...rowCommon, ...over,
  }
}

export function weightRow(over: Partial<Omit<WeightRow, 'user_id' | 'version'>> = {}): Omit<WeightRow, 'user_id' | 'version'> {
  return { id: 'w1', day: TEST_YESTERDAY, ts: noonOf(TEST_YESTERDAY, '08:00'), kg: 72, ...rowCommon, ...over }
}

export function configRow(over: Partial<Omit<ConfigRow, 'user_id' | 'version'>> = {}): Omit<ConfigRow, 'user_id' | 'version'> {
  return {
    target_kcal: 2000, target_protein: 150, target_fat: 60, target_carb: 200, tdee: null,
    remind_meal_times: [], remind_weight_time: null, ...rowCommon, ...over,
  }
}
