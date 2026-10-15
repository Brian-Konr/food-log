import { describe, expect, test } from 'vitest'
import { TABLES } from '@food-log/core'
import type { Table } from '@food-log/core'
import { COLUMNS, MAX_ROWS_PER_VERSION, PK, chunkRows, emitSql, newEpoch, sqlLiteral, upsertSql, wranglerCommands } from '../src/emit-sql.ts'
import { transform } from '../src/transform.ts'
import { OWNER, T, d1Sqlite, dayBack, dumpOf, sheetItem, sheetLog, sheetStore, sheetWeight, snap } from './helpers.ts'

const small = () =>
  transform(
    snap({
      stores: [sheetStore({ last_eaten_at: T('2026-10-09') })],
      items: [sheetItem({ fav: true }), sheetItem({ id: 'u:store', store: 's:a' })],
      logs: [sheetLog({ name: "O'Brien's\nstew; DROP TABLE logs;--" }), sheetLog({ id: 'l2', item_id: '', name: 'Quick', source: 'quick' })],
      weights: [sheetWeight()],
      config: { fav_ids: 'fm:1', remind_meal_times: '08:00,18:00', remind_weight_time: '07:30', tdee: '2300' },
    }),
    { userId: OWNER },
  )

function manyLogs(n: number) {
  const logs = Array.from({ length: n }, (_, i) => {
    const day = dayBack(i % 400)
    return sheetLog({ id: `l${String(i).padStart(5, '0')}`, day, ts: T(day, '12:00'), kcal: 100 + (i % 50) })
  })
  return transform(snap({ logs }), { userId: OWNER })
}

test('sqlLiteral quotes, NULL, numbers and control characters', () => {
  expect(sqlLiteral(null)).toBe('NULL')
  expect(sqlLiteral(undefined)).toBe('NULL')
  expect(sqlLiteral(12.5)).toBe('12.5')
  expect(sqlLiteral("a'b")).toBe("'a''b'")
  expect(sqlLiteral('a\nb')).toBe("'a' || char(10) || 'b'")
  expect(sqlLiteral('\u0000x')).toBe("char(0) || 'x'")
  expect(() => sqlLiteral(NaN)).toThrow()
})

test('the column lists equal the real D1 schema (migrations 0001+0002) minus user_id and version', () => {
  const db = d1Sqlite()
  for (const t of TABLES) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name).filter((c) => c !== 'user_id' && c !== 'version')
    expect([...COLUMNS[t]].sort(), t).toEqual(cols.sort())
    const pk = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[]).filter((c) => c.pk > 0 && c.name !== 'user_id').map((c) => c.name)
    expect([...PK[t]].sort(), `${t} pk`).toEqual(pk.sort())
  }
})

describe('chunks and versions', () => {
  test('at most 500 rows per version, per table; one chunk = one version bump', () => {
    const r = manyLogs(1201)
    const chunks = chunkRows(r)
    expect(chunks.filter((c) => c.table === 'logs').map((c) => c.rows.length)).toEqual([500, 500, 201])
    expect(MAX_ROWS_PER_VERSION).toBe(500)
    const files = emitSql(r)
    const sql = files.map((f) => f.sql).join('')
    expect(sql.match(/UPDATE meta SET value = value \+ 1/g)).toHaveLength(chunks.length)
    expect(files.reduce((n, f) => n + f.versions, 0)).toBe(chunks.length)
  })
  test('applied to an empty D1: versions go 1..n, every chunk stamped with its own version, ≤500 rows each', () => {
    const r = manyLogs(1201)
    const db = d1Sqlite()
    for (const f of emitSql(r)) db.exec(f.sql)
    const dump = dumpOf(db)
    const nChunks = chunkRows(r).length
    expect(dump.meta.version).toBe(nChunks)
    const perVersion = new Map<number, number>()
    for (const row of dump.tables.logs) perVersion.set(Number(row.version), (perVersion.get(Number(row.version)) ?? 0) + 1)
    expect([...perVersion.values()].sort((a, b) => b - a)).toEqual([500, 500, 201])
    // versions are strictly the ones after the bumps: logs come after config? no - table order stores, items, logs, weights, favorites, config
    expect(Math.max(...perVersion.keys())).toBe(nChunks - 1)
  })
  test('a transform result with nothing but config still emits one version', () => {
    const files = emitSql(transform(snap(), { userId: OWNER }))
    expect(files).toHaveLength(1)
    expect(files[0]!.versions).toBe(1)
  })
})

