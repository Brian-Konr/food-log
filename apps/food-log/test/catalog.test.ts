import { expect, test } from 'vitest'
import { mergeCatalog } from '@/data/catalog'
import type { CatalogItem } from '@/types'
import { itemRow, storeRow } from './helpers'

const snap: CatalogItem[] = [{
  id: 'fm:1032099', src: 'familymart', name: '法式香草嫩雞胸', cat: '小菜', serving: '1 份（100 g）',
  servingG: 100, perPack: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}, {
  id: '711:x', src: '711', name: '義大利麵', cat: '鮮食', serving: '1 份', servingG: null, perPack: 1,
  kcal: 586, protein: null, fat: null, carb: null,
}]

test('ov: 蓋掉官方數字且標籤消失，不改原始快照', () => {
  const original = structuredClone(snap)
  const ov = itemRow({ id: 'ov:711:x', kind: '補填', base_id: '711:x', src: '7-11', name: '義大利麵', kcal: 586, protein: 20, fat: 10, carb: 50 })
  const merged = mergeCatalog(snap, [ov], [])
  const pasta = merged.find((i) => i.id === '711:x')!
  expect(pasta.needsFill).toBe(false)
  expect(pasta.override).toBe(true)
  expect(pasta.protein).toBe(20)
  expect(snap[1].protein).toBeNull()
  expect(original[1].protein).toBeNull()
})

test('收藏來自 favorites；官方收藏不產生 Items，只在合併結果', () => {
  const merged = mergeCatalog(snap, [], ['fm:1032099'])
  expect(merged.find((i) => i.id === 'fm:1032099')!.fav).toBe(true)
  expect(merged.every((i) => i.id !== 'ov:fm:1032099')).toBe(true)
})

test('自建出現在合併結果，Kyujin 標籤；收藏由 favorites 決定（不是品項上的欄位）', () => {
  const u = itemRow({ id: 'u:abc', name: '乳清', serving: '1 匙', serving_g: 30, kcal: 120, protein: 24, fat: 1, carb: 2, created_by: 'kyujin' })
  const gone = itemRow({ id: 'u:gone', name: '刪掉', deleted_at: '2026-10-10T12:00:00+08:00' })
  const merged = mergeCatalog(snap, [u, gone], ['u:abc'])
  const mine = merged.find((i) => i.id === 'u:abc')!
  expect(mine.src).toBe('custom')
  expect(mine.createdBy).toBe('kyujin')
  expect(mine.fav).toBe(true)
  expect(merged.some((i) => i.id === 'u:gone')).toBe(false)
  expect(mergeCatalog(snap, [u], []).find((i) => i.id === 'u:abc')!.fav).toBe(false)
})

test('店家品項帶店名；店家被刪的品項（cascade）不出現', () => {
  const s = storeRow({ id: 's:1', name: '阿財牛肉麵' })
  const inStore = itemRow({ id: 'u:beef', name: '牛肉麵', store_id: 's:1' })
  const cascaded = itemRow({ id: 'u:old', name: '舊品項', store_id: 's:1', deleted_at: '2026-10-10T12:00:00+08:00', cascade_of: 's:1' })
  const merged = mergeCatalog(snap, [inStore, cascaded], [], [s])
  const beef = merged.find((i) => i.id === 'u:beef')!
  expect(beef.storeId).toBe('s:1')
  expect(beef.storeName).toBe('阿財牛肉麵')
  expect(beef.needsFill).toBe(false)
  expect(merged.some((i) => i.id === 'u:old')).toBe(false)
})
