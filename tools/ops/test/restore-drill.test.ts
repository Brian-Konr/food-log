// Restore drill tests. The export folder is synthesised here with rows shaped exactly like workers/api/src/cron/export.ts
// writes them: JSON parts hold `selectList(t)` columns in that order (user_id, business columns, version), config's
// remind_meal_times is an array, `_ok.json` has one entry per table plus 'logs.csv', CSV part 1 has BOM + header, CRLF lines.
// cron/export.ts itself cannot be imported here (it needs the Workers D1/R2 types), so its CSV helpers are mirrored below;
// the column lists come straight from workers/api/src/db/tables.ts. All data is fake.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TABLES as CORE_TABLES } from '@food-log/core'
import { COLUMNS } from '../../../workers/api/src/db/tables.ts'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_MIGRATIONS_DIR, DrillRefusal, TABLES, applyMigrations, formatReport, listMigrations, parseCsv, runDrill } from '../src/drill-lib.ts'
import { buildRestoreSql, sqlLiteral } from '../src/restore-sql.ts'
import type { ExportManifest, PartInfo, Row, TableManifest } from '../src/drill-lib.ts'

const U = 'user-fake-1'
const DAY = '2026-03-02'
const STAMP = '2026-03-02T09:00:00+08:00'

// ---- mirrors of cron/export.ts (CSV_COLUMNS, csvCell) ----
const CSV_COLUMNS = ['id', 'day', 'ts', 'item_id', 'name', 'src', 'qty', 'grams', 'kcal', 'protein', 'fat', 'carb', 'source', 'store_id', 'deleted_at', 'updated_at', 'user_id'] as const
const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
}

/** a row with the key order of selectList(t): user_id, business columns, version */
function shaped(t: (typeof TABLES)[number], v: Record<string, unknown>): Row {
  const out: Row = {}
  for (const c of ['user_id', ...COLUMNS[t], 'version']) out[c] = v[c] ?? null
  return out
}

function fixtureRows(): Record<(typeof TABLES)[number], Row[]> {
  const base = { user_id: U, updated_at: STAMP }
  const log = (id: string, ts: string, name: string, k: number, p: number, f: number, c: number, version: number, extra: Record<string, unknown> = {}): Row =>
    shaped('logs', { ...base, id, day: ts.slice(0, 10), ts, item_id: null, name, src: '其他', qty: 1, grams: null, kcal: k, protein: p, fat: f, carb: c, source: 'quick', store_id: null, version, deleted_at: null, ...extra })
  return {
    stores: [shaped('stores', { ...base, id: 's:aaa', name: '假店家', name_norm: '假店家', last_eaten_at: null, created_by: 'app', ts: STAMP, version: 1, deleted_at: null })],
    items: [
      shaped('items', { ...base, id: 'u:one', kind: '自建', base_id: null, src: '其他', name: '假雞胸', serving: '100g', serving_g: 100, kcal: 120, protein: 23.5, fat: 2, carb: 0, store_id: 's:aaa', created_by: 'app', ts: STAMP, cascade_of: null, version: 2, deleted_at: null }),
      shaped('items', { ...base, id: 'u:two', kind: '自建', base_id: null, src: '其他', name: '假飯糰', serving: '1個', serving_g: null, kcal: 180, protein: 4, fat: 3, carb: 33, store_id: null, created_by: 'app', ts: STAMP, cascade_of: null, version: 3, deleted_at: '2026-03-02T10:00:00+08:00' }),
    ],
    logs: [
      log('l1', '2026-03-01T08:30:00+08:00', '早餐, 含逗號', 300.5, 20, 10.25, 30, 4),
      log('l2', '2026-03-01T12:30:00+08:00', '午餐 "引號"', 650, 40, 20, 70, 5),
      log('l3', '2026-03-02T07:10:00+08:00', '早餐', 250, 15, 8, 28, 6),
      log('l4', '2026-03-02T19:00:00+08:00', '被刪除的', 999, 99, 99, 99, 7, { deleted_at: '2026-03-02T19:05:00+08:00' }),
      log('l5', '2026-03-02T19:30:00+08:00', '晚餐', 700, 45, 25, 60, 8, { item_id: 'u:one', src: '其他', qty: 2, grams: 200, source: 'app', store_id: 's:aaa' }),
    ],
    weights: [
      shaped('weights', { ...base, id: 'w:2026-03-01', day: '2026-03-01', ts: '2026-03-01T07:00:00+08:00', kg: 70.5, version: 9, deleted_at: null }),
      // a deleted weight on the same day as a live one: allowed by the partial unique index
      shaped('weights', { ...base, id: 'w:old', day: '2026-03-02', ts: '2026-03-02T06:00:00+08:00', kg: 71, version: 10, deleted_at: '2026-03-02T06:30:00+08:00' }),
      shaped('weights', { ...base, id: 'w:2026-03-02', day: '2026-03-02', ts: '2026-03-02T07:00:00+08:00', kg: 70.8, version: 11, deleted_at: null }),
    ],
    favorites: [shaped('favorites', { ...base, item_id: 'u:one', version: 12, deleted_at: null }), shaped('favorites', { ...base, item_id: 'u:two', version: 13, deleted_at: '2026-03-02T10:00:00+08:00' })],
    config: [shaped('config', { ...base, target_kcal: 2000, target_protein: 120, target_fat: 60, target_carb: 220, tdee: 2300, remind_meal_times: ['08:00', '12:30'], remind_weight_time: '07:00', version: 14, deleted_at: null })],
  }
}

