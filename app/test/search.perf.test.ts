import { expect, test } from 'vitest'
import { buildIndex, searchItems } from '@/data/search'
import type { MergedItem } from '@/types'

const CHARS = '雞胸肉豆漿優格便當沙拉麵包乳清鮪魚飯糰蔬菜水果起司豆腐'

function makeItems(n: number): MergedItem[] {
  const items: MergedItem[] = []
  for (let i = 0; i < n; i++) {
    let name = ''
    let x = i
    for (let k = 0; k < 4; k++) { name += CHARS[x % CHARS.length]; x = Math.floor(x / CHARS.length) + i * 3 + k }
    items.push({
      id: `fm:${i}`, src: 'familymart', name, cat: '鮮食', serving: '1 份', servingG: 100, perPack: 1,
      kcal: 100 + (i % 400), protein: 10, fat: 5, carb: 20, fav: i % 17 === 0, createdBy: null, override: false,
      needsFill: false, sheetSrc: '全家', storeId: '', storeName: '',
    })
  }
  return items
}

test('5,000 筆，1–4 字各 50 次，p95 < 30 ms', () => {
  const indexed = buildIndex(makeItems(5000))
  const queries = ['雞', '雞胸', '雞胸肉', '原味雞胸']
  const times: number[] = []
  for (const q of queries) {
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now()
      searchItems(indexed, q)
      times.push(performance.now() - t0)
    }
  }
  times.sort((a, b) => a - b)
  const p95 = times[Math.floor(times.length * 0.95)]
  expect(p95).toBeLessThan(30)
})

test('5,000 筆再加 300 個店家品項，p95 仍 < 30 ms', () => {
  const items = makeItems(5000)
  for (let i = 0; i < 300; i++) {
    items.push({
      id: `u:s${i}`, src: 'custom', name: `店品${i}`, cat: '', serving: '1 份', servingG: null, perPack: 1,
      kcal: 200, protein: 10, fat: 5, carb: 20, fav: false, createdBy: 'app', override: false,
      needsFill: false, sheetSrc: '其他', storeId: `s:${i % 30}`, storeName: `店家${i % 30}`,
    })
  }
  const indexed = buildIndex(items)
  const times: number[] = []
  for (const q of ['雞', '店品', '店家1']) {
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now()
      searchItems(indexed, q)
      times.push(performance.now() - t0)
    }
  }
  times.sort((a, b) => a - b)
  expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(30)
})
