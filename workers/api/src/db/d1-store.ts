// D1 implementation of core's ServerStore / UserStore (packages/core/src/server/store.ts is the contract).
//
// D1 has NO interactive transactions, only db.batch([...]) which is atomic. So each attempt:
//   begin():  one batch of SELECTs -> (version V, epoch, client cursor C); mutator reads go to D1 (D1Tx),
//             writes are buffered.
//   commit(): ONE batch =
//               guard1  INSERT INTO cas_guard SELECT CASE WHEN version = V ...   (CHECK cas_ok: ok = 1)
//               guard2  INSERT INTO cas_guard SELECT CASE WHEN client cursor = C ...
//               DELETE FROM cas_guard
//               [UPDATE meta SET value = value + 1 ; row upserts stamped with the new version]   (ok + has writes)
//               INSERT mutation_outcomes (ok result, or the business error)
//               [DELETE ok outcomes older than (mutationId - 200)]
//               upsert sync_clients cursor
//             A failing guard aborts and rolls the whole batch back -> commit() returns false (CAS conflict).
//             Any OTHER constraint failure (UNIQUE index, CHECK, NOT NULL, STRICT type) with version and cursor still
//             equal to what begin() read is deterministic: retrying would fail the same way -> MutationError('bad_record'),
//             which process-push turns into a recorded business error (no 503 loop). If version or cursor moved, someone
//             else committed first and a retry may well succeed -> false.
//
// Every statement is scoped by the bound userId; `meta` is the only global table.
import { MUTATION_OUTCOME_RETENTION, MutationError, TABLES, taipeiIso } from '@food-log/core'
import type {
  CommitInput,
  ErrorInput,
  MutationOutcome,
  RecordedError,
  Row,
  ServerStore,
  ServerTx,
  Table,
  UserStore,
  VersionedRow,
} from '@food-log/core'
import { D1Tx } from './d1-tx.ts'
import { PK, TABLE_ORDER, fromDb, selectList, toBindValues, upsertStatement } from './tables.ts'

const errText = (e: unknown): string => String((e as Error)?.message ?? e) + ' ' + String((e as { cause?: unknown })?.cause ?? '')

/** Only a failed cas_guard means "someone else committed first". */
export function isCasConflict(e: unknown): boolean {
  return /cas_ok/.test(errText(e))
}

/** A deterministic constraint failure (not a guard): UNIQUE / CHECK / NOT NULL / FOREIGN KEY / STRICT type mismatch. */
export function isConstraintViolation(e: unknown): boolean {
  const t = errText(e)
  return !/cas_ok/.test(t) && /(UNIQUE|CHECK|NOT NULL|FOREIGN KEY) constraint failed|cannot store|datatype mismatch|SQLITE_CONSTRAINT/i.test(t)
}

function violationMessage(e: unknown): string {
  const t = errText(e)
  if (/UNIQUE constraint failed: weights\.user_id, weights\.day/.test(t)) return '這天已經有一筆體重（唯一索引）'
  if (/UNIQUE constraint failed: stores\.user_id, stores\.name_norm/.test(t)) return '店名重複（唯一索引）'
  const m = /(?:CHECK|UNIQUE|NOT NULL|FOREIGN KEY) constraint failed: ([\w., ]+)/.exec(t)
  return '資料不符合資料庫約束' + (m ? `（${m[1]!.trim()}）` : '')
}

/** Per-isolate counters, for tests and for `wrangler tail` debugging. */
export const casStats = { conflicts: 0, commits: 0 }

type MetaRow = { key: string; value: number | string }

function headOf(rows: MetaRow[]): { version: number; epoch: string } {
  let version = 0
  let epoch = 'e1'
  for (const r of rows) {
    if (r.key === 'version') version = Number(r.value)
    if (r.key === 'epoch') epoch = String(r.value)
  }
  return { version, epoch }
}

const META_SQL = `SELECT key, value FROM meta WHERE key IN ('version', 'epoch')`
const CURSOR_SQL = `SELECT last_mutation_id AS c FROM sync_clients WHERE user_id = ? AND client_id = ?`
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v))