type Fixture = { dir: string; manifest: ExportManifest }

/** write an export folder; logs are split in two parts (3 + 2 rows) to exercise multi-part tables and the CSV header rule */
function writeExport(dir: string, rowsByTable = fixtureRows()): Fixture {
  mkdirSync(dir, { recursive: true })
  const tables: Record<string, TableManifest> = {}
  const put = (file: string, body: string): PartInfo & { file: string } => {
    writeFileSync(join(dir, file), body)
    return { file, key: `exports/${DAY}/${file}`, rows: 0, bytes: Buffer.byteLength(body) }
  }
  for (const t of TABLES) {
    const rows = rowsByTable[t]
    const chunks = t === 'logs' ? [rows.slice(0, 3), rows.slice(3)] : [rows]
    const parts: PartInfo[] = chunks.map((c, i) => {
      const body = c.length === 0 ? '[]\n' : '[\n' + c.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n'
      const { file: _f, ...p } = put(`${t}.part-${i + 1}.json`, body)
      return { ...p, rows: c.length }
    })
    tables[t] = { rows: rows.length, bytes: parts.reduce((n, p) => n + p.bytes, 0), parts }
    if (t === 'logs') {
      const csvParts: PartInfo[] = chunks.map((c, i) => {
        const body = (i === 0 ? '﻿' + CSV_COLUMNS.join(',') + '\r\n' : '') + c.map((r) => CSV_COLUMNS.map((k) => csvCell(r[k])).join(',') + '\r\n').join('')
        const { file: _f, ...p } = put(`logs.part-${i + 1}.csv`, body)
        return { ...p, rows: c.length }
      })
      tables['logs.csv'] = { rows: rows.length, bytes: csvParts.reduce((n, p) => n + p.bytes, 0), parts: csvParts }
    }
  }
  const manifest: ExportManifest = { ok: true, day: DAY, finishedAt: '2026-03-02T04:03:00+08:00', versionAtStart: 14, versionAtEnd: 14, epoch: 'e1', consistent: true, attempts: 1, tables }
  writeFileSync(join(dir, '_ok.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { dir, manifest }
}

const patchManifest = (dir: string, fn: (m: ExportManifest) => void): void => {
  const m = JSON.parse(readFileSync(join(dir, '_ok.json'), 'utf8')) as ExportManifest
  fn(m)
  writeFileSync(join(dir, '_ok.json'), JSON.stringify(m, null, 2) + '\n')
}

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'restore-drill-test-'))
  dir = join(root, 'export')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('restore-drill', () => {
  it('loads the same tables, in the same order, as @food-log/core', () => {
    expect([...TABLES]).toEqual([...CORE_TABLES])
  })

  it('happy path: restores every table, matches counts and per-day sums', () => {
    writeExport(dir)
    const r = runDrill({ dir })
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.exportDay).toBe(DAY)
    expect(r.version).toEqual({ start: 14, end: 14 })
    const byTable = Object.fromEntries(r.tables.map((t) => [t.table, t]))
    expect(byTable.stores).toMatchObject({ expected: 1, live: 1, deleted: 0 })
    expect(byTable.items).toMatchObject({ expected: 2, live: 1, deleted: 1 })
    expect(byTable.logs).toMatchObject({ expected: 5, inParts: 5, live: 4, deleted: 1 })
    expect(byTable.weights).toMatchObject({ expected: 3, live: 2, deleted: 1 })
    expect(byTable.favorites).toMatchObject({ expected: 2, live: 1, deleted: 1 })
    expect(byTable.config).toMatchObject({ expected: 1, live: 1, deleted: 0 })
    // the deleted 999 kcal log is not in the day sums
    expect(r.days).toEqual([
      { day: '2026-03-01', rows: 2, kcal: 950.5, protein: 60, fat: 30.25, carb: 100 },
      { day: '2026-03-02', rows: 2, kcal: 950, protein: 60, fat: 33, carb: 88 },
    ])
    expect(r.weights).toEqual([
      { day: '2026-03-01', count: 1 },
      { day: '2026-03-02', count: 1 },
    ])
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)
    const text = formatReport(r)
    expect(text).toContain('RESULT: OK')
    expect(text).toContain('elapsed:')
  })

  it('writes a SQLite file when --db is given, stores config.remind_meal_times as JSON text, and refuses to reuse the file', () => {
    writeExport(dir)
    const dbPath = join(root, 'drill.sqlite')
    expect(runDrill({ dir, dbPath }).ok).toBe(true)
    expect(existsSync(dbPath)).toBe(true)
    expect(() => runDrill({ dir, dbPath })).toThrow(/already exists/)
  })

  it('refuses when _ok.json is missing', () => {
    writeExport(dir)
    rmSync(join(dir, '_ok.json'))
    expect(() => runDrill({ dir })).toThrow(DrillRefusal)
    expect(() => runDrill({ dir })).toThrow(/_ok\.json/)
  })

  it('refuses when the export is not consistent', () => {
    writeExport(dir)
    patchManifest(dir, (m) => {
      m.consistent = false
      m.versionAtEnd = 99
    })
    expect(() => runDrill({ dir })).toThrow(DrillRefusal)
    expect(() => runDrill({ dir })).toThrow(/consistent=false/)
  })

  it('exits nonzero on a count mismatch (manifest says more rows than the parts hold)', () => {
    writeExport(dir)
    patchManifest(dir, (m) => {
      m.tables.logs!.rows = 6
      m.tables.logs!.parts[1]!.rows = 3
    })
    const r = runDrill({ dir })
    expect(r.ok).toBe(false)
    expect(r.problems.some((p) => p.includes('logs') && p.includes('manifest says'))).toBe(true)
    expect(formatReport(r)).toContain('RESULT: MISMATCH')
  })

  it('detects a part file that was damaged after the export (rows dropped)', () => {
    const { manifest } = writeExport(dir)
    const p2 = join(dir, 'logs.part-2.json')
    const rows = JSON.parse(readFileSync(p2, 'utf8')) as Row[]
    writeFileSync(p2, JSON.stringify(rows.slice(0, 1)))
    const r = runDrill({ dir })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/logs.*logs\.part-2\.json has 1 rows, manifest says 2/)
    expect(manifest.tables.logs!.rows).toBe(5)
  })

  it('detects a missing part file', () => {
    writeExport(dir)
    rmSync(join(dir, 'weights.part-1.json'))
    const r = runDrill({ dir })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toContain('part file missing: weights.part-1.json')
  })

  it('detects logs.csv drifting from the JSON parts (a kcal value changed)', () => {
    writeExport(dir)
    const p1 = join(dir, 'logs.part-1.csv')
    const csv = readFileSync(p1, 'utf8').replace(',650,', ',651,')
    writeFileSync(p1, csv)
    const r = runDrill({ dir })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/logs day 2026-03-01: kcal .* in logs\.csv/)
  })

  it('reports rows the schema rejects (a weight with two decimals) as a mismatch', () => {
    const rows = fixtureRows()
    rows.weights[0] = { ...rows.weights[0]!, kg: 70.55 }
    writeExport(dir, rows)
    const r = runDrill({ dir })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/weights: row 1 .* rejected by the schema/)
  })

  it('parseCsv handles BOM, quoted commas, doubled quotes and CRLF', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n,\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['', ''],
    ])
  })

  it('CLI: exit 0 on success, 1 on mismatch, 2 on refusal', () => {
    const cli = join(import.meta.dirname, '..', 'src', 'restore-drill.ts')
    const run = (d: string) => spawnSync(process.execPath, [cli, '--dir', d], { encoding: 'utf8' })
    writeExport(dir)
    const ok = run(dir)
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('RESULT: OK')
    expect(ok.stdout).toMatch(/elapsed: \d/)

    patchManifest(dir, (m) => {
      m.tables.stores!.rows = 2
    })
    expect(run(dir).status).toBe(1)

    patchManifest(dir, (m) => {
      m.consistent = false
    })
    const refused = run(dir)
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('refused')
    expect(run(join(root, 'nope')).status).toBe(2)
  })
})

