import { expect, test } from 'vitest'
import { buildIndex, emptyQueryLists, frequentChips, matchScore, matchingStores, recentOrder, searchItems, indexText, norm } from '@/data/search'
import type { MergedItem, LogRecord } from '@/types'

function item(p: Partial<MergedItem> & Pick<MergedItem, 'id' | 'name'>): MergedItem {
  return {
    src: 'familymart', cat: '', serving: '1 份', servingG: 100, perPack: 1, kcal: 100,
    protein: 10, fat: 1, carb: 2, fav: false, createdBy: null, override: false, needsFill: false, sheetSrc: '全家',
    storeId: '', storeName: '',
    ...p,
  }
}

const chicken = item({ id: 'fm:1', name: '原味雞胸肉', cat: '小菜' })
const soy = item({ id: 'fm:2', name: '無糖豆漿', cat: '飲料' })
const pasta = item({ id: '711:1', name: '麻辣義大利麵', src: '711', sheetSrc: '7-11', needsFill: true, protein: null, fat: null, carb: null })
const custom = item({ id: 'u:1', name: '乳清蛋白', src: 'custom', sheetSrc: '其他', createdBy: 'kyujin', fav: true })
const indexed = buildIndex([chicken, soy, pasta, custom])

test('子字串與開頭加分', () => {
  expect(matchScore(indexText(chicken), '雞胸')).toBeGreaterThanOrEqual(100)
  expect(matchScore(indexText(item({ id: 'x', name: '雞胸沙拉' })), '雞胸')).toBe(120)
})

test('子序列「雞肉」→「雞胸肉」；順序不對不算', () => {
  expect(matchScore(indexText(chicken), '雞肉')).toBe(60)
  expect(matchScore(indexText(chicken), '肉雞')).toBe(0)
})

test('bigram 容錯', () => {
  const s = matchScore(indexText(item({ id: 'x', name: '法式香草嫩雞胸' })), '香草雞胸')
  expect(s).toBeGreaterThan(0)
})

test('收藏／最近／自建加權與前 50', () => {
  const logs: LogRecord[] = [{
    id: 'l1', ts: '2026-10-09T12:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-09',
    item_id: 'fm:1', name: chicken.name, src: '全家', qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 2,
    source: 'app', store: '',
  }]
  const recent = new Map([['fm:1', 2]])
  const hits = searchItems(indexed, '雞', { recent })
  const c = hits.find((h) => h.item.id === 'fm:1')!
  const favCustom = searchItems(indexed, '乳清')[0]
  expect(c.score).toBeGreaterThan(100)
  expect(favCustom.item.src).toBe('custom')
  expect(hits.length).toBeLessThanOrEqual(50)
})

test('分組：收藏最近 vs 店家', () => {
  const hits = searchItems(indexed, '乳清')
  expect(hits[0].group).toBe('fav-recent')
})

test('篩選膠囊不含自建', () => {
  expect(searchItems(indexed, '乳清', { filter: '711' })).toEqual([])
  expect(searchItems(indexed, '義大利', { filter: '711' }).every((h) => h.item.src === '711')).toBe(true)
  expect(searchItems(indexed, '豆漿', { filter: 'familymart' }).every((h) => h.item.src === 'familymart')).toBe(true)
})

test('空查詢兩區：收藏、最近吃過不重複', () => {
  const logs: LogRecord[] = [{
    id: 'l1', ts: '2026-10-09T12:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-09',
    item_id: 'u:1', name: custom.name, src: '其他', qty: 1, grams: null, kcal: 120, protein: 24, fat: 1, carb: 2,
    source: 'app', store: '',
  }, {
    id: 'l2', ts: '2026-10-09T13:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-09',
    item_id: 'fm:2', name: soy.name, src: '全家', qty: 1, grams: null, kcal: 132, protein: 12, fat: 4, carb: 8,
    source: 'app', store: '',
  }]
  const { fav, recent } = emptyQueryLists([chicken, soy, pasta, custom], logs, '2026-10-10')
  expect(fav.map((i) => i.id)).toEqual(['u:1'])
  expect(recent.map((i) => i.id)).toEqual(['fm:2'])
  expect(frequentChips([chicken, soy, pasta, custom], logs, '2026-10-10')[0].id).toBe('u:1')
})

test('norm 空白與標點、大小寫視為相同', () => {
  expect(norm(' 阿財牛肉麵 ')).toBe(norm('阿財・牛肉麵'))
  expect(norm('阿財牛肉麵')).toBe(norm('阿財・牛肉麵'))
  expect(norm('ABC麵')).toBe(norm('abc麵'))
})

test('店名寫進索引，打店名 matchingStores 有那家', () => {
  const beef = item({ id: 'u:beef', name: '牛肉麵', src: 'custom', sheetSrc: '其他', storeId: 's:1', storeName: '阿財牛肉麵' })
  const hits = searchItems(buildIndex([beef, chicken]), '阿財')
  expect(hits.some((h) => h.item.id === 'u:beef')).toBe(true)
  const stores = matchingStores([{ id: 's:1', ts: '', deleted: false, updated_at: '', name: '阿財牛肉麵', last_eaten_at: '', created_by: 'app' }], '阿財')
  expect(stores.map((s) => s.id)).toEqual(['s:1'])
})

test('篩選 store 只留有 storeId 的；餐廳品項 group 是 fav-recent', () => {
  const beef = item({ id: 'u:beef', name: '牛肉麵', src: 'custom', sheetSrc: '其他', storeId: 's:1', storeName: '阿財' })
  const indexed = buildIndex([beef, chicken])
  expect(searchItems(indexed, '牛肉', { filter: 'store' }).every((h) => h.item.storeId !== '')).toBe(true)
  expect(searchItems(indexed, '雞胸', { filter: 'store' })).toEqual([])
  expect(searchItems(indexed, '牛肉')[0].group).toBe('fav-recent')
})

test('item_id 空的 Log 不進 recentOrder', () => {
  const logs: LogRecord[] = [{
    id: 'q', ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-10',
    item_id: '', name: '', src: '其他', qty: 1, grams: null, kcal: 100, protein: 1, fat: 1, carb: 1, source: 'quick', store: '',
  }, {
    id: 'l', ts: '2026-10-10T13:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-10',
    item_id: 'fm:1', name: chicken.name, src: '全家', qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 2, source: 'app', store: '',
  }]
  expect(recentOrder(logs, '2026-10-10')).toEqual(['fm:1'])
})
