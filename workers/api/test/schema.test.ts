import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { noon, resetDb } from './helpers.ts'

const db = () => env.DB
beforeEach(resetDb)

const BUSINESS = ['stores', 'items', 'logs', 'weights', 'favorites', 'config'] as const
const AUTH = ['user', 'session', 'account', 'verification', 'passkey', 'apikey']
const SYNC = ['meta', 'cas_guard', 'sync_clients', 'mutation_outcomes', 'login_codes', 'export_progress']

type Obj = Record<string, unknown>
const run = (sql: string, ...params: unknown[]) => db().prepare(sql).bind(...params).run()

describe('migrations 0001 + 0002: sqlite_master', () => {
  it('has exactly the expected tables and every one is STRICT', async () => {
    const rs = await db()
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`)
      .all<{ name: string; sql: string }>()
    expect(rs.results.map((r) => r.name).sort()).toEqual([...BUSINESS, ...AUTH, ...SYNC].sort())
    for (const r of rs.results) expect(r.sql, r.name).toMatch(/\)\s*STRICT\s*;?\s*$/)
  })

  it('every synced business table has user_id, version, deleted_at, updated_at and a (user_id, version) index', async () => {
    for (const t of BUSINESS) {
      const cols = (await db().prepare(`SELECT name FROM pragma_table_info(?)`).bind(t).all<{ name: string }>()).results.map((c) => c.name)
      for (const c of ['user_id', 'version', 'deleted_at', 'updated_at']) expect(cols, `${t}.${c}`).toContain(c)
      const idx = (await db().prepare(`SELECT name FROM pragma_index_list(?)`).bind(t).all<{ name: string }>()).results
      const versioned = []
      for (const i of idx) {
        const ic = (await db().prepare(`SELECT name FROM pragma_index_info(?)`).bind(i.name).all<{ name: string }>()).results.map((c) => c.name)
        if (ic.join(',') === 'user_id,version') versioned.push(i.name)
      }
      expect(versioned, `${t} (user_id, version) index`).toHaveLength(1)
    }
  })

  it('the partial unique indexes exist (live store name, live weight per day)', async () => {
    const get = async (name: string) => (await db().prepare(`SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?`).bind(name).first<{ tbl_name: string; sql: string }>())!
    const s = await get('stores_user_norm_live')
    expect(s.tbl_name).toBe('stores')
    expect(s.sql).toMatch(/UNIQUE INDEX[\s\S]*\(user_id, name_norm\)[\s\S]*WHERE deleted_at IS NULL/)
    const w = await get('weights_user_day_live')
    expect(w.tbl_name).toBe('weights')
    expect(w.sql).toMatch(/UNIQUE INDEX[\s\S]*\(user_id, day\)[\s\S]*WHERE deleted_at IS NULL/)
    const l = await get('logs_user_day')
    expect(l.sql).toMatch(/\(user_id, day\)/)
  })

  it('primary keys are (user_id, id) / (user_id, item_id) / user_id', async () => {
    const pk = async (t: string) =>
      (await db().prepare(`SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`).bind(t).all<{ name: string }>()).results.map((c) => c.name).join(',')
    expect(await pk('stores')).toBe('user_id,id')
    expect(await pk('items')).toBe('user_id,id')
    expect(await pk('logs')).toBe('user_id,id')
    expect(await pk('weights')).toBe('user_id,id')
    expect(await pk('favorites')).toBe('user_id,item_id')
    expect(await pk('config')).toBe('user_id')
  })

  it('seeds meta with version 0 and an epoch', async () => {
    const rs = await db().prepare(`SELECT key, value FROM meta ORDER BY key`).all()
    expect(rs.results).toEqual([
      { key: 'epoch', value: 'e1' },
      { key: 'version', value: 0 },
    ])
  })

  it('cas_guard rejects ok = 0 with the cas_ok constraint', async () => {
    await expect(run(`INSERT INTO cas_guard (ok) VALUES (0)`)).rejects.toThrow(/cas_ok/)
  })
})

// ---------------------------------------------------------------- row builders (valid by default)
const store = (o: Obj = {}) => ({ id: 's:1', user_id: 'u1', name: '阿財牛肉麵', name_norm: '阿財牛肉麵', last_eaten_at: null, created_by: 'app', ts: noon('2026-10-11'), version: 1, deleted_at: null, updated_at: 'x', ...o })
const item = (o: Obj = {}) => ({
  id: 'u:1', user_id: 'u1', kind: '自建', base_id: null, src: '其他', name: '乳清', serving: '1 匙', serving_g: 30, kcal: 120, protein: 24, fat: 1, carb: 2,
  store_id: null, created_by: 'app', ts: 'x', cascade_of: null, version: 1, deleted_at: null, updated_at: 'x', ...o,
})
const log = (o: Obj = {}) => ({
  id: 'l1', user_id: 'u1', day: '2026-10-11', ts: noon('2026-10-11'), item_id: 'fm:1', name: '雞胸', src: '全家', qty: 1, grams: null, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
  source: 'app', store_id: null, version: 1, deleted_at: null, updated_at: 'x', ...o,
})
const weight = (o: Obj = {}) => ({ id: 'w1', user_id: 'u1', day: '2026-10-11', ts: noon('2026-10-11', '08:00'), kg: 70.5, version: 1, deleted_at: null, updated_at: 'x', ...o })
const config = (o: Obj = {}) => ({
  user_id: 'u1', target_kcal: 2000, target_protein: 150, target_fat: 60, target_carb: 200, tdee: null, remind_meal_times: '[]', remind_weight_time: null, version: 1, deleted_at: null, updated_at: 'x', ...o,
})

function insert(table: string, row: Obj) {
  const cols = Object.keys(row)
  return run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]))
}

describe('stores constraints', () => {
  it('accepts a valid row; rejects a bad id prefix, blank name, bad created_by', async () => {
    await expect(insert('stores', store())).resolves.toBeTruthy()
    await expect(insert('stores', store({ id: 'x:1', name_norm: 'a' }))).rejects.toThrow(/CHECK/)
    await expect(insert('stores', store({ id: 's:2', name: '   ', name_norm: 'b' }))).rejects.toThrow(/CHECK/)
    await expect(insert('stores', store({ id: 's:3', name_norm: 'c', created_by: 'bot' }))).rejects.toThrow(/CHECK/)
  })
  it('live name_norm is unique per user; a deleted twin and another user are fine', async () => {
    await insert('stores', store())
    await expect(insert('stores', store({ id: 's:2' }))).rejects.toThrow(/UNIQUE/)
    await expect(insert('stores', store({ id: 's:3', deleted_at: 'x' }))).resolves.toBeTruthy()
    await expect(insert('stores', store({ id: 's:4', deleted_at: 'x' }))).resolves.toBeTruthy()
    await expect(insert('stores', store({ id: 's:1', user_id: 'u2' }))).resolves.toBeTruthy() // same id, other user
  })
  it('restoring a deleted store while a live one has the same name is rejected by the index', async () => {
    await insert('stores', store())
    await insert('stores', store({ id: 's:2', deleted_at: 'x' }))
    await expect(run(`UPDATE stores SET deleted_at = NULL WHERE id = 's:2'`)).rejects.toThrow(/UNIQUE/)
  })
  it('same id twice for one user is rejected', async () => {
    await insert('stores', store())
    await expect(insert('stores', store({ name_norm: 'other' }))).rejects.toThrow(/UNIQUE|PRIMARY/)
  })
})

describe('items constraints', () => {
  it('accepts u: and ov: items', async () => {
    await expect(insert('items', item())).resolves.toBeTruthy()
    await expect(insert('items', item({ id: 'ov:fm:1', kind: '補填', base_id: 'fm:1' }))).resolves.toBeTruthy()
  })
  it('rejects official ids, wrong kind, wrong base_id', async () => {
    await expect(insert('items', item({ id: 'fm:1' }))).rejects.toThrow(/items_id_rules/)
    await expect(insert('items', item({ id: '711:x' }))).rejects.toThrow(/items_id_rules/)
    await expect(insert('items', item({ id: 'u:2', kind: '補填' }))).rejects.toThrow(/items_id_rules/)
    await expect(insert('items', item({ id: 'u:3', base_id: 'fm:1' }))).rejects.toThrow(/items_id_rules/)
    await expect(insert('items', item({ id: 'ov:fm:2', kind: '補填', base_id: 'fm:9' }))).rejects.toThrow(/items_id_rules/)
    await expect(insert('items', item({ id: 'ov:fm:3', kind: '補填', base_id: null }))).rejects.toThrow(/items_id_rules/)
    await expect(insert('items', item({ id: 'ov:fm:4', kind: '自建', base_id: 'fm:4' }))).rejects.toThrow(/items_id_rules/)
  })
  it('a store item must have src = 其他', async () => {
    await expect(insert('items', item({ id: 'u:4', store_id: 's:1', src: '全家' }))).rejects.toThrow(/items_store_src/)
    await expect(insert('items', item({ id: 'u:5', store_id: 's:1', src: '其他' }))).resolves.toBeTruthy()
    await expect(insert('items', item({ id: 'u:6', store_id: null, src: '全家' }))).resolves.toBeTruthy()
  })
  it('rejects bad enums, negative nutrition, zero serving_g, empty names', async () => {
    await expect(insert('items', item({ id: 'u:7', src: 'x' }))).rejects.toThrow(/CHECK/)
    await expect(insert('items', item({ id: 'u:8', kcal: -1 }))).rejects.toThrow(/items_nutrition/)
    await expect(insert('items', item({ id: 'u:9', serving_g: 0 }))).rejects.toThrow(/items_serving_g/)
    await expect(insert('items', item({ id: 'u:10', name: '' }))).rejects.toThrow(/items_name_not_blank/)
    await expect(insert('items', item({ id: 'u:11', serving_g: null }))).resolves.toBeTruthy()
  })
})

describe('logs constraints', () => {
  it('accepts a valid item log and a quick log', async () => {
    await expect(insert('logs', log())).resolves.toBeTruthy()
    await expect(insert('logs', log({ id: 'q1', item_id: null, name: '', src: '其他', source: 'quick', kcal: 300 }))).resolves.toBeTruthy()
  })
  it('day must be the Taipei day of ts (04:00+08:00 is still that date)', async () => {
    await expect(insert('logs', log({ id: 'ok', day: '2026-10-11', ts: noon('2026-10-11', '04:00') }))).resolves.toBeTruthy()
    await expect(insert('logs', log({ day: '2026-10-10' }))).rejects.toThrow(/logs_day_is_taipei_day/)
    await expect(insert('logs', log({ day: '2026-10-12', ts: noon('2026-10-11', '23:59') }))).rejects.toThrow(/CHECK/)
  })
  it('rejects malformed ts / day (garbage dates must not slip through as NULL)', async () => {
    await expect(insert('logs', log({ ts: '2026-10-11T12:00:00Z' }))).rejects.toThrow(/CHECK/)
    await expect(insert('logs', log({ ts: '2026-10-11T12:00:00+09:00' }))).rejects.toThrow(/CHECK/)
    await expect(insert('logs', log({ ts: 'garbage', day: 'garbage' }))).rejects.toThrow(/CHECK/)
    await expect(insert('logs', log({ day: '2026-1-11' }))).rejects.toThrow(/CHECK/)
    await expect(insert('logs', log({ ts: '2026-10-11T12:00:00.123+08:00' }))).rejects.toThrow(/CHECK/)
  })
  it('a log without an item must have the quick-log shape (qty 1, no grams, src 其他, no store)', async () => {
    const q = { item_id: null, name: '', src: '其他', source: 'quick' }
    await expect(insert('logs', log({ id: 'a', ...q, qty: 2 }))).rejects.toThrow(/logs_quick_shape/)
    await expect(insert('logs', log({ id: 'b', ...q, grams: 50 }))).rejects.toThrow(/logs_quick_shape/)
    await expect(insert('logs', log({ id: 'c', ...q, src: '全家' }))).rejects.toThrow(/logs_quick_shape/)
    await expect(insert('logs', log({ id: 'd', ...q, store_id: 's:1' }))).rejects.toThrow(/logs_quick_shape/)
    await expect(insert('logs', log({ id: 'e', ...q }))).resolves.toBeTruthy()
  })
  it('rejects bad source / src, non-positive qty or grams, negative nutrition', async () => {
    await expect(insert('logs', log({ source: 'bot' }))).rejects.toThrow(/logs_source/)
    await expect(insert('logs', log({ src: 'x' }))).rejects.toThrow(/logs_src/)
    await expect(insert('logs', log({ qty: 0 }))).rejects.toThrow(/logs_qty/)
    await expect(insert('logs', log({ grams: 0 }))).rejects.toThrow(/logs_grams/)
    await expect(insert('logs', log({ protein: -0.1 }))).rejects.toThrow(/logs_nutrition/)
  })
  it('STRICT rejects a text qty', async () => {
    await expect(insert('logs', log({ qty: 'lots' }))).rejects.toThrow()
  })
})

describe('weights constraints', () => {
  it('accepts a valid row', async () => {
    await expect(insert('weights', weight())).resolves.toBeTruthy()
  })
  it('day = taipei day of ts; malformed ts rejected', async () => {
    await expect(insert('weights', weight({ id: 'ok', day: '2026-10-11', ts: noon('2026-10-11', '04:00') }))).resolves.toBeTruthy()
    await expect(insert('weights', weight({ day: '2026-10-10' }))).rejects.toThrow(/weights_day_is_taipei_day/)
    await expect(insert('weights', weight({ ts: '2026-10-11T00:00:00Z' }))).rejects.toThrow(/CHECK/)
  })
  it.each([29.9, 250.1, 0, -1])('rejects kg out of range (%s)', async (kg) => {
    await expect(insert('weights', weight({ kg }))).rejects.toThrow(/CHECK/)
  })
  it.each([70.05, 70.123])('rejects kg with more than one decimal (%s)', async (kg) => {
    await expect(insert('weights', weight({ kg }))).rejects.toThrow(/CHECK/)
  })
  it('accepts every 0.1 step from 30.0 to 250.0 (round() is exact for them)', async () => {
    const stmts: D1PreparedStatement[] = []
    for (let i = 300; i <= 2500; i++) {
      stmts.push(
        db()
          .prepare(`INSERT INTO weights (id, user_id, day, ts, kg, version, deleted_at, updated_at) VALUES (?, 'u1', '2026-10-11', ?, ?, 1, 'x', 'x')`)
          .bind('k' + i, noon('2026-10-11', '08:00'), i / 10),
      )
    }
    expect(await db().batch(stmts)).toHaveLength(2201)
  })
  it('STRICT rejects a text kg', async () => {
    await expect(insert('weights', weight({ kg: 'heavy' }))).rejects.toThrow()
  })
  it('primary key is per user: same id for two users is fine, twice for one user is not', async () => {
    await insert('weights', weight({ id: 'same', user_id: 'u1' }))
    await expect(insert('weights', weight({ id: 'same', user_id: 'u2' }))).resolves.toBeTruthy()
    await expect(insert('weights', weight({ id: 'same', user_id: 'u1', day: '2026-10-12', ts: noon('2026-10-12') }))).rejects.toThrow(/UNIQUE|PRIMARY/)
  })
  it('partial unique index: one live row per user per day; deleted twins and other users are fine', async () => {
    await insert('weights', weight({ id: 'a' }))
    await expect(insert('weights', weight({ id: 'b' }))).rejects.toThrow(/UNIQUE/)
    await expect(insert('weights', weight({ id: 'c', deleted_at: 'x' }))).resolves.toBeTruthy()
    await expect(insert('weights', weight({ id: 'd', deleted_at: 'x' }))).resolves.toBeTruthy()
    await expect(insert('weights', weight({ id: 'e', user_id: 'u2' }))).resolves.toBeTruthy()
    await expect(run(`UPDATE weights SET deleted_at = NULL WHERE id = 'c'`)).rejects.toThrow(/UNIQUE/)
  })
})

describe('favorites / config constraints', () => {
  it('favorites: primary key (user_id, item_id); tombstones are rows', async () => {
    const fav = (o: Obj = {}) => ({ user_id: 'u1', item_id: 'fm:1', version: 1, deleted_at: null, updated_at: 'x', ...o })
    await insert('favorites', fav())
    await expect(insert('favorites', fav())).rejects.toThrow(/UNIQUE|PRIMARY/)
    await expect(insert('favorites', fav({ user_id: 'u2' }))).resolves.toBeTruthy()
    await expect(run(`UPDATE favorites SET deleted_at = 'x', version = 2 WHERE user_id = 'u1'`)).resolves.toBeTruthy()
  })
  it('config: one row per user, typed, remind_meal_times is a JSON array', async () => {
    await expect(insert('config', config())).resolves.toBeTruthy()
    await expect(insert('config', config())).rejects.toThrow(/UNIQUE|PRIMARY/)
    await expect(insert('config', config({ user_id: 'u2', remind_meal_times: '["08:00","12:30"]', tdee: 2500 }))).resolves.toBeTruthy()
    await expect(insert('config', config({ user_id: 'u3', remind_meal_times: 'not json' }))).rejects.toThrow(/CHECK/)
    await expect(insert('config', config({ user_id: 'u4', remind_meal_times: '{"a":1}' }))).rejects.toThrow(/CHECK/)
    await expect(insert('config', config({ user_id: 'u5', target_kcal: -1 }))).rejects.toThrow(/config_targets/)
    await expect(insert('config', config({ user_id: 'u6', target_kcal: 'lots' }))).rejects.toThrow()
  })
})

describe('mutation_outcomes', () => {
  it('an error row needs error and message', async () => {
    const base = { user_id: 'u1', client_id: 'c', at: 'x' }
    await expect(run(`INSERT INTO mutation_outcomes (user_id, client_id, mutation_id, ok, name, at) VALUES ('u1','c',1,0,'n','x')`)).rejects.toThrow(/CHECK/)
    await expect(insert('mutation_outcomes', { ...base, mutation_id: 2, ok: 0, name: 'n', error: 'bad_record', message: 'm' })).resolves.toBeTruthy()
    await expect(insert('mutation_outcomes', { ...base, mutation_id: 3, ok: 1, name: 'n', result: '{}' })).resolves.toBeTruthy()
    await expect(insert('mutation_outcomes', { ...base, mutation_id: 4, ok: 2, name: 'n' })).rejects.toThrow(/CHECK/)
  })
})