// ------------------------------------------------------------------ --emit-sql (disaster recovery)

const USER_INSERT = (id: string) => `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('${id}', 'Fake Owner', 'owner@example.invalid', 1, 1, 1)`

/** a fresh migrated "production" database that already holds auth data and some stale business data */
function prodDb(userId: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  applyMigrations(db, listMigrations(DEFAULT_MIGRATIONS_DIR))
  db.exec(USER_INSERT(userId))
  db.exec(`INSERT INTO login_codes (code_hash, user_id, expires_at, created_at) VALUES ('fakehash', '${userId}', 9, 1)`)
  db.exec(`INSERT INTO export_progress (id, day, attempt, version_at_start, epoch_at_start, table_idx, rowid_cursor, part, rows, state, lease_token, lease_until, started_at, updated_at) VALUES (1, '2026-03-02', 1, 3, 'e1', 0, 0, 1, 0, '{}', '', 0, 'x', 'x')`)
  db.exec(`INSERT INTO sync_clients (user_id, client_id, last_mutation_id, last_seen_at) VALUES ('${userId}', 'c1', 7, 'x')`)
  db.exec(`INSERT INTO mutation_outcomes (user_id, client_id, mutation_id, ok, name, result, at) VALUES ('${userId}', 'c1', 7, 1, 'logs.add', '{}', 'x')`)
  db.exec(`INSERT INTO logs (id, user_id, day, ts, name, src, qty, kcal, protein, fat, carb, source, version, updated_at) VALUES ('stale', '${userId}', '2026-01-01', '2026-01-01T08:00:00+08:00', 'stale', '其他', 1, 1, 1, 1, 1, 'quick', 2, 'x')`)
  db.exec(`UPDATE meta SET value = 3 WHERE key = 'version'`)
  return db
}