describe('applies cleanly to the real D1 schema', () => {
  test('all six tables, with the CHECK constraints and partial unique indexes of migration 0001', () => {
    const r = small()
    const db = d1Sqlite()
    for (const f of emitSql(r)) db.exec(f.sql)
    const dump = dumpOf(db)
    expect(dump.tables.stores).toHaveLength(1)
    expect(dump.tables.items).toHaveLength(2)
    expect(dump.tables.logs).toHaveLength(2)
    expect(dump.tables.weights).toHaveLength(1)
    expect(dump.tables.favorites.map((f) => f.item_id).sort()).toEqual(['fm:1', 'u:soy'])
    expect(dump.tables.config).toHaveLength(1)
    expect(dump.tables.config[0]).toMatchObject({ target_kcal: 2000, tdee: 2300, remind_meal_times: ['08:00', '18:00'], remind_weight_time: '07:30' })
    for (const t of TABLES) for (const row of dump.tables[t]) expect(row.user_id).toBe(OWNER)
    // the hostile name survived as data
    expect(dump.tables.logs.find((l) => l.id === 'l1')!.name).toBe("O'Brien's\nstew; DROP TABLE logs;--")
  })
  test('the transform repairs make quirky rows importable (every D1 CHECK passes)', () => {
    const r = transform(
      snap({
        stores: [sheetStore({ id: 's:a', name: 'Cafe' }), sheetStore({ id: 's:b', name: 'CAFE' })],
        items: [sheetItem({ id: 'ov:fm:9', kind: '自建', base_id: 'x', store: 's:a', src: '全家' }), sheetItem({ id: 'u:2', src: 'zzz', serving: '', name: '', serving_g: 0 })],
        logs: [sheetLog({ id: 'q', item_id: '', qty: 3, grams: 10, src: '全家', store: 's:a', day: '2000-01-01', ts: '2026-10-10T17:30:00Z', kcal: 'x' })],
        weights: [sheetWeight({ id: '' }), sheetWeight({ id: 'dup', ts: T('2026-10-10', '21:00') }), sheetWeight({ id: 'r', day: '2026-10-11', ts: T('2026-10-11'), kg: 70.46 })],
      }),
      { userId: OWNER },
    )
    const db = d1Sqlite()
    for (const f of emitSql(r)) db.exec(f.sql)
    expect(dumpOf(db).tables.weights.filter((w) => w.deleted_at === null)).toHaveLength(2)
  })
})

describe('upserts and re-runs', () => {
  test('importing the same result twice changes nothing but the version; a changed row is overwritten', () => {
    const r = small()
    const db = d1Sqlite()
    const files = emitSql(r)
    for (const f of files) db.exec(f.sql)
    const first = dumpOf(db)
    for (const f of files) db.exec(f.sql)
    const second = dumpOf(db)
    for (const t of TABLES) expect(second.tables[t].length).toBe(first.tables[t].length)
    const strip = (rows: Record<string, unknown>[]) => rows.map(({ version: _v, ...x }) => x)
    for (const t of TABLES) expect(strip(second.tables[t])).toEqual(strip(first.tables[t]))
    expect(second.meta.version).toBe(first.meta.version * 2)
    // a later Sheet edit comes through
    const edited = transform(snap({ logs: [sheetLog({ kcal: 999 })], config: { target_kcal: '1700' } }), { userId: OWNER })
    for (const f of emitSql(edited)) db.exec(f.sql)
    const third = dumpOf(db)
    expect(third.tables.logs.find((l) => l.id === 'l1')!.kcal).toBe(999)
    expect(third.tables.config[0]!.target_kcal).toBe(1700)
  })
  test('upsert statement shape: ON CONFLICT on the table keys, version from meta', () => {
    const r = small()
    expect(upsertSql('logs', OWNER, r.logs[0]! as never)).toMatch(/ON CONFLICT \(user_id, id\) DO UPDATE SET .*version = excluded\.version;$/)
    expect(upsertSql('favorites', OWNER, r.favorites[0]! as never)).toMatch(/ON CONFLICT \(user_id, item_id\)/)
    expect(upsertSql('config', OWNER, r.config as never)).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/)
    expect(upsertSql('logs', OWNER, r.logs[0]! as never)).toContain(`(SELECT value FROM meta WHERE key = 'version')`)
  })
  test('one statement per line, no transaction statements', () => {
    const sql = emitSql(small()).map((f) => f.sql).join('').split('\n').filter((l) => !l.startsWith('--')).join('\n')
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i)
    for (const line of sql.split('\n').filter((l) => l && !l.startsWith('--'))) expect(line.endsWith(';')).toBe(true)
    expect(sql).not.toContain('\r')
  })
})

