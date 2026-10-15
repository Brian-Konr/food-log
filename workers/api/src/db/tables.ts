// Column lists of the six synced business tables, and the mapping between D1 rows and core's row types.
// Column names equal core's property names (schema/rows.ts); the only conversion is config.remind_meal_times (JSON text).
import { TABLES } from '@food-log/core'
import type { Row, RowInput, Table } from '@food-log/core'

/** Business columns per table, without user_id and version (those two are stamped by the store). */
export const COLUMNS = {
  stores: ['id', 'name', 'name_norm', 'last_eaten_at', 'created_by', 'ts', 'deleted_at', 'updated_at'],
  items: ['id', 'kind', 'base_id', 'src', 'name', 'serving', 'serving_g', 'kcal', 'protein', 'fat', 'carb', 'store_id', 'created_by', 'ts', 'cascade_of', 'deleted_at', 'updated_at'],
  logs: ['id', 'day', 'ts', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb', 'source', 'store_id', 'deleted_at', 'updated_at'],
  weights: ['id', 'day', 'ts', 'kg', 'deleted_at', 'updated_at'],
  favorites: ['item_id', 'deleted_at', 'updated_at'],
  config: ['target_kcal', 'target_protein', 'target_fat', 'target_carb', 'tdee', 'remind_meal_times', 'remind_weight_time', 'deleted_at', 'updated_at'],
} as const satisfies Record<Table, readonly string[]>

/** Primary key columns (after user_id) per table. config has one row per user. */
export const PK = {
  stores: ['id'],
  items: ['id'],
  logs: ['id'],
  weights: ['id'],
  favorites: ['item_id'],
  config: [],
} as const satisfies Record<Table, readonly string[]>

export const TABLE_ORDER = TABLES

/** `SELECT <list> FROM <table>`: all columns of a row including user_id and version, in a fixed order. */
export function selectList(t: Table): string {
  return ['user_id', ...COLUMNS[t], 'version'].join(', ')
}

type RawRow = Record<string, unknown>

/** D1 row -> core Row. */
export function fromDb<T extends Table>(t: T, r: RawRow): Row<T> {
  if (t === 'config') {
    return { ...r, remind_meal_times: JSON.parse(String(r.remind_meal_times)) as string[] } as unknown as Row<T>
  }
  return r as unknown as Row<T>
}

/** Values to bind for the business columns of a row, in COLUMNS order. */
export function toBindValues<T extends Table>(t: T, row: RowInput<T>): unknown[] {
  const rec = row as unknown as RawRow
  return COLUMNS[t].map((c) => {
    const v = rec[c]
    if (t === 'config' && c === 'remind_meal_times') return JSON.stringify(v ?? [])
    return v === undefined ? null : v
  })
}

const upsertSql = new Map<Table, string>()

/**
 * Upsert of one buffered row. The version stamp is the already-incremented global counter
 * (the commit batch runs UPDATE meta SET value = value + 1 first), so every row of one mutation carries the same version.
 */
export function upsertStatement(t: Table): string {
  let sql = upsertSql.get(t)
  if (!sql) {
    const cols = COLUMNS[t]
    const keys = ['user_id', ...PK[t]]
    sql =
      `INSERT INTO ${t} (user_id, ${cols.join(', ')}, version) ` +
      `VALUES (?, ${cols.map(() => '?').join(', ')}, (SELECT value FROM meta WHERE key = 'version')) ` +
      `ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${[...cols.filter((c) => !(PK[t] as readonly string[]).includes(c)), 'version'].map((c) => `${c} = excluded.${c}`).join(', ')}`
    upsertSql.set(t, sql)
  }
  return sql
}
