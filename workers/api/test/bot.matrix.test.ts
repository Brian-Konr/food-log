// PRD 3.1 Kyujin permission matrix, end to end over HTTP (acceptance #3): every cell runs the real route.
//   owner cells  -> POST /sync/push (session cookie)
//   Kyujin cells -> POST /bot/v1/mutate (Bearer key)
// Setup is always done as the owner. Expected: ok -> 200 {ok:true}; forbidden -> 403; bad_record -> 400.
import { env } from 'cloudflare:workers'
import { BOT_MUTATION_NAMES } from '@food-log/core'
import { beforeEach, describe, expect, test } from 'vitest'
import { call, itemArgs, login, logArgs, mintBotKey, mut, pushOk, quickLogArgs, resetDb, storeArgs, weightArgs } from './helpers.ts'

let cookie: string
let key: string
let nextId = 0
beforeEach(async () => {
  await resetDb()
  const u = await login()
  cookie = u.cookie
  key = (await mintBotKey(u.userId)).key
  nextId = 0
})

type Outcome = { ok: boolean; status: number; error?: string; result?: Record<string, unknown> }

const owner = async (name: string, args: unknown): Promise<Outcome> => {
  const out = await pushOk(cookie, 'matrix-owner', mut(++nextId, name, args))
  const r = out.results[0]!
  return r.ok ? { ok: true, status: 200, result: r.result } : { ok: false, status: 0, error: r.error }
}
const bot = async (name: string, args: unknown): Promise<Outcome> => {
  const res = await call('/bot/v1/mutate', { method: 'POST', bearer: key, json: { name, args } })
  const b = (await res.json()) as { ok: boolean; error?: string; result?: Record<string, unknown> }
  return { ok: b.ok, status: res.status, error: b.error, result: b.result }
}

const row = async (table: string, id: string) => (await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>())!

const seedStore = () => owner('stores.upsert@1', storeArgs('s:app', 'App 店'))
const seedStoreItem = async () => {
  await seedStore()
  await owner('items.upsert@1', itemArgs('u:store-item', { store_id: 's:app' }))
}
const seedAppItem = () => owner('items.upsert@1', itemArgs('u:app-item'))
const seedLog = (source: 'app' | 'quick' | 'kyujin') => async () => {
  if (source === 'kyujin') await bot('logs.add@1', { log: logArgs('L', { item_id: '', name: 'x', src: '其他', source: 'kyujin' }) })
  else if (source === 'quick') await owner('logs.add@1', { log: quickLogArgs('L') })
  else await owner('logs.add@1', { log: logArgs('L') })
}
const seedDeletedLog = (source: 'app' | 'quick' | 'kyujin') => async () => {
  await seedLog(source)()
  await owner('logs.delete@1', { id: 'L' })
}
const seedWeight = () => owner('weights.upsert@1', weightArgs('w1', 72, '2026-10-11'))
const seedDeletedWeight = async () => {
  await seedWeight()
  await owner('weights.delete@1', { id: 'w1' })
}

type Expected = 'ok' | 'forbidden' | 'bad_record'
type Cell = {
  cell: string
  actor: 'owner' | 'kyujin'
  setup?: () => Promise<unknown>
  run: (a: (name: string, args: unknown) => Promise<Outcome>) => Promise<Outcome>
  expected: Expected
  check?: () => Promise<void>
}