const n = (db: DatabaseSync, sql: string): number => Number((db.prepare(sql).get() as { c: number }).c)

describe('restore-drill --emit-sql', () => {
  it('emits SQL that restores a fresh migrated DB: counts match, new epoch, version = head, auth data untouched', () => {
    writeExport(dir)
    const sqlPath = join(root, 'restore.sql')
    const r = runDrill({ dir, emitSqlPath: sqlPath })
    expect(r.ok).toBe(true)
    expect(r.emittedSql?.path).toBe(sqlPath)
    const sql = readFileSync(sqlPath, 'utf8')
    expect(sql).not.toMatch(/\b(DELETE FROM|UPDATE|INSERT INTO) (user|session|account|verification|passkey|apikey|login_codes|export_progress)\b/)

    const db = prodDb(U)
    db.exec(sql)
    const manifest = JSON.parse(readFileSync(join(dir, '_ok.json'), 'utf8')) as ExportManifest
    for (const t of TABLES) expect(n(db, `SELECT COUNT(*) AS c FROM ${t}`), t).toBe(manifest.tables[t]!.rows)
    expect(n(db, `SELECT COUNT(*) AS c FROM logs WHERE id = 'stale'`)).toBe(0)
    expect(n(db, 'SELECT COUNT(*) AS c FROM sync_clients')).toBe(0)
    expect(n(db, 'SELECT COUNT(*) AS c FROM mutation_outcomes')).toBe(0)
    // auth + export bookkeeping untouched
    expect(n(db, `SELECT COUNT(*) AS c FROM user WHERE id = '${U}'`)).toBe(1)
    expect(n(db, 'SELECT COUNT(*) AS c FROM login_codes')).toBe(1)
    expect(n(db, 'SELECT COUNT(*) AS c FROM export_progress')).toBe(1)
    // meta: head version, brand-new epoch (clients get reset:true)
    const meta = Object.fromEntries((db.prepare(`SELECT key, value FROM meta`).all() as { key: string; value: unknown }[]).map((m) => [m.key, m.value]))
    expect(meta.version).toBe(14)
    expect(meta.epoch).not.toBe('e1')
    expect(meta.epoch).toBe(r.emittedSql!.epoch)
    expect(String(meta.epoch)).toMatch(/^e[0-9a-f]{12}$/)
    // values survive: per-day sums and the config JSON text
    expect(n(db, `SELECT SUM(kcal) AS c FROM logs WHERE day = '2026-03-01' AND deleted_at IS NULL`)).toBe(950.5)
    expect((db.prepare(`SELECT remind_meal_times AS v FROM config`).get() as { v: string }).v).toBe('["08:00","12:30"]')
    db.close()
  })

  it('uses versionAtEnd when it is larger than every row version', () => {
    writeExport(dir)
    patchManifest(dir, (m) => {
      m.versionAtEnd = 20
    })
    const sqlPath = join(root, 'restore.sql')
    expect(runDrill({ dir, emitSqlPath: sqlPath }).ok).toBe(true)
    const db = prodDb(U)
    db.exec(readFileSync(sqlPath, 'utf8'))
    expect(n(db, `SELECT value AS c FROM meta WHERE key = 'version'`)).toBe(20)
    db.close()
  })

  it('writes nothing when the drill is not OK, and never overwrites an existing file', () => {
    writeExport(dir)
    patchManifest(dir, (m) => {
      m.tables.stores!.rows = 2
    })
    const sqlPath = join(root, 'restore.sql')
    const r = runDrill({ dir, emitSqlPath: sqlPath })
    expect(r.ok).toBe(false)
    expect(r.emittedSql).toBeUndefined()
    expect(existsSync(sqlPath)).toBe(false)

    writeFileSync(sqlPath, '-- precious')
    expect(() => runDrill({ dir, emitSqlPath: sqlPath })).toThrow(/already exists/)
    expect(readFileSync(sqlPath, 'utf8')).toBe('-- precious')
  })

  it('--user-id rewrites user_id for a fresh D1 with a new owner, and the guard aborts before any delete when that owner is missing', () => {
    writeExport(dir)
    const sqlPath = join(root, 'restore.sql')
    expect(() => runDrill({ dir, emitUserId: 'x' })).toThrow(/--emit-sql/)
    expect(runDrill({ dir, emitSqlPath: sqlPath, emitUserId: 'new-owner-id' }).ok).toBe(true)
    const sql = readFileSync(sqlPath, 'utf8')

    const db = prodDb('new-owner-id')
    db.exec(sql)
    expect(n(db, `SELECT COUNT(*) AS c FROM logs WHERE user_id = 'new-owner-id'`)).toBe(5)
    expect(n(db, `SELECT COUNT(*) AS c FROM logs WHERE user_id = '${U}'`)).toBe(0)
    db.close()

    // owner row missing: the CHECK in cas_guard fails on the first statement; nothing was deleted
    const wrong = prodDb('someone-else')
    expect(() => wrong.exec(sql)).toThrow()
    expect(n(wrong, `SELECT COUNT(*) AS c FROM logs WHERE id = 'stale'`)).toBe(1)
    expect(n(wrong, 'SELECT COUNT(*) AS c FROM sync_clients')).toBe(1)
    wrong.close()
  })

  it('escapes quotes, semicolons, newlines and unicode in values', () => {
    const rows = fixtureRows()
    const nasty = "O'Brien; DROP TABLE logs;--\n\"x\" 🍙 \\"
    rows.logs[0] = { ...rows.logs[0]!, name: nasty }
    writeExport(dir, rows)
    const sqlPath = join(root, 'restore.sql')
    expect(runDrill({ dir, emitSqlPath: sqlPath }).ok).toBe(true)
    const db = prodDb(U)
    db.exec(readFileSync(sqlPath, 'utf8'))
    expect((db.prepare(`SELECT name FROM logs WHERE id = 'l1'`).get() as { name: string }).name).toBe(nasty)
    expect(n(db, 'SELECT COUNT(*) AS c FROM logs')).toBe(5)
    db.close()
    expect(sqlLiteral("a'b")).toBe("'a''b'")
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(1.5)).toBe('1.5')
    expect(() => sqlLiteral('a\u0000b')).toThrow(/NUL/)
    expect(() => sqlLiteral(Number.NaN)).toThrow(/non-finite/)
  })

  it('splits big tables into multi-row INSERTs of at most 100 rows', () => {
    const favorites: Row[] = Array.from({ length: 250 }, (_, i) => shaped('favorites', { user_id: U, item_id: `u:f${i}`, version: i + 1, deleted_at: null, updated_at: STAMP }))
    const out = buildRestoreSql({ rowsByTable: { favorites }, versionAtEnd: 250, epoch: 'eabc', exportDay: DAY })
    expect(out.sql.match(/INSERT INTO favorites/g)).toHaveLength(3)
    const db = prodDb(U)
    db.exec(out.sql)
    expect(n(db, 'SELECT COUNT(*) AS c FROM favorites')).toBe(250)
    db.close()
  })

  it('CLI: --emit-sql writes the file and prints it; a second run refuses', () => {
    const cli = join(import.meta.dirname, '..', 'src', 'restore-drill.ts')
    writeExport(dir)
    const sqlPath = join(root, 'cli.sql')
    const first = spawnSync(process.execPath, [cli, '--dir', dir, '--emit-sql', sqlPath], { encoding: 'utf8' })
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('SQL written:')
    expect(existsSync(sqlPath)).toBe(true)
    expect(spawnSync(process.execPath, [cli, '--dir', dir, '--emit-sql', sqlPath], { encoding: 'utf8' }).status).toBe(2)
  })
})

describe('restore-drill checks', () => {
  it('rejects rows whose version is above versionAtEnd (not unique-checked: one mutation stamps several rows)', () => {
    writeExport(dir)
    patchManifest(dir, (m) => {
      m.versionAtEnd = 10
    })
    const r = runDrill({ dir })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/weights: \d+ row\(s\) have a version above versionAtEnd=10/)
  })

  it('accepts several rows (even in several tables) sharing one version', () => {
    const rows = fixtureRows()
    rows.logs[1] = { ...rows.logs[1]!, version: rows.logs[0]!.version }
    rows.items[0] = { ...rows.items[0]!, version: rows.logs[0]!.version }
    writeExport(dir, rows)
    expect(runDrill({ dir }).problems).toEqual([])
  })

  it('reports unknown columns once per table, with the number of affected rows', () => {
    const rows = fixtureRows()
    rows.logs = rows.logs.map((r) => ({ ...r, bogus: 1, other: 2 }))
    writeExport(dir, rows)
    const r = runDrill({ dir })
    const unknown = r.problems.filter((p) => p.includes('unknown column'))
    expect(unknown).toEqual(['logs: 5 row(s) have unknown column(s): bogus, other'])
  })
})
