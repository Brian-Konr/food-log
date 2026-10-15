import { describe, expect, test, vi } from 'vitest'
import { dumpCommand, dumpQueries, fromSql, parseDumpText, splitStatements } from '../src/dump.ts'
import { emitSql } from '../src/emit-sql.ts'
import { transform } from '../src/transform.ts'
import { OWNER, T, d1Sqlite, dumpOf, sheetItem, sheetLog, sheetStore, sheetWeight, snap } from './helpers.ts'

const imported = () => {
  const r = transform(
    snap({
      stores: [sheetStore()],
      items: [sheetItem({ fav: true })],
      logs: [sheetLog({ name: "it's; a 'test'\nline" })],
      weights: [sheetWeight()],
      config: { remind_meal_times: '08:00,18:00', fav_ids: 'fm:1' },
    }),
    { userId: OWNER },
  )
  const db = d1Sqlite()
  for (const f of emitSql(r)) db.exec(f.sql)
  return db
}

describe('wrangler --json output (statement results tagged with _t)', () => {
  test('parses the array of result sets, including empty tables and the meta rows', () => {
    const db = imported()
    const sets = dumpQueries().map((q) => ({ results: db.prepare(q).all(), success: true, meta: {} }))
    const dump = parseDumpText(JSON.stringify(sets))
    expect(dump).toEqual(dumpOf(db))
    expect(dump.meta.version).toBeGreaterThan(0)
    expect(dump.tables.config[0]!.remind_meal_times).toEqual(['08:00', '18:00'])
  })
  test('a failed statement or an untagged row is an error, not silent data loss', () => {
    expect(() => parseDumpText(JSON.stringify([{ results: [], success: false }]))).toThrow(/failed/)
    expect(() => parseDumpText(JSON.stringify([{ results: [{ id: 'x' }], success: true }]))).toThrow(/_t/)
    expect(() => parseDumpText('{"hello": 1}')).toThrow(/unrecognised/)
  })
  test('the normalised {meta,tables} form is accepted as it is', () => {
    const d = parseDumpText(JSON.stringify({ meta: { version: 4, epoch: 'e9' }, tables: { logs: [{ id: 'a' }] } }))
    expect(d.meta).toEqual({ version: 4, epoch: 'e9' })
    expect(d.tables.logs).toEqual([{ id: 'a' }])
    expect(d.tables.stores).toEqual([])
  })
})

describe('SQL text (wrangler d1 export)', () => {
  const sql = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE meta (key TEXT PRIMARY KEY, value ANY NOT NULL) STRICT;
INSERT INTO "meta" VALUES('version',12);
INSERT INTO "meta" VALUES('epoch','m1x');
CREATE TABLE weights (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kg REAL NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_id, id),
  CONSTRAINT kg CHECK (kg >= 30 AND kg <= 250)
) STRICT;
-- a comment; with a semicolon
INSERT INTO "weights" VALUES('w1','u1',70.5,NULL);
INSERT INTO "weights" VALUES('w;2','u1',71,'2026-10-10T07:00:00+08:00');
INSERT INTO weights (id, user_id, kg, deleted_at) VALUES ('w3', 'u1', 72, NULL), ('it''s', 'u1', 73.25, NULL);
CREATE TABLE config (user_id TEXT NOT NULL PRIMARY KEY, remind_meal_times TEXT NOT NULL);
INSERT INTO "config" VALUES('u1','["08:00"]');
INSERT INTO "sync_clients" VALUES('u1','dev',3,'x');
`
  test('reads INSERTs with or without a column list, quotes, semicolons in strings, multi-row VALUES', () => {
    const d = fromSql(sql)
    expect(d.meta).toEqual({ version: 12, epoch: 'm1x' })
    expect(d.tables.weights.map((w) => [w.id, w.kg, w.deleted_at])).toEqual([
      ['w1', 70.5, null],
      ['w;2', 71, '2026-10-10T07:00:00+08:00'],
      ['w3', 72, null],
      ["it's", 73.25, null],
    ])
    expect(d.tables.config[0]).toEqual({ user_id: 'u1', remind_meal_times: ['08:00'] })
  })
  test('auto-detected by parseDumpText; tables that are not business tables are ignored', () => {
    expect(parseDumpText(sql).tables.weights).toHaveLength(4)
  })
  test('SQL input warns on stderr that it is experimental; JSON input does not', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    parseDumpText(sql)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('SQL dump input is experimental; prefer the JSON dump from d1-dump-command'))
    spy.mockClear()
    parseDumpText('{"meta":{"version":1,"epoch":"e"},"tables":{}}')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  test('an INSERT without columns and without a CREATE TABLE is an error', () => {
    expect(() => fromSql(`INSERT INTO "logs" VALUES('a',1);`)).toThrow(/no column list/)
  })
  test('splitStatements respects quotes and comments', () => {
    expect(splitStatements(`SELECT 'a;b'; -- x;y\nSELECT 2;`)).toEqual([`SELECT 'a;b'`, 'SELECT 2'])
  })
})

test('the dump command is printed for remote (⛔) and local, read-only SELECTs only, no tokens', () => {
  const remote = dumpCommand({ db: 'food-log', local: false })
  expect(remote).toContain('--remote --json --command')
  expect(dumpCommand({ db: 'food-log', local: true })).toContain('--local')
  expect(dumpQueries()).toHaveLength(7)
  expect(dumpQueries().every((q) => q.startsWith('SELECT'))).toBe(true)
  expect(remote).not.toMatch(/INSERT|UPDATE|DELETE|DROP/)
  void T
})
