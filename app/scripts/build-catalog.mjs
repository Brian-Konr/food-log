#!/usr/bin/env node
/**
 * 從全家列表＋明細 jsonl、7-11 xml 產生 public/catalog-v1.json。
 * 來源目錄不存在：exit 1，不要編造品項。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parseNote, flattenFamList, isFiniteNumber } from './catalog-note.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

export { parseNote, flattenFamList }

export function parseFamDetails(jsonlText) {
  const map = new Map()
  for (const line of String(jsonlText).split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (o && o.cmno != null) map.set(String(o.cmno), o)
    } catch { /* skip */ }
  }
  return map
}

export function buildFamilyMart(listDoc, detailsMap) {
  const items = []
  for (const it of flattenFamList(listDoc)) {
    const note = parseNote(it.NOTE)
    const det = detailsMap.get(it.CMNO)
    const id = 'fm:' + it.CMNO
    const cat = it.CATEGORY_NAME
    const name = it.PRODNAME
    if (det) {
      const kcal = isFiniteNumber(det.kcal) ? det.kcal : note.kcal
      const protein = isFiniteNumber(det.protein) ? det.protein : null
      const fat = isFiniteNumber(det.fat) ? det.fat : null
      const carb = isFiniteNumber(det.carb) ? det.carb : null
      if (kcal == null) continue
      const complete = protein != null && fat != null && carb != null
      items.push({
        id, src: 'familymart', name, cat,
        serving: note.serving, servingG: note.servingG, perPack: note.perPack,
        kcal,
        protein: complete ? protein : null,
        fat: complete ? fat : null,
        carb: complete ? carb : null,
      })
      continue
    }
    if (note.kcal == null) continue
    items.push({
      id, src: 'familymart', name, cat,
      serving: note.serving, servingG: note.servingG, perPack: note.perPack,
      kcal: note.kcal, protein: null, fat: null, carb: null,
    })
  }
  return items
}

export function parseSevenXml(xmlText) {
  const items = []
  const re = /<Item>([\s\S]*?)<\/Item>/g
  let m
  while ((m = re.exec(xmlText))) {
    const block = m[1]
    const tag = (name) => {
      const t = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))
      return t ? t[1].trim() : ''
    }
    items.push({ name: tag('name'), kcal: tag('kcal'), content: tag('content') })
  }
  return items
}

export function sevenId(name) {
  return '711:' + createHash('sha1').update(String(name), 'utf8').digest('hex').slice(0, 10)
}

export function buildSevenEleven(xmlFiles) {
  const items = []
  const seen = new Set()
  for (const xml of xmlFiles) {
    for (const it of parseSevenXml(xml)) {
      const kcal = it.kcal === '' ? NaN : Number(it.kcal)
      if (!Number.isFinite(kcal)) continue
      const name = it.name
      if (seen.has(name)) continue
      seen.add(name)
      items.push({
        id: sevenId(name),
        src: '711',
        name,
        cat: '鮮食',
        serving: '1 份',
        servingG: null,
        perPack: 1,
        kcal,
        protein: null,
        fat: null,
        carb: null,
      })
    }
  }
  return items
}

export function assembleCatalog(famItems, sevenItems) {
  const items = [...famItems, ...sevenItems].sort((a, b) => a.id.localeCompare(b.id))
  return { version: '2026-10-10', items }
}

function main() {
  const famListPath = arg('--fam-list')
  const famDetailsPath = arg('--fam-details')
  const sevenDir = arg('--seven-dir')
  const out = arg('--out', 'public/catalog-v1.json')
  if (!famListPath || !existsSync(famListPath)) {
    console.error('找不到全家列表：' + (famListPath || '(未指定 --fam-list)'))
    process.exit(1)
  }
  if (!famDetailsPath || !existsSync(famDetailsPath)) {
    console.error('找不到全家明細：' + (famDetailsPath || '(未指定 --fam-details)'))
    process.exit(1)
  }
  if (!sevenDir || !existsSync(sevenDir)) {
    console.error('找不到 7-11 目錄：' + (sevenDir || '(未指定 --seven-dir)'))
    process.exit(1)
  }
  const listDoc = JSON.parse(readFileSync(famListPath, 'utf8'))
  const details = parseFamDetails(readFileSync(famDetailsPath, 'utf8'))
  const famItems = buildFamilyMart(listDoc, details)
  const xmls = []
  for (let i = 0; i <= 21; i++) {
    const p = `${sevenDir.replace(/\/$/, '')}/711_${i}.xml`
    if (!existsSync(p)) {
      console.warn('缺少 ' + p + '，跳過')
      continue
    }
    xmls.push(readFileSync(p, 'utf8'))
  }
  const sevenItems = buildSevenEleven(xmls)
  const catalog = assembleCatalog(famItems, sevenItems)
  writeFileSync(out, JSON.stringify(catalog))
  console.log(`[build-catalog] ${catalog.items.length} 筆 → ${out}`)
}

if (process.argv[1] && process.argv[1].endsWith('build-catalog.mjs')) {
  main()
}