const CELLS: Cell[] = [
  // ---- stores ----
  { cell: '新增店家', actor: 'owner', run: (a) => a('stores.upsert@1', storeArgs('s:new', '新店')), expected: 'ok', check: async () => expect((await row('stores', 's:new')).created_by).toBe('app') },
  { cell: '新增店家（created_by=kyujin）', actor: 'kyujin', run: (a) => a('stores.upsert@1', storeArgs('s:new', '新店')), expected: 'ok', check: async () => expect((await row('stores', 's:new')).created_by).toBe('kyujin') },
  { cell: '改名（保留原 created_by）', actor: 'kyujin', setup: seedStore, run: (a) => a('stores.upsert@1', storeArgs('s:app', '改名後')), expected: 'ok', check: async () => { const r = await row('stores', 's:app'); expect(r.name).toBe('改名後'); expect(r.created_by).toBe('app') } },
  { cell: '刪除店家', actor: 'owner', setup: seedStore, run: (a) => a('stores.delete@1', { id: 's:app' }), expected: 'ok' },
  { cell: '刪除店家', actor: 'kyujin', setup: seedStore, run: (a) => a('stores.delete@1', { id: 's:app' }), expected: 'forbidden', check: async () => expect((await row('stores', 's:app')).deleted_at).toBeNull() },
  { cell: '復原店家', actor: 'owner', setup: async () => { await seedStore(); await owner('stores.delete@1', { id: 's:app' }) }, run: (a) => a('stores.restore@1', { id: 's:app' }), expected: 'ok' },
  { cell: '復原店家', actor: 'kyujin', setup: async () => { await seedStore(); await owner('stores.delete@1', { id: 's:app' }) }, run: (a) => a('stores.restore@1', { id: 's:app' }), expected: 'forbidden', check: async () => expect((await row('stores', 's:app')).deleted_at).not.toBeNull() },
  { cell: '復原店家（不存在也是 forbidden）', actor: 'kyujin', run: (a) => a('stores.restore@1', { id: 'nope' }), expected: 'forbidden' },

  // ---- items ----
  { cell: '店家品項 upsert（新建）', actor: 'kyujin', setup: seedStore, run: (a) => a('items.upsert@1', itemArgs('u:ks', { store_id: 's:app' })), expected: 'ok', check: async () => expect((await row('items', 'u:ks')).created_by).toBe('kyujin') },
  { cell: '店家品項 upsert（App 建的）', actor: 'kyujin', setup: seedStoreItem, run: (a) => a('items.upsert@1', itemArgs('u:store-item', { store_id: 's:app', name: 'Kyujin 改' })), expected: 'ok', check: async () => { const r = await row('items', 'u:store-item'); expect(r.name).toBe('Kyujin 改'); expect(r.created_by).toBe('app') } },
  { cell: '店家品項 upsert（App 建的）', actor: 'owner', setup: seedStoreItem, run: (a) => a('items.upsert@1', itemArgs('u:store-item', { store_id: 's:app', name: 'owner 改' })), expected: 'ok' },
  { cell: '沒有店家的 u:（自己新建）', actor: 'kyujin', run: (a) => a('items.upsert@1', itemArgs('u:kyu')), expected: 'ok', check: async () => expect((await row('items', 'u:kyu')).created_by).toBe('kyujin') },
  { cell: '沒有店家的 u:（自己建的再改）', actor: 'kyujin', setup: () => bot('items.upsert@1', itemArgs('u:kyu')), run: (a) => a('items.upsert@1', itemArgs('u:kyu', { name: '再改' })), expected: 'ok' },
  { cell: '沒有店家的 u:（App 建的）', actor: 'kyujin', setup: seedAppItem, run: (a) => a('items.upsert@1', itemArgs('u:app-item', { name: '被改' })), expected: 'forbidden', check: async () => expect((await row('items', 'u:app-item')).name).toBe('乳清') },
  { cell: '沒有店家的 u:（App 建的）', actor: 'owner', setup: seedAppItem, run: (a) => a('items.upsert@1', itemArgs('u:app-item', { name: 'owner 改' })), expected: 'ok' },
  { cell: 'ov: 補填', actor: 'owner', run: (a) => a('items.upsert@1', itemArgs('ov:fm:1', { kind: '補填', base_id: 'fm:1' })), expected: 'ok' },
  { cell: 'ov: 補填', actor: 'kyujin', run: (a) => a('items.upsert@1', itemArgs('ov:fm:1', { kind: '補填', base_id: 'fm:1' })), expected: 'forbidden' },
  { cell: 'fm: 官方', actor: 'owner', run: (a) => a('items.upsert@1', itemArgs('fm:1')), expected: 'forbidden' },
  { cell: 'fm: 官方', actor: 'kyujin', run: (a) => a('items.upsert@1', itemArgs('fm:1')), expected: 'forbidden' },
  { cell: '711: 官方', actor: 'owner', run: (a) => a('items.upsert@1', itemArgs('711:abc')), expected: 'forbidden' },
  { cell: '711: 官方', actor: 'kyujin', run: (a) => a('items.upsert@1', itemArgs('711:abc')), expected: 'forbidden' },
  { cell: '刪除品項', actor: 'owner', setup: seedAppItem, run: (a) => a('items.delete@1', { id: 'u:app-item' }), expected: 'ok' },
  { cell: '刪除品項', actor: 'kyujin', setup: seedAppItem, run: (a) => a('items.delete@1', { id: 'u:app-item' }), expected: 'forbidden', check: async () => expect((await row('items', 'u:app-item')).deleted_at).toBeNull() },
  { cell: '復原品項', actor: 'kyujin', run: (a) => a('items.restore@1', { id: 'u:nope' }), expected: 'forbidden' },

  // ---- logs ----
  { cell: 'Logs 新增（source=kyujin）', actor: 'kyujin', run: (a) => a('logs.add@1', { log: logArgs('L', { item_id: '', name: 'x', src: '其他', source: 'kyujin' }) }), expected: 'ok', check: async () => expect((await row('logs', 'L')).source).toBe('kyujin') },
  { cell: 'Logs 新增（source=app）', actor: 'kyujin', run: (a) => a('logs.add@1', { log: logArgs('L', { item_id: '', name: 'x', src: '其他', source: 'app' }) }), expected: 'forbidden' },
  { cell: 'Logs 新增（source=quick）', actor: 'kyujin', run: (a) => a('logs.add@1', { log: quickLogArgs('L') }), expected: 'forbidden' },
  { cell: 'Logs 新增（沒有 source）', actor: 'kyujin', run: (a) => a('logs.add@1', { log: logArgs('L') }), expected: 'forbidden' },
  { cell: 'Logs 新增（source 不認得）', actor: 'kyujin', run: (a) => a('logs.add@1', { log: logArgs('L', { source: 'weird' }) }), expected: 'forbidden' },
  { cell: 'Logs 新增（app／quick／沒有 source）', actor: 'owner', run: (a) => a('logs.add@1', { log: logArgs('L') }), expected: 'ok', check: async () => expect((await row('logs', 'L')).source).toBe('app') },
  { cell: 'Logs 新增（owner 寫 source=kyujin 是 bad_record）', actor: 'owner', run: (a) => a('logs.add@1', { log: logArgs('L', { source: 'kyujin' }) }), expected: 'bad_record' },
  { cell: 'Logs 修改（kyujin 的列）', actor: 'kyujin', setup: seedLog('kyujin'), run: (a) => a('logs.update@1', { id: 'L', patch: { kcal: 5 } }), expected: 'ok', check: async () => expect((await row('logs', 'L')).kcal).toBe(5) },
  { cell: 'Logs 修改（app 的列）', actor: 'kyujin', setup: seedLog('app'), run: (a) => a('logs.update@1', { id: 'L', patch: { kcal: 5 } }), expected: 'forbidden', check: async () => expect((await row('logs', 'L')).kcal).toBe(106) },
  { cell: 'Logs 修改（quick 的列）', actor: 'kyujin', setup: seedLog('quick'), run: (a) => a('logs.update@1', { id: 'L', patch: { kcal: 5 } }), expected: 'forbidden' },
  { cell: 'Logs 修改（不存在）', actor: 'kyujin', run: (a) => a('logs.update@1', { id: 'L', patch: { kcal: 5 } }), expected: 'forbidden' },
  { cell: 'Logs 修改（任何列）', actor: 'owner', setup: seedLog('kyujin'), run: (a) => a('logs.update@1', { id: 'L', patch: { kcal: 5 } }), expected: 'ok' },
  { cell: 'Logs 刪除（kyujin 的列）', actor: 'kyujin', setup: seedLog('kyujin'), run: (a) => a('logs.delete@1', { id: 'L' }), expected: 'ok', check: async () => expect((await row('logs', 'L')).deleted_at).not.toBeNull() },
  { cell: 'Logs 刪除（app 的列）', actor: 'kyujin', setup: seedLog('app'), run: (a) => a('logs.delete@1', { id: 'L' }), expected: 'forbidden', check: async () => expect((await row('logs', 'L')).deleted_at).toBeNull() },
  { cell: 'Logs 刪除（quick 的列）', actor: 'kyujin', setup: seedLog('quick'), run: (a) => a('logs.delete@1', { id: 'L' }), expected: 'forbidden' },
  { cell: 'Logs 刪除（任何列）', actor: 'owner', setup: seedLog('app'), run: (a) => a('logs.delete@1', { id: 'L' }), expected: 'ok' },
  { cell: 'Logs 復原（kyujin 的列）', actor: 'kyujin', setup: seedDeletedLog('kyujin'), run: (a) => a('logs.restore@1', { id: 'L' }), expected: 'ok', check: async () => expect((await row('logs', 'L')).deleted_at).toBeNull() },
  { cell: 'Logs 復原（app 的列）', actor: 'kyujin', setup: seedDeletedLog('app'), run: (a) => a('logs.restore@1', { id: 'L' }), expected: 'forbidden' },
  { cell: 'Logs 復原（任何列）', actor: 'owner', setup: seedDeletedLog('app'), run: (a) => a('logs.restore@1', { id: 'L' }), expected: 'ok' },
  { cell: '改 Log 的 source', actor: 'kyujin', setup: seedLog('kyujin'), run: (a) => a('logs.update@1', { id: 'L', patch: { source: 'app' } }), expected: 'bad_record' },
  { cell: '改 Log 的 source', actor: 'owner', setup: seedLog('app'), run: (a) => a('logs.update@1', { id: 'L', patch: { source: 'quick' } }), expected: 'bad_record' },

  // ---- weights ----
  { cell: '體重 upsert', actor: 'owner', run: (a) => a('weights.upsert@1', weightArgs('w1', 72, '2026-10-11')), expected: 'ok' },
  { cell: '體重 upsert', actor: 'kyujin', run: (a) => a('weights.upsert@1', weightArgs('w1', 72, '2026-10-11')), expected: 'ok' },
  { cell: '體重刪除', actor: 'owner', setup: seedWeight, run: (a) => a('weights.delete@1', { id: 'w1' }), expected: 'ok' },
  { cell: '體重刪除', actor: 'kyujin', setup: seedWeight, run: (a) => a('weights.delete@1', { id: 'w1' }), expected: 'forbidden', check: async () => expect((await row('weights', 'w1')).deleted_at).toBeNull() },
  { cell: '體重復原', actor: 'owner', setup: seedDeletedWeight, run: (a) => a('weights.restore@1', { id: 'w1' }), expected: 'ok' },
  { cell: '體重復原', actor: 'kyujin', setup: seedDeletedWeight, run: (a) => a('weights.restore@1', { id: 'w1' }), expected: 'forbidden' },

  // ---- 設定與收藏（Kyujin 沒有這兩個路徑：allow-list 擋下）----
  { cell: '設定', actor: 'owner', run: (a) => a('config.set@1', { key: 'tdee', value: '2650' }), expected: 'ok' },
  { cell: '設定', actor: 'kyujin', run: (a) => a('config.set@1', { key: 'tdee', value: '2650' }), expected: 'forbidden', check: async () => expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM config`).first()).toEqual({ n: 0 }) },
  { cell: '設定（壞鍵也先 forbidden）', actor: 'kyujin', run: (a) => a('config.set@1', { key: 'nope', value: 'x' }), expected: 'forbidden' },
  { cell: '收藏', actor: 'owner', run: (a) => a('favorites.set@1', { item_id: 'fm:1', fav: true }), expected: 'ok' },
  { cell: '收藏', actor: 'kyujin', run: (a) => a('favorites.set@1', { item_id: 'fm:1', fav: true }), expected: 'forbidden', check: async () => expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM favorites`).first()).toEqual({ n: 0 }) },
]

