import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { assembleCatalog, buildFamilyMart, buildSevenEleven, parseFamDetails, sevenId } from '../scripts/build-catalog.mjs'

const dir = resolve(import.meta.dirname, 'fixtures/catalog-src')

test('fixture xml/json 解析、空白 kcal 被丟、同名留第一筆、sha1 前 10 碼、缺明細三項 null', () => {
  const list = JSON.parse(readFileSync(resolve(dir, 'fam_all.json'), 'utf8'))
  const details = parseFamDetails(readFileSync(resolve(dir, 'fam_details.jsonl'), 'utf8'))
  const fam = buildFamilyMart(list, details)
  const chicken = fam.find((i: { id: string }) => i.id === 'fm:1032099')
  expect(chicken.protein).toBe(20.8)
  expect(chicken.kcal).toBe(106)
  const onlyKcal = fam.find((i: { id: string }) => i.id === 'fm:9999999')
  expect(onlyKcal.kcal).toBe(90)
  expect(onlyKcal.protein).toBeNull()
  expect(onlyKcal.fat).toBeNull()
  expect(onlyKcal.carb).toBeNull()

  const xml0 = readFileSync(resolve(dir, '711_0.xml'), 'utf8')
  const xml1 = readFileSync(resolve(dir, '711_1.xml'), 'utf8')
  const seven = buildSevenEleven([xml0, xml1])
  expect(seven.some((i: { name: string }) => i.name === '空白熱量便當')).toBe(false)
  const pasta = seven.find((i: { name: string }) => i.name === '晶英-麻辣奶油鮮蝦義大利麵')
  expect(pasta.kcal).toBe(586)
  const hex = createHash('sha1').update('晶英-麻辣奶油鮮蝦義大利麵', 'utf8').digest('hex').slice(0, 10)
  expect(pasta.id).toBe('711:' + hex)
  expect(sevenId('晶英-麻辣奶油鮮蝦義大利麵')).toBe('711:' + hex)
  expect(seven.filter((i: { name: string }) => i.name === '晶英-麻辣奶油鮮蝦義大利麵')).toHaveLength(1)
  expect(seven.some((i: { name: string }) => i.name === '茶葉蛋')).toBe(true)
  const cat = assembleCatalog(fam, seven)
  expect(cat.version).toBe('2026-10-10')
  const ids = cat.items.map((i: { id: string }) => i.id)
  expect([...ids].sort()).toEqual(ids)
})

test('parseSevenXml 接受帶屬性的 <Item>（真的 7-11 XML 長這樣）', async () => {
  const { parseSevenXml } = await import('../scripts/build-catalog.mjs')
  const xml = '<BD><Item IType="images/a.png"  onMobile="0"  ><name>飯糰</name><kcal>210</kcal></Item></BD>'
  const items = parseSevenXml(xml)
  if (items.length !== 1 || items[0].name !== '飯糰' || items[0].kcal !== '210') throw new Error(JSON.stringify(items))
})
