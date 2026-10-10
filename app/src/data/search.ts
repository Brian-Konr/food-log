import type { LogRecord, MergedItem, SearchFilter, SearchHit, StoreRecord } from '@/types'
import { addDays } from '@/lib/day'

const PUNCT = /[\s\-·・（）()【】[\]、，。．/／]/g

export function norm(s: string): string {
  return String(s).normalize('NFKC').toLowerCase().replace(PUNCT, '')
}

export function brandPrefix(item: Pick<MergedItem, 'src'>): string {
  if (item.src === 'familymart') return '全家'
  if (item.src === '711') return '711' + '7-11'
  if (item.src === 'custom') return '自建'
  return ''
}

export function indexText(item: Pick<MergedItem, 'src' | 'name' | 'cat'> & { storeName?: string }): string {
  return norm(brandPrefix(item) + (item.storeName ?? '') + item.name + item.cat)
}

function isSubsequence(hay: string, needle: string): boolean {
  let i = 0
  for (let h = 0; h < hay.length && i < needle.length; h++) {
    if (hay[h] === needle[i]) i += 1
  }
  return i === needle.length
}

function bigrams(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return out
}

const INDEX_PREFIXES = ['全家', '711711', '自建']

function queryAtStart(index: string, query: string): boolean {
  if (index.startsWith(query)) return true
  for (const p of INDEX_PREFIXES) {
    if (index.startsWith(p) && index.slice(p.length).startsWith(query)) return true
  }
  return false
}

export function matchScore(index: string, query: string): number {
  if (!query) return 0
  if (index.includes(query)) return 100 + (queryAtStart(index, query) ? 20 : 0)
  if (isSubsequence(index, query)) return 60
  if (query.length >= 3) {
    const qb = bigrams(query)
    if (!qb.length) return 0
    const ib = new Set(bigrams(index))
    let hit = 0
    for (const b of qb) if (ib.has(b)) hit += 1
    const ratio = hit / qb.length
    if (ratio >= 0.5) return 40 * ratio
  }
  return 0
}

export function recentCounts(logs: Iterable<Pick<LogRecord, 'deleted' | 'item_id' | 'day'>>, today: string, days = 14): Map<string, number> {
  const from = addDays(today, -(days - 1))
  const map = new Map<string, number>()
  for (const l of logs) {
    if (l.deleted) continue
    if (!l.item_id) continue
    if (l.day < from || l.day > today) continue
    map.set(l.item_id, (map.get(l.item_id) ?? 0) + 1)
  }
  return map
}

export function recentOrder(logs: Iterable<Pick<LogRecord, 'deleted' | 'item_id' | 'day' | 'ts'>>, today: string, days = 14): string[] {
  const from = addDays(today, -(days - 1))
  const last = new Map<string, string>()
  for (const l of logs) {
    if (l.deleted) continue
    if (!l.item_id) continue
    if (l.day < from || l.day > today) continue
    const prev = last.get(l.item_id)
    if (!prev || l.ts > prev) last.set(l.item_id, l.ts)
  }
  return [...last.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id)
}

function passesFilter(item: MergedItem, filter: SearchFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'fav') return item.fav
  if (filter === 'store') return item.storeId !== ''
  if (filter === '711') return item.src === '711'
  if (filter === 'familymart') return item.src === 'familymart'
  return true
}

export function matchingStores(
  stores: StoreRecord[],
  query: string,
): StoreRecord[] {
  const q = norm(query)
  if (!q) return []
  return stores.filter((s) => {
    if (s.deleted) return false
    const n = norm(s.name)
    return matchScore(n, q) > 0
  })
}

export type IndexedItem = { item: MergedItem; text: string }

export function buildIndex(items: MergedItem[]): IndexedItem[] {
  return items.map((item) => ({ item, text: indexText({ ...item, storeName: item.storeName }) }))
}

export function searchItems(
  indexed: IndexedItem[],
  query: string,
  opts: { filter?: SearchFilter; recent?: Map<string, number> } = {},
): SearchHit[] {
  const q = norm(query)
  if (!q) return []
  const filter = opts.filter ?? 'all'
  const recent = opts.recent ?? new Map<string, number>()
  const hits: SearchHit[] = []
  for (const { item, text } of indexed) {
    if (!passesFilter(item, filter)) continue
    const base = matchScore(text, q)
    if (base <= 0) continue
    const times = recent.get(item.id) ?? 0
    const extra = times > 0 ? Math.min(20, Math.max(0, times - 1) * 2) : 0
    const score = base + (item.fav ? 50 : 0) + (times > 0 ? 30 + extra : 0) + (item.src === 'custom' ? 10 : 0)
    if (score <= 0) continue
    const inFavRecent = item.fav || times > 0 || item.src === 'custom'
    hits.push({ item, score, group: inFavRecent ? 'fav-recent' : 'store' })
  }
  hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'zh-Hant'))
  return hits.slice(0, 50)
}

export function emptyQueryLists(
  items: MergedItem[],
  logs: Iterable<Pick<LogRecord, 'deleted' | 'item_id' | 'day' | 'ts'>>,
  today: string,
): { fav: MergedItem[]; recent: MergedItem[] } {
  const byId = new Map(items.map((i) => [i.id, i]))
  const fav = items.filter((i) => i.fav).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  const favIds = new Set(fav.map((i) => i.id))
  const recent: MergedItem[] = []
  for (const id of recentOrder(logs, today)) {
    if (favIds.has(id)) continue
    const item = byId.get(id)
    if (item) recent.push(item)
  }
  return { fav, recent }
}

export function frequentChips(
  items: MergedItem[],
  logs: Iterable<Pick<LogRecord, 'deleted' | 'item_id' | 'day' | 'ts'>>,
  today: string,
  limit = 6,
): MergedItem[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const out: MergedItem[] = []
  const seen = new Set<string>()
  const favs = items.filter((i) => i.fav).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  for (const i of favs) {
    if (seen.has(i.id)) continue
    seen.add(i.id)
    out.push(i)
    if (out.length >= limit) return out
  }
  for (const id of recentOrder(logs, today)) {
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (!item) continue
    seen.add(id)
    out.push(item)
    if (out.length >= limit) return out
  }
  return out
}