describe('PRD §3.1 Kyujin 權限矩陣（HTTP 端到端）', () => {
  test.each(CELLS.map((c) => [`${c.cell} / ${c.actor} → ${c.expected}`, c] as const))('%s', async (_n, c) => {
    await c.setup?.()
    const res = await c.run(c.actor === 'owner' ? owner : bot)
    if (c.expected === 'ok') {
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true })
      if (c.actor === 'kyujin') expect(res.status).toBe(200)
    } else {
      expect(res, JSON.stringify(res)).toMatchObject({ ok: false, error: c.expected })
      if (c.actor === 'kyujin') expect(res.status).toBe(c.expected === 'forbidden' ? 403 : 400)
    }
    await c.check?.()
  })
})

describe('the mutate allow-list is exactly the seven names of PRD 8', () => {
  test('BOT_MUTATION_NAMES', () => {
    expect([...BOT_MUTATION_NAMES].sort()).toEqual(['items.upsert@1', 'logs.add@1', 'logs.delete@1', 'logs.restore@1', 'logs.update@1', 'stores.upsert@1', 'weights.upsert@1'])
  })
  test('anything else is forbidden before it is even looked at (unknown names, other versions, unversioned)', async () => {
    for (const name of ['stores.delete@1', 'items.restore@1', 'config.set@1', 'favorites.set@1', 'weights.delete@1', 'logs.add@2', 'logs.add', 'nope@1', '__proto__']) {
      const res = await bot(name, {})
      expect(res, name).toMatchObject({ ok: false, error: 'forbidden', status: 403 })
    }
  })
})
