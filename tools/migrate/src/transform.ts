// transform: Sheet snapshot (v1) -> D1 rows (v2). PURE: no I/O, no clock, no environment. Deterministic for a given input.
//
// What it does (plan 4 stage 3 step 2, PRD 11.2):
//   deleted -> deleted_at (= updated_at)        '' -> NULL                          store -> store_id
//   fav_ids (official items) + items.fav (u: items) -> favorites rows
//   Config strings -> typed config (remind_meal_times -> array)
//   ts -> canonical Taipei ISO "YYYY-MM-DDTHH:MM:SS+08:00"; day = taipeiDay(ts) (the Sheet's day is corrected, not trusted)
//   weight without id -> w:<day>; several live weights on one day -> the newest stays live, the others are deleted
//   stores.name_norm = core normName; items.cascade_of = NULL (the Sheet never recorded it)
// Everything above that CHANGES a value, plus every row that D1 would reject, is recorded in anomalies[] (types.ts), so that
// verify can compute the expected counts / sums "minus anomalies" and Brian can read exactly what was adjusted.
// D1 has CHECK constraints the Sheet never had, so rows that would violate one are repaired (and recorded) or dropped (and recorded):
// a single bad row must not make the whole import fail.
//
// The owner user_id is a parameter: it is never hard-coded and never appears in the rows (emit-sql / loaders stamp it).
import { DEFAULT_CONFIG_VALUES, normName, taipeiDay, taipeiIso } from '@food-log/core'
import type { RowInput, Table } from '@food-log/core'
import type { Anomaly, SheetRecord, SheetSnapshot } from './types.ts'

export interface TransformOptions {
  /** the single owner's user id (D1 user.id); passed through to the result, never defaulted */
  userId: string
}

export interface TransformResult {
  userId: string
  stores: RowInput<'stores'>[]
  items: RowInput<'items'>[]
  logs: RowInput<'logs'>[]
  weights: RowInput<'weights'>[]
  favorites: RowInput<'favorites'>[]
  config: RowInput<'config'>
  anomalies: Anomaly[]
  /** rows read from the Sheet vs rows produced, per table */
  counts: Record<'stores' | 'items' | 'logs' | 'weights', { in: number; out: number }>
}

// ------------------------------------------------------------------ small parsers

const SRC_OK = ['7-11', '全家', '其他']
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const CANON_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/

/** v1 `isDeleted_`, plus the lower-case spelling. */
export function sheetDeleted(r: SheetRecord): boolean {
  const d = r.deleted
  return d === true || (typeof d === 'string' && d.trim().toUpperCase() === 'TRUE')
}

/** Finite number from a number or a numeric string; undefined for '', null, NaN, text. */
export function sheetNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())

/**
 * Canonical Taipei ISO for a timestamp string, or null when it cannot be understood.
 * A timestamp WITHOUT a zone is read as Taipei time (never as the machine's local time); a bare date is Taipei midnight.
 */
export function canonicalTs(v: unknown): string | null {
  let s = text(v)
  if (s === '') return null
  if (CANON_TS.test(s) && !Number.isNaN(Date.parse(s))) return s
  if (ISO_DAY.test(s)) s = `${s}T00:00:00+08:00`
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + '+08:00'
  else if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null
  const ms = Date.parse(s.replace(' ', 'T'))
  return Number.isNaN(ms) ? null : taipeiIso(Math.floor(ms / 1000) * 1000)
}

const dayOfCanon = (ts: string): string => taipeiDay(new Date(Date.parse(ts)))

// ------------------------------------------------------------------ anomaly collector

class Collector {
  readonly list: Anomaly[] = []
  private readonly merge = new Map<string, Anomaly>()

  drop(table: Table, index: number | null, id: string, code: string, detail: string): void {
    this.list.push({ table, index, id, kind: 'dropped', code, detail })
  }