describe('--reset', () => {
  test('deletes the owner rows of the six tables and writes a new epoch; other users and sync state are left alone', () => {
    const db = d1Sqlite()
    for (const f of emitSql(small())) db.exec(f.sql)
    db.exec(`INSERT INTO weights (id, user_id, day, ts, kg, version, deleted_at, updated_at) VALUES ('w-other', 'someone-else', '2026-10-10', '2026-10-10T07:00:00+08:00', 60, 1, NULL, '2026-10-10T07:00:00+08:00')`)
    db.exec(`INSERT INTO sync_clients (user_id, client_id, last_mutation_id, last_seen_at) VALUES ('${OWNER}', 'dev1', 7, 'x')`)
    const before = dumpOf(db).meta
    const r2 = transform(snap({ logs: [sheetLog({ id: 'only-new' })] }), { userId: OWNER })
    for (const f of emitSql(r2, { reset: true, epoch: 'mNEWEPOCH' })) db.exec(f.sql)
    const dump = dumpOf(db)
    expect(dump.tables.logs.map((l) => l.id)).toEqual(['only-new'])
    expect(dump.tables.stores).toHaveLength(0)
    expect(dump.tables.favorites).toHaveLength(0)
    expect(dump.tables.weights.map((w) => w.id)).toEqual(['w-other'])
    expect(dump.meta.epoch).toBe('mNEWEPOCH')
    expect(dump.meta.epoch).not.toBe(before.epoch)
    expect(dump.meta.version).toBeGreaterThan(before.version)
    expect(db.prepare('SELECT last_mutation_id FROM sync_clients').get()).toEqual({ last_mutation_id: 7 })
  })
  test('needs an epoch; newEpoch is derived from the clock', () => {
    expect(() => emitSql(small(), { reset: true })).toThrow(/epoch/)
    expect(newEpoch(1_800_000_000_000)).toBe(newEpoch(1_800_000_000_000))
    expect(newEpoch(1)).not.toBe(newEpoch(2))
  })
})

describe('file splitting', () => {
  test('files stay under --max-bytes (split only between versions), are numbered, and apply in order to the same result', () => {
    const r = manyLogs(1500)
    const one = emitSql(r, { maxFileBytes: 10_000_000 })
    expect(one).toHaveLength(1)
    const many = emitSql(r, { maxFileBytes: 450_000 })
    expect(many.length).toBeGreaterThan(2)
    for (const f of many) expect(Buffer.byteLength(f.sql)).toBeLessThanOrEqual(450_000)
    expect(many[0]!.name).toBe(`import-001-of-${String(many.length).padStart(3, '0')}.sql`)
    expect(many.reduce((n, f) => n + f.rows, 0)).toBe(one[0]!.rows)
    const a = d1Sqlite()
    const b = d1Sqlite()
    for (const f of one) a.exec(f.sql)
    for (const f of many) b.exec(f.sql)
    expect(dumpOf(b)).toEqual(dumpOf(a))
  })
  test('a reset file comes first; a single oversized version still gets its own file', () => {
    const r = manyLogs(600)
    const files = emitSql(r, { reset: true, epoch: 'mX', maxFileBytes: 1000 })
    expect(files[0]!.sql).toContain('DELETE FROM logs')
    expect(files.length).toBeGreaterThanOrEqual(3)
  })
})

test('wrangler commands are printed, never run; remote vs local', () => {
  const [remote] = wranglerCommands(['/abs/out/import-001-of-001.sql'], { db: 'food-log', local: false })
  expect(remote).toContain('d1 execute food-log --remote --file')
  expect(wranglerCommands(['/x.sql'], { db: 'food-log', local: true })[0]).toContain('--local --file')
  expect(remote).not.toMatch(/https?:\/\//)
})

test('all six tables are covered by the importer', () => {
  const covered = new Set<Table>(chunkRows(small()).map((c) => c.table))
  expect([...covered].sort()).toEqual([...TABLES].sort())
})
