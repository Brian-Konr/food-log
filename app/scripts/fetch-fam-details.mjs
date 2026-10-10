#!/usr/bin/env node
/**
 * 只定義輸入輸出。不要把全家網址寫死。
 *
 * node scripts/fetch-fam-details.mjs --input <fam_all.json> --output <fam_details.jsonl>
 *
 * FAM_ITEM_URL 未設定：印「尚未設定 FAM_ITEM_URL，不打網路」，exit 0。
 * 有設定時，URL 裡的 {cmno} 換成該筆 CMNO。每請求間隔 ≥500 ms。逾時 20 秒。
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { parseNote, flattenFamList } from './catalog-note.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

export function nutrientsFromDetail(json) {
  const n = json && json.NUTRIENTS && json.NUTRIENTS[0] ? json.NUTRIENTS[0] : {}
  const num = (v) => {
    if (v === '' || v == null) return null
    const x = Number(v)
    return Number.isFinite(x) ? x : null
  }
  return { protein: num(n.PROTEIN), fat: num(n.TOTALFAT), carb: num(n.CARBOHYDRATE) }
}

export function existingCmnos(jsonlText) {
  const set = new Set()
  for (const line of String(jsonlText).split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (o && o.cmno != null) set.add(String(o.cmno))
    } catch { /* skip bad line */ }
  }
  return set
}

async function main() {
  const input = arg('--input', '/workspace/food-research/fam_all.json')
  const output = arg('--output', '/workspace/food-research/fam_details.jsonl')
  const urlTpl = process.env.FAM_ITEM_URL
  if (!urlTpl) {
    console.log('尚未設定 FAM_ITEM_URL，不打網路')
    process.exit(0)
  }
  const doc = JSON.parse(readFileSync(input, 'utf8'))
  const items = flattenFamList(doc)
  const have = existsSync(output) ? existingCmnos(readFileSync(output, 'utf8')) : new Set()
  for (const it of items) {
    if (have.has(it.CMNO)) continue
    const url = urlTpl.replace('{cmno}', encodeURIComponent(it.CMNO))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20_000)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) {
        console.error(`HTTP ${res.status} cmno=${it.CMNO}`)
        continue
      }
      let json
      try { json = await res.json() }
      catch {
        console.error(`JSON 解析失敗 cmno=${it.CMNO}`)
        continue
      }
      const noteParsed = parseNote(it.NOTE)
      const nut = nutrientsFromDetail(json)
      const row = {
        cmno: it.CMNO,
        name: it.PRODNAME,
        cat: it.CATEGORY_NAME,
        note: it.NOTE,
        kcal: noteParsed.kcal,
        protein: nut.protein,
        fat: nut.fat,
        carb: nut.carb,
      }
      appendFileSync(output, JSON.stringify(row) + '\n')
      have.add(it.CMNO)
    } catch (err) {
      console.error(`失敗 cmno=${it.CMNO} ${err && err.message ? err.message : err}`)
    } finally {
      clearTimeout(timer)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

if (process.argv[1] && process.argv[1].endsWith('fetch-fam-details.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