  /** One anomaly per (row, code); several fields of the same code go into one `changes` object. */
  fix(table: Table, index: number | null, id: string, code: string, detail: string, field: string, from: unknown, to: unknown): void {
    const key = `${table}|${index}|${code}`
    const existing = this.merge.get(key)
    if (existing) {
      existing.changes![field] = { from, to }
      return
    }
    const a: Anomaly = { table, index, id, kind: 'fixed', code, detail, changes: { [field]: { from, to } } }
    this.merge.set(key, a)
    this.list.push(a)
  }

  note(table: Table, index: number | null, id: string, code: string, detail: string): void {
    this.list.push({ table, index, id, kind: 'note', code, detail })
  }
}

// ------------------------------------------------------------------ shared row parts

type Stamps = { ts: string; updated_at: string }

function stamps(c: Collector, table: Table, index: number, id: string, raw: SheetRecord, fallback: string): Stamps {
  const uRaw = text(raw.updated_at)
  const uCanon = canonicalTs(raw.updated_at)
  const tCanon = canonicalTs(raw.ts)
  const tRaw = text(raw.ts)
  const updated_at = uCanon ?? tCanon ?? fallback
  if (uCanon === null) c.fix(table, index, id, 'updated_at_filled', 'updated_at missing or unreadable', 'updated_at', uRaw, updated_at)
  else if (uCanon !== uRaw) c.fix(table, index, id, 'updated_at_canonical', 'updated_at rewritten as Taipei ISO', 'updated_at', uRaw, uCanon)
  const ts = tCanon ?? updated_at
  if (tCanon === null) c.fix(table, index, id, 'ts_filled', 'ts missing or unreadable', 'ts', tRaw, ts)
  else if (tCanon !== tRaw) c.fix(table, index, id, 'ts_canonical', 'ts rewritten as Taipei ISO', 'ts', tRaw, tCanon)
  return { ts, updated_at }
}

/** ts + day for logs and weights: ts is authoritative, day is derived from it. null = unusable (dropped by the caller). */
function tsAndDay(c: Collector, table: Table, index: number, id: string, raw: SheetRecord): { ts: string; day: string } | null {
  const tRaw = text(raw.ts)
  const dRaw = text(raw.day).slice(0, 10)
  const canon = canonicalTs(raw.ts)
  if (canon) {
    const day = dayOfCanon(canon)
    if (canon !== tRaw) c.fix(table, index, id, 'ts_canonical', 'ts rewritten as Taipei ISO', 'ts', tRaw, canon)
    if (dRaw !== day) c.fix(table, index, id, 'day_from_ts', 'day differs from the Taipei day of ts; day corrected', 'day', dRaw, day)
    return { ts: canon, day }
  }
  if (ISO_DAY.test(dRaw) && !Number.isNaN(Date.parse(`${dRaw}T00:00:00Z`))) {
    const ts = `${dRaw}T12:00:00+08:00`
    c.fix(table, index, id, 'ts_from_day', 'ts missing or unreadable; set to noon of day', 'ts', tRaw, ts)
    return { ts, day: dRaw }
  }
  return null
}

function nutrition(c: Collector, table: Table, index: number, id: string, raw: SheetRecord): { kcal: number; protein: number; fat: number; carb: number } {
  const out = { kcal: 0, protein: 0, fat: 0, carb: 0 }
  for (const f of ['kcal', 'protein', 'fat', 'carb'] as const) {
    const v = raw[f]
    const n = sheetNumber(v)
    if (n === undefined || n < 0) {
      c.fix(table, index, id, 'nutrition_invalid', 'nutrition value missing, negative or not a number; set to 0', f, v ?? null, 0)
      out[f] = 0
    } else {
      if (typeof v !== 'number') c.fix(table, index, id, 'number_from_string', 'number stored as text', f, v, n)
      out[f] = n
    }
  }
  return out
}

const createdBy = (c: Collector, table: Table, index: number, id: string, v: unknown): 'app' | 'kyujin' => {
  const s = text(v)
  if (s === 'app' || s === 'kyujin') return s
  c.fix(table, index, id, 'created_by_invalid', "created_by is neither app nor kyujin; set to app", 'created_by', s, 'app')
  return 'app'
}

