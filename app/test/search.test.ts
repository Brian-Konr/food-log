import { expect, test } from 'vitest'
import { buildIndex, emptyQueryLists, frequentChips, matchScore, searchItems, indexText } from '@/data/search'
import type { MergedItem, LogRecord } from '@/types'

function item(p: Partial<MergedItem> & Pick<MergedItem, 'id' | 'name'>): MergedItem {
  return {
    src: 'familymart', cat: '', serving: '1 份', servingG: 100, perPack: 1, kcal: 100,
    protein: 10, fat: 1, carb: 2, fav: false, createdBy: null, override: false, needsFill: false, sheetSrc: '全家',
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
  }, {
    id: 'l2', ts: '2026-10-09T13:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-09',
    item_id: 'fm:2', name: soy.name, src: '全家', qty: 1, grams: null, kcal: 132, protein: 12, fat: 4, carb: 8,
  }]
  const { fav, recent } = emptyQueryLists([chicken, soy, pasta, custom], logs, '2026-10-10')
  expect(fav.map((i) => i.id)).toEqual(['u:1'])
  expect(recent.map((i) => i.id)).toEqual(['fm:2'])
  expect(frequentChips([chicken, soy, pasta, custom], logs, '2026-10-10')[0].id).toBe('u:1')
})
