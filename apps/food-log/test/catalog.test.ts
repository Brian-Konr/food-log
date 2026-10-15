import { expect, test } from 'vitest'
import { mergeCatalog } from '@/data/catalog'
import type { CatalogItem, ItemRecord } from '@/types'

const snap: CatalogItem[] = [{
  id: 'fm:1032099', src: 'familymart', name: '法式香草嫩雞胸', cat: '小菜', serving: '1 份（100 g）',
  servingG: 100, perPack: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}, {
  id: '711:x', src: '711', name: '義大利麵', cat: '鮮食', serving: '1 份', servingG: null, perPack: 1,
  kcal: 586, protein: null, fat: null, carb: null,
}]

test('ov: 蓋掉官方數字且標籤消失，不改原始快照', () => {
  const original = structuredClone(snap)
  const ov: ItemRecord = {
    id: 'ov:711:x', ts: '', deleted: false, updated_at: '', kind: '補填', base_id: '711:x', src: '7-11',
    name: '義大利麵', serving: '1 份', serving_g: null, kcal: 586, protein: 20, fat: 10, carb: 50, fav: false, created_by: 'app', store: '',
  }
  const merged = mergeCatalog(snap, [ov], [])
  const pasta = merged.find((i) => i.id === '711:x')!
  expect(pasta.needsFill).toBe(false)
  expect(pasta.override).toBe(true)
  expect(pasta.protein).toBe(20)
  expect(snap[1].protein).toBeNull()
  expect(original[1].protein).toBeNull()
})

test('fav_ids 不產生 Items；官方收藏只在合併結果', () => {
  const merged = mergeCatalog(snap, [], ['fm:1032099'])
  expect(merged.find((i) => i.id === 'fm:1032099')!.fav).toBe(true)
  expect(merged.every((i) => i.id !== 'ov:fm:1032099')).toBe(true)
})

test('自建出現在合併結果，Kyujin 標籤', () => {
  const u: ItemRecord = {
    id: 'u:abc', ts: '', deleted: false, updated_at: '', kind: '自建', base_id: '', src: '其他',
    name: '乳清', serving: '1 匙', serving_g: 30, kcal: 120, protein: 24, fat: 1, carb: 2, fav: true, created_by: 'kyujin', store: '',
  }
  const merged = mergeCatalog(snap, [u, { ...u, id: 'u:gone', deleted: true, name: '刪掉' }], [])
  const mine = merged.find((i) => i.id === 'u:abc')!
  expect(mine.src).toBe('custom')
  expect(mine.createdBy).toBe('kyujin')
  expect(mine.fav).toBe(true)
  expect(merged.some((i) => i.id === 'u:gone')).toBe(false)
})