/** Keep one row per id: the newest updated_at wins, the later row wins a tie. Losers are dropped (recorded). */
function dedupe<T extends { id: string; updated_at: string; index: number }>(c: Collector, table: Table, rows: T[]): T[] {
  const best = new Map<string, T>()
  for (const r of rows) {
    const cur = best.get(r.id)
    if (!cur || r.updated_at >= cur.updated_at) best.set(r.id, r)
  }
  const kept: T[] = []
  for (const r of rows) {
    if (best.get(r.id) === r) kept.push(r)
    else c.drop(table, r.index, r.id, 'duplicate_id', 'the same id appears more than once in the Sheet; the newest row is kept')
  }
  return kept
}

// ------------------------------------------------------------------ the transform

type Cand<T> = T & { index: number }

export function transform(snapshot: SheetSnapshot, opts: TransformOptions): TransformResult {
  if (!opts.userId) throw new Error('transform: userId is required')
  const c = new Collector()
  const serverCanon = canonicalTs(snapshot.serverTime) ?? taipeiIso(Date.parse(snapshot.fetchedAt))

  // ---- stores ----
  type StoreC = Cand<RowInput<'stores'>>
  let stores: StoreC[] = []
  snapshot.stores.forEach((raw, index) => {
    const id = text(raw.id)
    if (!id) return c.drop('stores', index, id, 'no_id', 'store row without id')
    if (!id.startsWith('s:')) return c.drop('stores', index, id, 'bad_id_prefix', 'store id must start with s:')
    const name = raw.name === null || raw.name === undefined ? '' : String(raw.name)
    if (name.trim() === '') return c.drop('stores', index, id, 'blank_name', 'store name is blank')
    const st = stamps(c, 'stores', index, id, raw, serverCanon)
    let last: string | null = null
    if (text(raw.last_eaten_at) !== '') {
      last = canonicalTs(raw.last_eaten_at)
      if (last === null) c.fix('stores', index, id, 'last_eaten_invalid', 'last_eaten_at unreadable; set to NULL', 'last_eaten_at', text(raw.last_eaten_at), null)
      else if (last !== text(raw.last_eaten_at)) c.fix('stores', index, id, 'last_eaten_canonical', 'last_eaten_at rewritten as Taipei ISO', 'last_eaten_at', text(raw.last_eaten_at), last)
    }
    stores.push({
      index,
      id,
      name,
      name_norm: normName(name),
      last_eaten_at: last,
      created_by: createdBy(c, 'stores', index, id, raw.created_by),
      ts: st.ts,
      deleted_at: sheetDeleted(raw) ? st.updated_at : null,
      updated_at: st.updated_at,
    })
  })
  stores = dedupe(c, 'stores', stores)

  // two live stores with the same normalised name would break the unique index: keep the oldest, delete the others, and point
  // their items / logs at the survivor
  const storeMerge = new Map<string, string>()
  const byNorm = new Map<string, StoreC[]>()
  for (const s of stores) if (s.deleted_at === null) byNorm.set(s.name_norm, [...(byNorm.get(s.name_norm) ?? []), s])
  for (const group of byNorm.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1))
    const [winner, ...losers] = group as [StoreC, ...StoreC[]]
    for (const l of losers) {
      l.deleted_at = l.updated_at
      storeMerge.set(l.id, winner.id)
      c.fix('stores', l.index, l.id, 'store_duplicate_name', `same name as ${winner.id} after normalisation; deleted, its items and logs now point at ${winner.id}`, 'deleted', false, true)
    }
  }
  const storeIds = new Set(stores.map((s) => s.id))
  const resolveStore = (table: Table, index: number, id: string, raw: unknown): string | null => {
    const sid = text(raw)
    if (sid === '') return null
    const to = storeMerge.get(sid)
    if (to) {
      c.fix(table, index, id, 'store_merged', 'store reference moved to the surviving duplicate store', 'store_id', sid, to)
      return to
    }
    return sid
  }

  // ---- items (+ favorites from items.fav) ----
  type ItemC = Cand<RowInput<'items'>>
  let items: ItemC[] = []
  const itemFav = new Map<string, { updated_at: string }>()
  snapshot.items.forEach((raw, index) => {
    const id = text(raw.id)
    if (!id) return c.drop('items', index, id, 'no_id', 'item row without id')
    if (id.startsWith('fm:') || id.startsWith('711:')) return c.drop('items', index, id, 'official_id', 'official items are not stored in D1')
    const isOv = id.startsWith('ov:')
    if (!isOv && !id.startsWith('u:')) return c.drop('items', index, id, 'bad_id_prefix', 'item id must start with ov: or u:')
    if (id.length <= (isOv ? 3 : 2)) return c.drop('items', index, id, 'bad_id_prefix', 'item id has nothing after its prefix')
    const st = stamps(c, 'items', index, id, raw, serverCanon)
    const kind = isOv ? '補填' : '自建'
    if (text(raw.kind) !== kind) c.fix('items', index, id, 'kind_fixed', `kind must be ${kind} for ${isOv ? 'ov:' : 'u:'} ids`, 'kind', text(raw.kind), kind)
    const wantBase = isOv ? id.slice(3) : null
    const haveBase = text(raw.base_id) === '' ? null : text(raw.base_id)
    if (haveBase !== wantBase) c.fix('items', index, id, 'base_id_fixed', 'base_id must be the official id for ov: items and empty for u: items', 'base_id', haveBase, wantBase)
    let src = text(raw.src)
    if (!SRC_OK.includes(src)) {
      c.fix('items', index, id, 'src_invalid', 'src is not 7-11 / 全家 / 其他; set to 其他', 'src', src, '其他')
      src = '其他'
    }
    let name = raw.name === null || raw.name === undefined ? '' : String(raw.name)
    if (name === '') {
      c.fix('items', index, id, 'name_filled', 'blank item name', 'name', '', '(未命名)')
      name = '(未命名)'
    }
    let serving = raw.serving === null || raw.serving === undefined ? '' : String(raw.serving)
    if (serving === '') {
      c.fix('items', index, id, 'serving_filled', 'blank serving', 'serving', '', '1 份')
      serving = '1 份'
    }
    let servingG: number | null = null
    if (text(raw.serving_g) !== '') {
      const n = sheetNumber(raw.serving_g)
      if (n === undefined || n <= 0) c.fix('items', index, id, 'serving_g_invalid', 'serving_g must be a positive number; set to NULL', 'serving_g', raw.serving_g, null)
      else servingG = n
    }
    const nut = nutrition(c, 'items', index, id, raw)
    const storeId = resolveStore('items', index, id, raw.store)
    if (storeId && src !== '其他') {
      c.fix('items', index, id, 'store_item_src', 'a store item always has src 其他', 'src', src, '其他')
      src = '其他'
    }
    items.push({
      index,
      id,
      kind,
      base_id: wantBase,
      src: src as RowInput<'items'>['src'],
      name,
      serving,
      serving_g: servingG,
      ...nut,
      store_id: storeId,
      created_by: createdBy(c, 'items', index, id, raw.created_by),
      ts: st.ts,
      cascade_of: null,
      deleted_at: sheetDeleted(raw) ? st.updated_at : null,
      updated_at: st.updated_at,
    })
    if (!isOv && raw.fav === true) itemFav.set(id, { updated_at: st.updated_at })
  })
  items = dedupe(c, 'items', items)
  for (const it of items) {
    if (it.store_id && !storeIds.has(it.store_id)) c.note('items', it.index, it.id, 'dangling_store_ref', `store ${it.store_id} is not in the Stores sheet (kept as it is)`)
  }

  // ---- favorites: u: items by items.fav, official items by Config.fav_ids (what the v1 App does) ----
  const favMap = new Map<string, RowInput<'favorites'>>()
  const keptItemIds = new Set(items.map((i) => i.id))
  for (const [id, v] of [...itemFav].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (keptItemIds.has(id)) favMap.set(id, { item_id: id, deleted_at: null, updated_at: v.updated_at })
  }
  for (const part of text(snapshot.config.fav_ids).split(',')) {
    const id = part.trim()
    if (!id) continue
    if (id.startsWith('fm:') || id.startsWith('711:')) {
      if (!favMap.has(id)) favMap.set(id, { item_id: id, deleted_at: null, updated_at: serverCanon })
    } else {
      c.note('favorites', null, id, 'fav_id_ignored', 'fav_ids lists a non-official id; the v1 App reads custom favourites from items.fav, so it is ignored')
    }
  }

  // ---- logs ----
  type LogC = Cand<RowInput<'logs'>>
  let logs: LogC[] = []
  snapshot.logs.forEach((raw, index) => {
    const id = text(raw.id)
    if (!id) return c.drop('logs', index, id, 'no_id', 'log row without id')
    const td = tsAndDay(c, 'logs', index, id, raw)
    if (!td) return c.drop('logs', index, id, 'unusable_time', 'neither ts nor day can be read')
    const updated = canonicalTs(raw.updated_at)
    const updated_at = updated ?? td.ts
    if (updated === null) c.fix('logs', index, id, 'updated_at_filled', 'updated_at missing or unreadable', 'updated_at', text(raw.updated_at), updated_at)
    else if (updated !== text(raw.updated_at)) c.fix('logs', index, id, 'updated_at_canonical', 'updated_at rewritten as Taipei ISO', 'updated_at', text(raw.updated_at), updated)
    let src = text(raw.src)
    if (!SRC_OK.includes(src)) {
      c.fix('logs', index, id, 'src_invalid', 'src is not 7-11 / 全家 / 其他; set to 其他', 'src', src, '其他')
      src = '其他'
    }
    const sourceRaw = text(raw.source)
    const source = sourceRaw === 'quick' || sourceRaw === 'kyujin' ? sourceRaw : 'app'
    if (sourceRaw !== source && sourceRaw !== '') c.fix('logs', index, id, 'source_invalid', 'source is not app / quick / kyujin; set to app', 'source', sourceRaw, 'app')
    const itemId = text(raw.item_id) === '' ? null : text(raw.item_id)
    let qty = sheetNumber(raw.qty)
    if (qty === undefined || qty <= 0) {
      c.fix('logs', index, id, 'qty_invalid', 'qty must be a positive number; set to 1', 'qty', raw.qty ?? null, 1)
      qty = 1
    } else if (typeof raw.qty !== 'number') c.fix('logs', index, id, 'number_from_string', 'number stored as text', 'qty', raw.qty, qty)
    let grams: number | null = null
    if (text(raw.grams) !== '') {
      const g = sheetNumber(raw.grams)
      if (g === undefined || g <= 0) c.fix('logs', index, id, 'grams_invalid', 'grams must be a positive number; set to NULL', 'grams', raw.grams, null)
      else grams = g
    }
    const nut = nutrition(c, 'logs', index, id, raw)
    let storeId = resolveStore('logs', index, id, raw.store)
    if (itemId === null) {
      // quick-log shape (a D1 CHECK): qty 1, no grams, src 其他, no store
      if (qty !== 1) {
        c.fix('logs', index, id, 'quick_shape', 'a log without an item has the quick-log shape (qty 1, no grams, src 其他, no store)', 'qty', qty, 1)
        qty = 1
      }
      if (grams !== null) {
        c.fix('logs', index, id, 'quick_shape', 'a log without an item has the quick-log shape (qty 1, no grams, src 其他, no store)', 'grams', grams, null)
        grams = null
      }
      if (src !== '其他') {
        c.fix('logs', index, id, 'quick_shape', 'a log without an item has the quick-log shape (qty 1, no grams, src 其他, no store)', 'src', src, '其他')
        src = '其他'
      }
      if (storeId !== null) {
        c.fix('logs', index, id, 'quick_shape', 'a log without an item has the quick-log shape (qty 1, no grams, src 其他, no store)', 'store_id', storeId, null)
        storeId = null
      }
    }
    logs.push({
      index,
      id,
      day: td.day,
      ts: td.ts,
      item_id: itemId,
      name: raw.name === null || raw.name === undefined ? '' : String(raw.name),
      src: src as RowInput<'logs'>['src'],
      qty,
      grams,
      ...nut,
      source,
      store_id: storeId,
      deleted_at: sheetDeleted(raw) ? updated_at : null,
      updated_at,
    })
  })
  logs = dedupe(c, 'logs', logs)

  // ---- weights ----
  type WeightC = Cand<RowInput<'weights'>>
  let weights: WeightC[] = []
  snapshot.weights.forEach((raw, index) => {
    const rawId = text(raw.id)
    const td = tsAndDay(c, 'weights', index, rawId, raw)
    if (!td) return c.drop('weights', index, rawId, 'unusable_time', 'neither ts nor day can be read')
    const id = rawId || `w:${td.day}`
    if (rawId === '') c.fix('weights', index, id, 'weight_id_assigned', 'weight row without id; id set to w:<day>', 'id', '', id)
    let kg = sheetNumber(raw.kg)
    if (kg === undefined) return c.drop('weights', index, id, 'kg_invalid', 'kg is not a number')
    if (typeof raw.kg !== 'number') c.fix('weights', index, id, 'number_from_string', 'number stored as text', 'kg', raw.kg, kg)
    const rounded = Math.round(kg * 10) / 10
    if (rounded !== kg) {
      c.fix('weights', index, id, 'kg_rounded', 'kg has more than one decimal; rounded', 'kg', kg, rounded)
      kg = rounded
    }
    if (kg < 30 || kg > 250) return c.drop('weights', index, id, 'kg_out_of_range', `kg ${kg} is outside 30 to 250`)
    const updated = canonicalTs(raw.updated_at)
    const updated_at = updated ?? td.ts
    if (updated === null) c.fix('weights', index, id, 'updated_at_filled', 'updated_at missing or unreadable', 'updated_at', text(raw.updated_at), updated_at)
    else if (updated !== text(raw.updated_at)) c.fix('weights', index, id, 'updated_at_canonical', 'updated_at rewritten as Taipei ISO', 'updated_at', text(raw.updated_at), updated)
    weights.push({ index, id, day: td.day, ts: td.ts, kg, deleted_at: sheetDeleted(raw) ? updated_at : null, updated_at })
  })
  weights = dedupe(c, 'weights', weights)
  // one live weight per day (D1 partial unique index): the newest measurement stays
  const liveByDay = new Map<string, WeightC[]>()
  for (const w of weights) if (w.deleted_at === null) liveByDay.set(w.day, [...(liveByDay.get(w.day) ?? []), w])
  for (const group of liveByDay.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.updated_at !== b.updated_at ? (a.updated_at < b.updated_at ? -1 : 1) : a.index - b.index))
    const winner = group[group.length - 1]!
    for (const w of group.slice(0, -1)) {
      w.deleted_at = w.updated_at
      c.fix('weights', w.index, w.id, 'weight_superseded', `another live weight on ${w.day} is newer (${winner.id}); this one is marked deleted`, 'deleted', false, true)
    }
  }

  // ---- config ----
  const config = transformConfig(c, snapshot.config, serverCanon)

  const strip = <T extends { index: number }>(r: T): Omit<T, 'index'> => {
    const { index: _i, ...rest } = r
    return rest
  }
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const result: TransformResult = {
    userId: opts.userId,
    stores: stores.map(strip).sort(byId) as RowInput<'stores'>[],
    items: items.map(strip).sort(byId) as RowInput<'items'>[],
    logs: logs
      .map(strip)
      .sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : byId(a, b))) as RowInput<'logs'>[],
    weights: weights.map(strip).sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : byId(a, b))) as RowInput<'weights'>[],
    favorites: [...favMap.values()].sort((a, b) => (a.item_id < b.item_id ? -1 : 1)),
    config,
    anomalies: c.list,
    counts: {
      stores: { in: snapshot.stores.length, out: stores.length },
      items: { in: snapshot.items.length, out: items.length },
      logs: { in: snapshot.logs.length, out: logs.length },
      weights: { in: snapshot.weights.length, out: weights.length },
    },
  }
  return result
}

