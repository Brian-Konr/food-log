// PRD §3.1 Kyujin 權限矩陣，表格式測試：每一格（含 owner 欄）都跑真正的 mutation，
// 並且對照 permissions.ts 的純函式。對應驗收 #3。
import { describe, expect, test } from 'vitest'
import { KYUJIN, OWNER } from '../src/actor'
import type { Actor } from '../src/actor'
import {
  canAddLogWithSource,
  canDeleteOrRestoreItem,
  canDeleteOrRestoreStore,
  canDeleteOrRestoreWeight,
  canRead,
  canSetConfig,
  canSetFavorite,
  canUpsertOverrideItem,
  canUpsertStore,
  canUpsertUserItem,
  canUpsertWeight,
  canWriteLogRow,
  isOfficialItemId,
} from '../src/permissions'
import type { PushResult } from '../src/protocol/push'
import { itemArgs, logArgs, quickLogArgs, storeArgs, weightArgs } from '../src/testing'
import type { MemoryServer } from '../src/testing'
import { newServer, row } from './helpers'

type Expected = 'ok' | 'forbidden' | 'bad_record'

type Cell = {
  /** PRD §3.1 的列 */
  cell: string
  actor: 'owner' | 'kyujin'
  /** 先用 owner 準備資料（Kyujin 沒權限建的東西） */
  setup?: (s: MemoryServer) => Promise<unknown>
  run: (s: MemoryServer, actor: Actor) => Promise<PushResult>
  expected: Expected
  /** 純函式的答案（true = 允許）。bad_record 的格不是權限問題，不填。 */
  pred?: boolean
  check?: (s: MemoryServer) => void
}

const seedStore = (s: MemoryServer) => s.mutate('stores.upsert@1', storeArgs({ id: 's:app', name: 'App 店' }))
const seedStoreItem = async (s: MemoryServer) => {
  await seedStore(s)
  await s.mutate('items.upsert@1', itemArgs({ id: 'u:store-item', store_id: 's:app' }))
}
const seedAppItem = (s: MemoryServer) => s.mutate('items.upsert@1', itemArgs({ id: 'u:app-item' }))
const seedLog = (source: 'app' | 'quick' | 'kyujin') => async (s: MemoryServer) => {
  if (source === 'kyujin') {
    await s.asKyujin('logs.add@1', { log: logArgs({ id: 'L', item_id: '', name: 'x', src: '其他', source: 'kyujin' }) })
  } else if (source === 'quick') {
    await s.mutate('logs.add@1', { log: quickLogArgs({ id: 'L' }) })
  } else {
    await s.mutate('logs.add@1', { log: logArgs({ id: 'L' }) })
  }
}
const seedDeletedLog = (source: 'app' | 'quick' | 'kyujin') => async (s: MemoryServer) => {
  await seedLog(source)(s)
  await s.mutate('logs.delete@1', { id: 'L' }) // owner 可以刪任何列
}
const seedWeight = (s: MemoryServer) => s.mutate('weights.upsert@1', weightArgs({ id: 'w1' }))
const seedDeletedWeight = async (s: MemoryServer) => {
  await seedWeight(s)
  await s.mutate('weights.delete@1', { id: 'w1' })
}

