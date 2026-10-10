import type { ConfigMap, ItemRecord, LogRecord, Snapshot, WeightRecord } from '@/types'
import { DEFAULT_CONFIG } from './defaults'

const bool = (v: unknown) => v === true || v === 'TRUE' || v === 'true'
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))
const num = (v: unknown): number => {
  if (v === '' || v === undefined || v === null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: unknown): number | null => {
  if (v === '' || v === undefined || v === null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export function decodeLog(r: Record<string, unknown>): LogRecord {
  return {
    id: str(r.id),
    ts: str(r.ts),
    deleted: bool(r.deleted),
    updated_at: str(r.updated_at),
    day: str(r.day).slice(0, 10),
    item_id: str(r.item_id),
    name: str(r.name),
    src: str(r.src) as LogRecord['src'],
    qty: num(r.qty),
    grams: numOrNull(r.grams),
    kcal: num(r.kcal),
    protein: num(r.protein),
    fat: num(r.fat),
    carb: num(r.carb),
    __pending: r.__pending ? true : undefined,
  }
}

export function decodeWeight(r: Record<string, unknown>): WeightRecord {
  return {
    id: str(r.id),
    day: str(r.day).slice(0, 10),
    ts: str(r.ts),
    deleted: bool(r.deleted),
    updated_at: str(r.updated_at),
    kg: num(r.kg),
    __pending: r.__pending ? true : undefined,
  }
}

export function decodeItem(r: Record<string, unknown>): ItemRecord {
  return {
    id: str(r.id),
    ts: str(r.ts),
    deleted: bool(r.deleted),
    updated_at: str(r.updated_at),
    kind: str(r.kind) as ItemRecord['kind'],
    base_id: str(r.base_id),
    src: str(r.src) as ItemRecord['src'],
    name: str(r.name),
    serving: str(r.serving),
    serving_g: numOrNull(r.serving_g),
    kcal: num(r.kcal),
    protein: num(r.protein),
    fat: num(r.fat),
    carb: num(r.carb),
    fav: bool(r.fav),
    created_by: str(r.created_by) as ItemRecord['created_by'],
    __pending: r.__pending ? true : undefined,
  }
}

export function decodeConfig(raw: Record<string, unknown> | undefined | null): ConfigMap {
  const out = { ...DEFAULT_CONFIG }
  if (!raw) return out
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (raw[k] !== undefined && raw[k] !== null) out[k] = String(raw[k])
  }
  return out
}

export function decodeSnapshot(raw: {
  version?: number
  serverTime?: string
  config?: Record<string, unknown>
  items?: Record<string, unknown>[]
  logs?: Record<string, unknown>[]
  weights?: Record<string, unknown>[]
}): Snapshot {
  return {
    ok: true,
    version: typeof raw.version === 'number' ? raw.version : 1,
    serverTime: str(raw.serverTime),
    config: decodeConfig(raw.config),
    items: (raw.items ?? []).map(decodeItem),
    logs: (raw.logs ?? []).map(decodeLog),
    weights: (raw.weights ?? []).map(decodeWeight),
  }
}

export function encodeBool(v: boolean): 'TRUE' | 'FALSE' {
  return v ? 'TRUE' : 'FALSE'
}

export function encodeNum(v: number | null | undefined): number | '' {
  return v === null || v === undefined ? '' : v
}

export const LOG_COLS = ['id', 'ts', 'deleted', 'updated_at', 'day', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb'] as const
export const WEIGHT_COLS = ['day', 'ts', 'deleted', 'updated_at', 'kg', 'id'] as const
export const ITEM_COLS = ['id', 'ts', 'deleted', 'updated_at', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'fav', 'created_by'] as const
export const CONFIG_COLS = ['key', 'value', 'updated_at'] as const

export function logToRow(r: LogRecord): unknown[] {
  return [r.id, r.ts, encodeBool(r.deleted), r.updated_at, r.day, r.item_id, r.name, r.src, r.qty, encodeNum(r.grams), r.kcal, r.protein, r.fat, r.carb]
}

export function weightToRow(r: WeightRecord): unknown[] {
  return [r.day, r.ts, encodeBool(r.deleted), r.updated_at, r.kg, r.id]
}

export function itemToRow(r: ItemRecord): unknown[] {
  return [r.id, r.ts, encodeBool(r.deleted), r.updated_at, r.kind, r.base_id, r.src, r.name, r.serving, encodeNum(r.serving_g), r.kcal, r.protein, r.fat, r.carb, encodeBool(r.fav), r.created_by]
}

export function rowToLog(row: unknown[]): LogRecord {
  const o: Record<string, unknown> = {}
  LOG_COLS.forEach((k, i) => { o[k] = row[i] })
  return decodeLog(o)
}

export function rowToWeight(row: unknown[]): WeightRecord {
  const o: Record<string, unknown> = {}
  WEIGHT_COLS.forEach((k, i) => { o[k] = row[i] })
  return decodeWeight(o)
}
