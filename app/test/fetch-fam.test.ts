import { expect, test } from 'vitest'
// @ts-expect-error plain .mjs script
import { nutrientsFromDetail } from '../scripts/fetch-fam-details.mjs'

test('nutrientsFromDetail 讀全家 QueryFsProductByItem 的巢狀 LIST[0].NUTRIENTS', () => {
  const res = { RESULT_CODE: '00', LIST: [{ CMNO: '1', NUTRIENTS: [{ PROTEIN: 20.8, TOTALFAT: 1.5, CARBOHYDRATE: 2.3 }] }] }
  expect(nutrientsFromDetail(res)).toEqual({ protein: 20.8, fat: 1.5, carb: 2.3 })
})

test('nutrientsFromDetail 也接受直接帶 NUTRIENTS，缺值給 null', () => {
  expect(nutrientsFromDetail({ NUTRIENTS: [{ PROTEIN: 0, TOTALFAT: '', CARBOHYDRATE: null }] })).toEqual({ protein: 0, fat: null, carb: null })
  expect(nutrientsFromDetail({ LIST: [] })).toEqual({ protein: null, fat: null, carb: null })
})