interface OutcomeRow {
  mutation_id: number
  ok: number
  name: string
  result: string | null
  error: string | null
  message: string | null
  details: string | null
  at: string
}

const toRecordedError = (clientId: string, r: OutcomeRow): RecordedError => ({
  clientId,
  mutationId: r.mutation_id,
  name: r.name,
  error: r.error ?? 'bad_record',
  message: r.message ?? '',
  details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : undefined,
  at: r.at,
})

export class D1Store implements ServerStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  forUser(userId: string): D1UserStore {
    return new D1UserStore(this.db, userId, this.now)
  }
}

class D1ServerTx implements ServerTx {
  readonly tx: D1Tx

  constructor(
    private readonly db: D1Database,
    private readonly userId: string,
    private readonly clientId: string,
    readonly version: number,
    readonly lastMutationId: number,
    private readonly now: () => number,
  ) {
    this.tx = new D1Tx(db, userId, now)
  }

  hasWrites(): boolean {
    return this.tx.hasWrites
  }

  async commit(input: CommitInput): Promise<boolean> {
    const { db, userId, clientId, version, lastMutationId: cursor } = this
    const stamp = taipeiIso(this.now())
    const stmts: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO cas_guard (ok) SELECT CASE WHEN (SELECT value FROM meta WHERE key = 'version') = ? THEN 1 ELSE 0 END`).bind(version),
      db
        .prepare(`INSERT INTO cas_guard (ok) SELECT CASE WHEN COALESCE((SELECT last_mutation_id FROM sync_clients WHERE user_id = ? AND client_id = ?), 0) = ? THEN 1 ELSE 0 END`)
        .bind(userId, clientId, cursor),
      db.prepare(`DELETE FROM cas_guard`),
    ]
    if (input.ok && this.tx.hasWrites) {
      stmts.push(db.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'version'`))
      for (const w of this.tx.writes()) {
        stmts.push(db.prepare(upsertStatement(w.table)).bind(userId, ...toBindValues(w.table, w.row as never)))
      }
    }
    const err: ErrorInput | undefined = input.ok ? undefined : input.error
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO mutation_outcomes (user_id, client_id, mutation_id, ok, name, result, error, message, details, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          clientId,
          input.mutationId,
          input.ok ? 1 : 0,
          err?.name ?? '',
          input.ok ? JSON.stringify(input.result ?? null) : null,
          err?.error ?? null,
          err?.message ?? null,
          err ? json(err.details) : null,
          err?.at ?? stamp,
        ),
    )
    if (input.ok) {
      // keep only the newest MUTATION_OUTCOME_RETENTION successful results per device; business errors are never pruned
      stmts.push(
        db
          .prepare(`DELETE FROM mutation_outcomes WHERE user_id = ? AND client_id = ? AND ok = 1 AND mutation_id <= ?`)
          .bind(userId, clientId, input.mutationId - MUTATION_OUTCOME_RETENTION),
      )
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO sync_clients (user_id, client_id, last_mutation_id, last_seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, client_id) DO UPDATE SET last_mutation_id = excluded.last_mutation_id, last_seen_at = excluded.last_seen_at`,
        )
        .bind(userId, clientId, input.mutationId, stamp),
    )
    try {
      await db.batch(stmts)
      casStats.commits++
      return true
    } catch (e) {
      if (isCasConflict(e)) {
        casStats.conflicts++
        return false
      }
      if (isConstraintViolation(e)) {
        // The guards run first inside the batch, so a constraint failure normally means the writes themselves are bad.
        // Re-check anyway: only if version and cursor are still what begin() read is it deterministic (-> bad_record).
        // Otherwise someone else moved first and a retry may well succeed.
        const [m, c] = await db.batch([db.prepare(`SELECT value FROM meta WHERE key = 'version'`), db.prepare(CURSOR_SQL).bind(userId, clientId)])
        const nowVersion = Number((m as D1Result<{ value: number | string }>).results[0]?.value)
        const nowCursor = ((c as D1Result<{ c: number }>).results[0]?.c as number | undefined) ?? 0
        if (nowVersion === version && nowCursor === cursor) throw new MutationError('bad_record', violationMessage(e))
        casStats.conflicts++
        return false
      }
      throw e
    }
  }
}

/** A user-bound store. Besides core's UserStore it has the read helpers of /bot/v1 and the export cron. */
export class D1UserStore implements UserStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async begin(clientId: string): Promise<ServerTx> {
    const [metaRs, curRs] = await this.db.batch([this.db.prepare(META_SQL), this.db.prepare(CURSOR_SQL).bind(this.userId, clientId)])
    const { version } = headOf((metaRs as D1Result<MetaRow>).results)
    const cursor = ((curRs as D1Result<{ c: number }>).results[0]?.c as number | undefined) ?? 0
    return new D1ServerTx(this.db, this.userId, clientId, version, cursor, this.now)
  }

  async readMeta(): Promise<{ epoch: string; version: number }> {
    const rs = await this.db.prepare(META_SQL).all<MetaRow>()
    return headOf(rs.results)
  }

  async rowsAfter(afterVersion: number, limit: number): Promise<VersionedRow[]> {
    const db = this.db
    // Phase 1: for every table, the version of its limit-th row after `afterVersion` (index-only, one batch). The smallest of
    // those is a cutoff that already covers at least `limit` rows, so phase 2 reads each table only up to it instead of
    // `limit` rows per table. (D1 allows at most 5 terms in a compound SELECT, so this cannot be one UNION ALL over 6 tables.)
    const edges = await db.batch(
      TABLES.map((t) =>
        db
          .prepare(`SELECT version FROM ${t} WHERE user_id = ? AND version > ? ORDER BY version LIMIT 1 OFFSET ?`)
          .bind(this.userId, afterVersion, Math.max(0, limit - 1)),
      ),
    )
    let upTo = Number.MAX_SAFE_INTEGER
    for (const e of edges as D1Result<{ version: number }>[]) {
      const v = e.results[0]?.version
      if (v !== undefined && v < upTo) upTo = v
    }
    // Phase 2: those rows, all tables in one batch.
    const rs = await db.batch(
      TABLES.map((t) =>
        db
          .prepare(`SELECT ${selectList(t)} FROM ${t} WHERE user_id = ? AND version > ? AND version <= ? ORDER BY version, ${['user_id', ...PK[t]].join(', ')}`)
          .bind(this.userId, afterVersion, upTo),
      ),
    )
    return mergeRows(rs as D1Result<Record<string, unknown>>[]).slice(0, limit)
  }

  async rowsAtVersion(version: number): Promise<VersionedRow[]> {
    const db = this.db
    const rs = await db.batch(TABLES.map((t) => db.prepare(`SELECT ${selectList(t)} FROM ${t} WHERE user_id = ? AND version = ?`).bind(this.userId, version)))
    return mergeRows(rs as D1Result<Record<string, unknown>>[])
  }

  async getLastMutationId(clientId: string): Promise<number> {
    const r = await this.db.prepare(CURSOR_SQL).bind(this.userId, clientId).first<{ c: number }>()
    return r?.c ?? 0
  }

  async getMutationOutcome(clientId: string, mutationId: number): Promise<MutationOutcome | undefined> {
    const r = await this.db
      .prepare(`SELECT mutation_id, ok, name, result, error, message, details, at FROM mutation_outcomes WHERE user_id = ? AND client_id = ? AND mutation_id = ?`)
      .bind(this.userId, clientId, mutationId)
      .first<OutcomeRow>()
    if (!r) return undefined
    if (r.ok === 1) return { ok: true, result: r.result === null ? null : (JSON.parse(r.result) as unknown) }
    return { ok: false, error: toRecordedError(clientId, r) }
  }

  async listErrors(clientId: string, afterMutationId: number): Promise<RecordedError[]> {
    const rs = await this.db
      .prepare(
        `SELECT mutation_id, ok, name, result, error, message, details, at FROM mutation_outcomes WHERE user_id = ? AND client_id = ? AND ok = 0 AND mutation_id > ? ORDER BY mutation_id`,
      )
      .bind(this.userId, clientId, afterMutationId)
      .all<OutcomeRow>()
    return rs.results.map((r) => toRecordedError(clientId, r))
  }

  // ---------------------------------------------------------------- read helpers for /bot/v1

  /** All rows of one table (including deleted), ordered by primary key. */
  async allRows<T extends Table>(t: T): Promise<Row<T>[]> {
    const rs = await this.db.prepare(`SELECT ${selectList(t)} FROM ${t} WHERE user_id = ? ORDER BY ${PK[t].join(', ') || 'user_id'}`).bind(this.userId).all<Record<string, unknown>>()
    return rs.results.map((r) => fromDb(t, r))
  }

  /** The config row, or undefined when the user has none yet (callers fall back to core's defaults). */
  async configRow(): Promise<Row<'config'> | undefined> {
    const r = await this.db.prepare(`SELECT ${selectList('config')} FROM config WHERE user_id = ?`).bind(this.userId).first<Record<string, unknown>>()
    return r ? fromDb('config', r) : undefined
  }

  /** Logs or weights whose day is in [fromDay, toDay] (inclusive; either bound may be omitted), including deleted rows. */
  async rowsInDays<T extends 'logs' | 'weights'>(t: T, fromDay?: string, toDay?: string): Promise<Row<T>[]> {
    const rs = await this.db
      .prepare(`SELECT ${selectList(t)} FROM ${t} WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY day, ts, id`)
      .bind(this.userId, fromDay ?? '0000-00-00', toDay ?? '9999-99-99')
      .all<Record<string, unknown>>()
    return rs.results.map((r) => fromDb(t, r))
  }

  /** Newest first: rows with day < before, at most `limit`, plus whether there are more. Includes deleted rows. */
  async historyBefore<T extends 'logs' | 'weights'>(t: T, before: string, limit: number): Promise<{ records: Row<T>[]; hasMore: boolean }> {
    const rs = await this.db
      .prepare(`SELECT ${selectList(t)} FROM ${t} WHERE user_id = ? AND day < ? ORDER BY day DESC, ts DESC, id DESC LIMIT ?`)
      .bind(this.userId, before, limit + 1)
      .all<Record<string, unknown>>()
    const rows = rs.results.map((r) => fromDb(t, r))
    return { records: rows.slice(0, limit), hasMore: rows.length > limit }
  }

  /** Chunked read for the export cron: rows with rowid > afterRowid, in rowid order. */
  async chunk<T extends Table>(t: T, afterRowid: number, limit: number): Promise<{ rows: Row<T>[]; lastRowid: number }> {
    const rs = await this.db
      .prepare(`SELECT rowid AS _rowid, ${selectList(t)} FROM ${t} WHERE user_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`)
      .bind(this.userId, afterRowid, limit)
      .all<Record<string, unknown>>()
    let last = afterRowid
    const rows = rs.results.map((r) => {
      last = Number(r._rowid)
      const { _rowid: _ignored, ...rest } = r
      return fromDb(t, rest)
    })
    return { rows, lastRowid: last }
  }
}

/** Merge the per-table results into one list ordered by (version, table order, primary key). */
function mergeRows(results: D1Result<Record<string, unknown>>[]): VersionedRow[] {
  const out: VersionedRow[] = []
  results.forEach((rs, i) => {
    const table = TABLE_ORDER[i]!
    for (const r of rs.results) out.push({ table, row: fromDb(table, r) } as VersionedRow)
  })
  return out.sort((a, b) => a.row.version - b.row.version || TABLE_ORDER.indexOf(a.table) - TABLE_ORDER.indexOf(b.table) || cmp(keyOf(a), keyOf(b)))
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function keyOf(r: VersionedRow): string {
  const rec = r.row as unknown as Record<string, unknown>
  return (PK[r.table] as readonly string[]).map((c) => String(rec[c])).join('\u0000')
}
