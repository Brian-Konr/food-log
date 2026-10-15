// Shared types of the migration tools.
import type { Table } from '@food-log/core'

/** One Sheet row exactly as the Apps Script `read` / `history` actions return it (JSON). */
export type SheetRecord = Record<string, unknown>

export const SNAPSHOT_FORMAT = 'food-log-sheet/1'

/** Everything fetch-sheet reads from the Sheet. Private data: only ever written under tools/migrate/out (gitignored). */
export interface SheetSnapshot {
  format: typeof SNAPSHOT_FORMAT
  /** when fetch-sheet ran (UTC ISO) */
  fetchedAt: string
  /** `serverTime` of the `read` response (Taipei ISO); used as updated_at where the Sheet has no timestamp (Config) */
  serverTime: string
  apiVersion: number
  /** v1 Config: key -> string value (includes schema_version, fav_ids) */
  config: Record<string, string>
  items: SheetRecord[]
  stores: SheetRecord[]
  logs: SheetRecord[]
  weights: SheetRecord[]
  /** non-fatal problems met while fetching (e.g. a day with more than one history page of rows) */
  warnings: string[]
  /** how many history pages were needed */
  pages: { Logs: number; Weights: number }
}

/**
 * Every adjustment the transform makes to the Sheet data (plan 4 stage 3 step 2).
 *   dropped  the row cannot be imported (D1 would reject it); it is NOT in D1
 *   fixed    the row is imported with `changes` applied (from = Sheet value, to = D1 value)
 *   note     something odd that was kept as it is
 * `index` is the position of the row in the snapshot array of that table (null for config); verify uses it to
 * compute the expected counts and sums "minus anomalies".
 */
export interface Anomaly {
  table: Table
  index: number | null
  id: string
  kind: 'dropped' | 'fixed' | 'note'
  code: string
  detail: string
  changes?: Record<string, { from: unknown; to: unknown }>
}

export type ImportTable = Table

/** The six D1 business tables as plain records (user_id and version are added by emit-sql / the loader). */
export type DumpRow = Record<string, unknown>

/** A D1 dump (all rows, with user_id and version) plus the global meta. */
export interface D1Dump {
  meta: { version: number; epoch: string }
  tables: Record<Table, DumpRow[]>
}