function transformConfig(c: Collector, cfg: Record<string, string>, nowIso: string): RowInput<'config'> {
  const def = DEFAULT_CONFIG_VALUES
  const raw = (k: string): string => (cfg[k] === undefined || cfg[k] === null ? '' : String(cfg[k]).trim())
  const fix = (k: string, detail: string, from: unknown, to: unknown) => c.fix('config', null, 'config', 'config_fixed', detail, k, from, to)

  let target_kcal: number = def.target_kcal
  if (/^\d+$/.test(raw('target_kcal'))) target_kcal = Number(raw('target_kcal'))
  else if (cfg.target_kcal !== undefined) fix('target_kcal', 'target_kcal is not a non-negative integer; default used', cfg.target_kcal, def.target_kcal)

  const nut = (k: 'target_protein' | 'target_fat' | 'target_carb'): number => {
    const n = raw(k) === '' ? undefined : Number(raw(k))
    if (n !== undefined && Number.isFinite(n) && n >= 0) return n
    if (cfg[k] !== undefined) fix(k, `${k} is not a non-negative number; default used`, cfg[k], def[k])
    return def[k]
  }

  let tdee: number | null = null
  if (raw('tdee') !== '') {
    if (/^\d+$/.test(raw('tdee'))) tdee = Number(raw('tdee'))
    else fix('tdee', 'tdee is not an integer; set to NULL', cfg.tdee, null)
  }

  // Old Sheet cells that Google turned into a time come back from v1 `read` as "1899-12-30T07:30:00+08:00" (the front end showed
  // them blank): the clock part is the time that was typed
  const fromDate = (p: string): string | null => {
    const m = /^1899-12-\d\dT(\d\d:\d\d)/.exec(p)
    return m && HHMM.test(m[1]!) ? m[1]! : null
  }
  const meal: string[] = []
  if (raw('remind_meal_times') !== '') {
    const bad: string[] = []
    let recovered = false
    for (const p of raw('remind_meal_times').split(',').map((s) => s.trim()).filter(Boolean)) {
      const rec = HHMM.test(p) ? null : fromDate(p)
      if (rec) {
        recovered = true
        meal.push(rec)
      } else (HHMM.test(p) ? meal : bad).push(p)
    }
    if (recovered) c.fix('config', null, 'config', 'config_time_from_date', 'a time the Sheet had turned into a date; the clock part is used (check it)', 'remind_meal_times', cfg.remind_meal_times, meal.join(','))
    if (bad.length) fix('remind_meal_times', `unreadable times dropped: ${bad.join(' ')}`, cfg.remind_meal_times, meal.join(','))
  }

  let weightTime: string | null = null
  if (raw('remind_weight_time') !== '') {
    const rec = HHMM.test(raw('remind_weight_time')) ? null : fromDate(raw('remind_weight_time'))
    if (HHMM.test(raw('remind_weight_time'))) weightTime = raw('remind_weight_time')
    else if (rec) {
      weightTime = rec
      c.fix('config', null, 'config', 'config_time_from_date', 'a time the Sheet had turned into a date; the clock part is used (check it)', 'remind_weight_time', raw('remind_weight_time'), rec)
    } else fix('remind_weight_time', 'remind_weight_time is not HH:mm; set to NULL', cfg.remind_weight_time, null)
  }

  return {
    target_kcal,
    target_protein: nut('target_protein'),
    target_fat: nut('target_fat'),
    target_carb: nut('target_carb'),
    tdee,
    remind_meal_times: meal,
    remind_weight_time: weightTime,
    deleted_at: null,
    updated_at: nowIso,
  }
}