const CELLS: Cell[] = [
  // ---- 店家 ----
  { cell: '新增店家', actor: 'owner', run: (s, a) => s.mutate('stores.upsert@1', storeArgs({ id: 's:new', name: '新店' }), a), expected: 'ok', pred: true, check: (s) => expect(row(s, 'stores', 's:new').created_by).toBe('app') },
  { cell: '新增店家（created_by=kyujin）', actor: 'kyujin', run: (s, a) => s.mutate('stores.upsert@1', storeArgs({ id: 's:new', name: '新店' }), a), expected: 'ok', pred: true, check: (s) => expect(row(s, 'stores', 's:new').created_by).toBe('kyujin') },
  { cell: '改名（保留原 created_by）', actor: 'kyujin', setup: seedStore, run: (s, a) => s.mutate('stores.upsert@1', storeArgs({ id: 's:app', name: '改名後' }), a), expected: 'ok', pred: true, check: (s) => { expect(row(s, 'stores', 's:app').name).toBe('改名後'); expect(row(s, 'stores', 's:app').created_by).toBe('app') } },
  { cell: '刪除店家', actor: 'owner', setup: seedStore, run: (s, a) => s.mutate('stores.delete@1', { id: 's:app' }, a), expected: 'ok', pred: true },
  { cell: '刪除店家', actor: 'kyujin', setup: seedStore, run: (s, a) => s.mutate('stores.delete@1', { id: 's:app' }, a), expected: 'forbidden', pred: false },
  { cell: '復原店家', actor: 'owner', setup: async (s) => { await seedStore(s); await s.mutate('stores.delete@1', { id: 's:app' }) }, run: (s, a) => s.mutate('stores.restore@1', { id: 's:app' }, a), expected: 'ok', pred: true },
  { cell: '復原店家', actor: 'kyujin', setup: async (s) => { await seedStore(s); await s.mutate('stores.delete@1', { id: 's:app' }) }, run: (s, a) => s.mutate('stores.restore@1', { id: 's:app' }, a), expected: 'forbidden', pred: false },
  { cell: '復原店家（不存在也是 forbidden）', actor: 'kyujin', run: (s, a) => s.mutate('stores.restore@1', { id: 'nope' }, a), expected: 'forbidden', pred: false },

  // ---- 品項 ----
  { cell: '店家品項 upsert（新建）', actor: 'kyujin', setup: seedStore, run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'u:ks', store_id: 's:app' }), a), expected: 'ok', pred: true },
  { cell: '店家品項 upsert（App 建的）', actor: 'kyujin', setup: seedStoreItem, run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'u:store-item', store_id: 's:app', name: 'Kyujin 改' }), a), expected: 'ok', pred: true, check: (s) => expect(row(s, 'items', 'u:store-item').created_by).toBe('app') },
  { cell: '店家品項 upsert（App 建的）', actor: 'owner', setup: seedStoreItem, run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'u:store-item', store_id: 's:app', name: 'owner 改' }), a), expected: 'ok', pred: true },
  { cell: '沒有店家的 u:（自己新建）', actor: 'kyujin', run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'u:kyu' }), a), expected: 'ok', pred: true, check: (s) => expect(row(s, 'items', 'u:kyu').created_by).toBe('kyujin') },
  { cell: '沒有店家的 u:（自己建的再改）', actor: 'kyujin', setup: (s) => s.asKyujin('items.upsert@1', itemArgs({ id: 'u:kyu' })), run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'u:kyu', name: '再改' }), a), expected: 'ok', pred: true },
  { cell: '沒有店家的 u:（App 建的）', actor: 'kyujin', setup: seedAppItem, run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'u:app-item', name: '被改' }), a), expected: 'forbidden', pred: false, check: (s) => expect(row(s, 'items', 'u:app-item').name).toBe('乳清') },
  { cell: '沒有店家的 u:（App 建的）', actor: 'owner', setup: seedAppItem, run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'u:app-item', name: 'owner 改' }), a), expected: 'ok', pred: true },
  { cell: 'ov: 補填', actor: 'owner', run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'ov:fm:1', kind: '補填', base_id: 'fm:1' }), a), expected: 'ok', pred: true },
  { cell: 'ov: 補填', actor: 'kyujin', run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'ov:fm:1', kind: '補填', base_id: 'fm:1' }), a), expected: 'forbidden', pred: false },
  { cell: 'fm: 官方', actor: 'owner', run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'fm:1' }), a), expected: 'forbidden', pred: false },
  { cell: 'fm: 官方', actor: 'kyujin', run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: 'fm:1' }), a), expected: 'forbidden', pred: false },
  { cell: '711: 官方', actor: 'owner', run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: '711:abc' }), a), expected: 'forbidden', pred: false },
  { cell: '711: 官方', actor: 'kyujin', run: (s, a) => s.mutate('items.upsert@1', itemArgs({ id: '711:abc' }), a), expected: 'forbidden', pred: false },
  { cell: '刪除品項', actor: 'owner', setup: seedAppItem, run: (s, a) => s.mutate('items.delete@1', { id: 'u:app-item' }, a), expected: 'ok', pred: true },
  { cell: '刪除品項', actor: 'kyujin', setup: seedAppItem, run: (s, a) => s.mutate('items.delete@1', { id: 'u:app-item' }, a), expected: 'forbidden', pred: false },
  { cell: '復原品項', actor: 'kyujin', run: (s, a) => s.mutate('items.restore@1', { id: 'u:nope' }, a), expected: 'forbidden', pred: false },

  // ---- Logs ----
  { cell: 'Logs 新增（source=kyujin）', actor: 'kyujin', run: (s, a) => s.mutate('logs.add@1', { log: logArgs({ id: 'L', item_id: '', name: 'x', src: '其他', source: 'kyujin' }) }, a), expected: 'ok', pred: true },
  { cell: 'Logs 新增（source=app）', actor: 'kyujin', run: (s, a) => s.mutate('logs.add@1', { log: logArgs({ id: 'L', item_id: '', name: 'x', src: '其他', source: 'app' }) }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 新增（source=quick）', actor: 'kyujin', run: (s, a) => s.mutate('logs.add@1', { log: quickLogArgs({ id: 'L' }) }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 新增（沒有 source）', actor: 'kyujin', run: (s, a) => s.mutate('logs.add@1', { log: logArgs({ id: 'L' }) }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 新增（source 不認得）', actor: 'kyujin', run: (s, a) => s.mutate('logs.add@1', { log: logArgs({ id: 'L', source: 'weird' }) }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 新增（app／quick／沒有 source）', actor: 'owner', run: (s, a) => s.mutate('logs.add@1', { log: logArgs({ id: 'L' }) }, a), expected: 'ok', pred: true },
  { cell: 'Logs 新增（owner 寫 source=kyujin 是 bad_record，不是權限問題）', actor: 'owner', run: (s, a) => s.mutate('logs.add@1', { log: logArgs({ id: 'L', source: 'kyujin' }) }, a), expected: 'bad_record' },
  { cell: 'Logs 修改（kyujin 的列）', actor: 'kyujin', setup: seedLog('kyujin'), run: (s, a) => s.mutate('logs.update@1', { id: 'L', patch: { kcal: 5 } }, a), expected: 'ok', pred: true },
  { cell: 'Logs 修改（app 的列）', actor: 'kyujin', setup: seedLog('app'), run: (s, a) => s.mutate('logs.update@1', { id: 'L', patch: { kcal: 5 } }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 修改（quick 的列）', actor: 'kyujin', setup: seedLog('quick'), run: (s, a) => s.mutate('logs.update@1', { id: 'L', patch: { kcal: 5 } }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 修改（不存在）', actor: 'kyujin', run: (s, a) => s.mutate('logs.update@1', { id: 'L', patch: { kcal: 5 } }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 修改（任何列）', actor: 'owner', setup: seedLog('kyujin'), run: (s, a) => s.mutate('logs.update@1', { id: 'L', patch: { kcal: 5 } }, a), expected: 'ok', pred: true },
  { cell: 'Logs 刪除（kyujin 的列）', actor: 'kyujin', setup: seedLog('kyujin'), run: (s, a) => s.mutate('logs.delete@1', { id: 'L' }, a), expected: 'ok', pred: true },
  { cell: 'Logs 刪除（app 的列）', actor: 'kyujin', setup: seedLog('app'), run: (s, a) => s.mutate('logs.delete@1', { id: 'L' }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 刪除（quick 的列）', actor: 'kyujin', setup: seedLog('quick'), run: (s, a) => s.mutate('logs.delete@1', { id: 'L' }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 刪除（任何列）', actor: 'owner', setup: seedLog('app'), run: (s, a) => s.mutate('logs.delete@1', { id: 'L' }, a), expected: 'ok', pred: true },
  { cell: 'Logs 復原（kyujin 的列）', actor: 'kyujin', setup: seedDeletedLog('kyujin'), run: (s, a) => s.mutate('logs.restore@1', { id: 'L' }, a), expected: 'ok', pred: true },
  { cell: 'Logs 復原（app 的列）', actor: 'kyujin', setup: seedDeletedLog('app'), run: (s, a) => s.mutate('logs.restore@1', { id: 'L' }, a), expected: 'forbidden', pred: false },
  { cell: 'Logs 復原（任何列）', actor: 'owner', setup: seedDeletedLog('app'), run: (s, a) => s.mutate('logs.restore@1', { id: 'L' }, a), expected: 'ok', pred: true },
  { cell: '改 Log 的 source', actor: 'kyujin', setup: seedLog('kyujin'), run: (s, a) => s.mutate('logs.update@1', { id: 'L', patch: { source: 'app' } }, a), expected: 'bad_record' },
  { cell: '改 Log 的 source', actor: 'owner', setup: seedLog('app'), run: (s, a) => s.mutate('logs.update@1', { id: 'L', patch: { source: 'quick' } }, a), expected: 'bad_record' },

  // ---- 體重 ----
  { cell: '體重 upsert', actor: 'owner', run: (s, a) => s.mutate('weights.upsert@1', weightArgs(), a), expected: 'ok', pred: true },
  { cell: '體重 upsert', actor: 'kyujin', run: (s, a) => s.mutate('weights.upsert@1', weightArgs(), a), expected: 'ok', pred: true },
  { cell: '體重刪除', actor: 'owner', setup: seedWeight, run: (s, a) => s.mutate('weights.delete@1', { id: 'w1' }, a), expected: 'ok', pred: true },
  { cell: '體重刪除', actor: 'kyujin', setup: seedWeight, run: (s, a) => s.mutate('weights.delete@1', { id: 'w1' }, a), expected: 'forbidden', pred: false },
  { cell: '體重復原', actor: 'owner', setup: seedDeletedWeight, run: (s, a) => s.mutate('weights.restore@1', { id: 'w1' }, a), expected: 'ok', pred: true },
  { cell: '體重復原', actor: 'kyujin', setup: seedDeletedWeight, run: (s, a) => s.mutate('weights.restore@1', { id: 'w1' }, a), expected: 'forbidden', pred: false },

  // ---- 設定（與收藏：同樣只有 owner）----
  { cell: '設定', actor: 'owner', run: (s, a) => s.mutate('config.set@1', { key: 'tdee', value: '2650' }, a), expected: 'ok', pred: true },
  { cell: '設定', actor: 'kyujin', run: (s, a) => s.mutate('config.set@1', { key: 'tdee', value: '2650' }, a), expected: 'forbidden', pred: false },
  { cell: '設定（壞鍵也先 forbidden）', actor: 'kyujin', run: (s, a) => s.mutate('config.set@1', { key: 'nope', value: 'x' }, a), expected: 'forbidden', pred: false },
  { cell: '收藏', actor: 'owner', run: (s, a) => s.mutate('favorites.set@1', { item_id: 'fm:1', fav: true }, a), expected: 'ok', pred: true },
  { cell: '收藏', actor: 'kyujin', run: (s, a) => s.mutate('favorites.set@1', { item_id: 'fm:1', fav: true }, a), expected: 'forbidden', pred: false },
]

describe('PRD §3.1 權限矩陣（mutation 結果）', () => {
  test.each(CELLS.map((c) => [`${c.cell} / ${c.actor} → ${c.expected}`, c] as const))('%s', async (_name, c) => {
    const s = newServer()
    await c.setup?.(s)
    const actor = c.actor === 'owner' ? OWNER : KYUJIN
    const res = await c.run(s, actor)
    if (c.expected === 'ok') expect(res, JSON.stringify(res)).toMatchObject({ ok: true })
    else expect(res, JSON.stringify(res)).toMatchObject({ ok: false, error: c.expected })
    c.check?.(s)
  })
})

describe('permissions.ts 純函式（同一張表的另一面）', () => {
  const rows = (kind: 'owner' | 'kyujin', f: (a: Actor) => boolean, want: boolean) => expect(f(kind === 'owner' ? OWNER : KYUJIN)).toBe(want)

  test('讀取：兩邊都可以', () => {
    rows('owner', canRead, true)
    rows('kyujin', canRead, true)
  })
  test('店家：新增／改名兩邊可以；刪除、復原只有 owner', () => {
    rows('owner', canUpsertStore, true)
    rows('kyujin', canUpsertStore, true)
    rows('owner', canDeleteOrRestoreStore, true)
    rows('kyujin', canDeleteOrRestoreStore, false)
  })
  test('品項：ov: 只有 owner；刪除復原只有 owner；官方 id 誰都不行', () => {
    rows('owner', canUpsertOverrideItem, true)
    rows('kyujin', canUpsertOverrideItem, false)
    rows('owner', canDeleteOrRestoreItem, true)
    rows('kyujin', canDeleteOrRestoreItem, false)
    expect(isOfficialItemId('fm:1')).toBe(true)
    expect(isOfficialItemId('711:1')).toBe(true)
    expect(isOfficialItemId('u:1')).toBe(false)
    expect(isOfficialItemId('ov:fm:1')).toBe(false)
  })
  test('u:：Kyujin 店家品項不限；沒有店家的只能寫自己建的（新建或 created_by=kyujin）', () => {
    expect(canUpsertUserItem(OWNER, { isStoreItem: false, existingCreatedBy: 'app' })).toBe(true)
    expect(canUpsertUserItem(KYUJIN, { isStoreItem: true, existingCreatedBy: 'app' })).toBe(true)
    expect(canUpsertUserItem(KYUJIN, { isStoreItem: false, existingCreatedBy: undefined })).toBe(true)
    expect(canUpsertUserItem(KYUJIN, { isStoreItem: false, existingCreatedBy: 'kyujin' })).toBe(true)
    expect(canUpsertUserItem(KYUJIN, { isStoreItem: false, existingCreatedBy: 'app' })).toBe(false)
  })
  test('Logs：新增只限 source=kyujin；既有列只限 source=kyujin（列不存在也不行）', () => {
    expect(canAddLogWithSource(KYUJIN, 'kyujin')).toBe(true)
    for (const bad of ['app', 'quick', '', null, undefined, 'x']) expect(canAddLogWithSource(KYUJIN, bad)).toBe(false)
    expect(canAddLogWithSource(OWNER, 'app')).toBe(true)
    expect(canWriteLogRow(KYUJIN, { source: 'kyujin' })).toBe(true)
    expect(canWriteLogRow(KYUJIN, { source: 'app' })).toBe(false)
    expect(canWriteLogRow(KYUJIN, { source: 'quick' })).toBe(false)
    expect(canWriteLogRow(KYUJIN, undefined)).toBe(false)
    expect(canWriteLogRow(OWNER, { source: 'quick' })).toBe(true)
    expect(canWriteLogRow(OWNER, undefined)).toBe(true)
  })
  test('體重：upsert 兩邊可以；刪除復原只有 owner', () => {
    rows('owner', canUpsertWeight, true)
    rows('kyujin', canUpsertWeight, true)
    rows('owner', canDeleteOrRestoreWeight, true)
    rows('kyujin', canDeleteOrRestoreWeight, false)
  })
  test('設定與收藏：只有 owner', () => {
    rows('owner', canSetConfig, true)
    rows('kyujin', canSetConfig, false)
    rows('owner', canSetFavorite, true)
    rows('kyujin', canSetFavorite, false)
  })
})

test('表格覆蓋 PRD §3.1 的每一列（每列至少一個 owner 或 kyujin 的格子）', () => {
  const cells = new Set(CELLS.map((c) => c.cell.split('（')[0]))
  for (const required of ['新增店家', '改名', '刪除店家', '復原店家', '店家品項 upsert', '沒有店家的 u:', 'ov: 補填', 'fm: 官方', '711: 官方', 'Logs 新增', 'Logs 修改', 'Logs 刪除', 'Logs 復原', '改 Log 的 source', '體重 upsert', '體重刪除', '體重復原', '設定']) {
    expect(cells, required).toContain(required)
  }
})
