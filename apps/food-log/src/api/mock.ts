// 本機假資料介面卡：行為跟 Apps Script 後端一致，起始是空資料＋預設 Config。
import type { ConfigMap, ItemRecord, LogRecord, LogSource, Snapshot, StoreRecord, WeightRecord } from '@/types'
import { DEFAULT_CONFIG } from '@/data/defaults'
import { addDays, taipeiDay, taipeiIso } from '@/lib/day'
import { norm } from '@/data/search'
import { NetworkError } from './errors'
import type { Adapter, Op, Response } from './types'

const SRC_OK = new Set(['7-11', '全家', '其他'])
const NUT_MSG = '紀錄必須有熱量、蛋白質、脂肪、碳水'
const KYU_MSG = 'Kyujin 只能寫入自建品項或體重'
const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

type Db = { config: ConfigMap; items: ItemRecord[]; stores: StoreRecord[]; logs: LogRecord[]; weights: WeightRecord[] }

export function seedData(): Db {
  return { config: { ...DEFAULT_CONFIG }, items: [], stores: [], logs: [], weights: [] }
}

export interface MockAdapter extends Adapter {
  setOffline(v: boolean): void
  reset(): void
  calls: Op[]
}

function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}
function nutritionOk(rec: { kcal?: unknown; protein?: unknown; fat?: unknown; carb?: unknown }) {
  return isFiniteNonNeg(rec.kcal) && isFiniteNonNeg(rec.protein) && isFiniteNonNeg(rec.fat) && isFiniteNonNeg(rec.carb)
}
function fail(error: string, message?: string, extra?: Record<string, unknown>): Response {
  return { ok: false, error, message, ...extra } as Response
}
function isDel(r: { deleted?: boolean }) { return !!r.deleted }
function logSourceOf(v: unknown): LogSource {
  return v === 'quick' || v === 'kyujin' ? v : 'app'
}

export function createMockAdapter(opts: { storage?: Storage; key?: string; now?: () => number; latencyMs?: number } = {}): MockAdapter {
  const { storage, key = 'foodlog.mockdb', now = () => Date.now(), latencyMs = 0 } = opts
  let offline = false
  let memory: Db | null = null
  const calls: Op[] = []
  const save = (db: Db) => { memory = db; storage?.setItem(key, JSON.stringify(db)) }
  const load = (): Db => {
    const raw = storage ? storage.getItem(key) : memory && JSON.stringify(memory)
    const parsed = raw ? JSON.parse(raw) as Partial<Db> : null
    const db: Db = parsed
      ? {
          config: parsed.config ?? { ...DEFAULT_CONFIG },
          items: (parsed.items ?? []).map((r) => ({ ...r, store: r.store ?? '' })),
          stores: parsed.stores ?? [],
          logs: (parsed.logs ?? []).map((r) => ({ ...r, source: logSourceOf(r.source), store: r.store ?? '' })),
          weights: parsed.weights ?? [],
        }
      : seedData()
    if (!raw) save(db)
    return db
  }
  const today = () => taipeiDay(new Date(now()))
  const stamp = () => taipeiIso(now())

  function resolveSource(record: { source?: string }, kyujin: boolean): LogSource | Response {
    const source = record.source
    if (kyujin) {
      if (source !== 'kyujin') return fail('forbidden', KYU_MSG)
      return 'kyujin'
    }
    if (source === 'kyujin') return fail('bad_record', '不能寫 kyujin 的 source')
    if (!source) return 'app'
    if (source !== 'app' && source !== 'quick') return fail('bad_record', 'source 只能是 app、quick 或 kyujin')
    return source
  }

  function bumpLastEaten(db: Db, storeId: string, ts: string) {
    const st = db.stores.find((s) => s.id === storeId)
    if (!st) return
    if (st.last_eaten_at && st.last_eaten_at >= ts) return
    st.last_eaten_at = ts
  }

  function handle(op: Op & { client?: string }, db: Db): Response {
    const kyujin = op.client === 'kyujin'
    switch (op.action) {
      case 'read': {
        const logCutoff = addDays(today(), -34)
        const weightCutoff = addDays(today(), -89)
        const since = op.since ?? ''
        return {
          ok: true, version: 1, serverTime: stamp(), config: { ...db.config },
          items: db.items.map((r) => ({ ...r })),
          stores: db.stores.map((r) => ({ ...r })),
          logs: db.logs.filter((r) => r.day >= logCutoff && (!since || r.updated_at >= since)).map((r) => ({ ...r })),
          weights: db.weights.filter((r) => r.day >= weightCutoff && (!since || r.updated_at >= since)).map((r) => ({ ...r })),
          weightDays: 90,
        } satisfies Snapshot
      }
      case 'append': {
        if ((op as { table: string }).table !== 'Logs') return fail('bad_table', (op as { table: string }).table)
        const r = op.record
        if (!r?.id || !r.ts || !r.day || !r.src || r.qty == null) return fail('bad_record', '缺少必填欄位')
        const sourceOrErr = resolveSource(r, kyujin)
        if (typeof sourceOrErr !== 'string') return sourceOrErr
        const source = sourceOrErr
        const itemId = r.item_id == null ? '' : String(r.item_id)
        const name = String(r.name ?? '').trim()
        const storeId = r.store == null ? '' : String(r.store)
        if (itemId === '') {
          if (!nutritionOk(r)) return fail('bad_record', NUT_MSG)
          if (r.qty !== 1) return fail('bad_record', 'qty 必須是大於 0 的數字')
          const g = r.grams as unknown
          if (!(g === undefined || g === null || g === '')) return fail('bad_record', 'grams 格式不對')
          if (r.src !== '其他') return fail('bad_record', 'src 只能是 7-11、全家或其他')
          if (storeId) return fail('bad_record', '找不到這家店')
        } else {
          if (!name) return fail('bad_record', '缺少必填欄位')
          if (!nutritionOk(r)) return fail('bad_record', NUT_MSG)
          if (typeof r.qty !== 'number' || !Number.isFinite(r.qty) || r.qty <= 0) return fail('bad_record', 'qty 必須是大於 0 的數字')
          const g = r.grams as unknown
          if (!(g === undefined || g === null || g === '' || (typeof g === 'number' && Number.isFinite(g) && g > 0))) return fail('bad_record', 'grams 格式不對')
          if (!SRC_OK.has(r.src)) return fail('bad_record', 'src 只能是 7-11、全家或其他')
        }
        if (r.day !== taipeiDay(new Date(r.ts))) return fail('bad_record', 'day 必須等於台北日')
        if (r.day > today()) return fail('bad_record', '不能記未來的日期')
        if (storeId && !db.stores.some((s) => s.id === storeId)) return fail('bad_record', '找不到這家店')
        const existing = db.logs.find((x) => x.id === r.id)
        if (existing) return { ok: true, duplicate: true, record: existing }
        const row: LogRecord = { ...r, item_id: itemId, name, source, store: storeId, deleted: !!r.deleted, updated_at: stamp() }
        db.logs.push(row)
        if (storeId) bumpLastEaten(db, storeId, r.ts)
        return { ok: true, record: row }
      }
      case 'update': {
        if ((op as { table: string }).table !== 'Logs') return fail('bad_table', (op as { table: string }).table)
        const row = db.logs.find((x) => x.id === op.id)
        if (kyujin) {
          if (!row || logSourceOf(row.source) !== 'kyujin') return fail('forbidden', KYU_MSG)
        }
        if (!row) return fail('not_found', op.id)
        if (row.deleted) return { ok: true, ignored: 'deleted' }
        if (op.patch && op.patch.source != null && logSourceOf(op.patch.source) !== logSourceOf(row.source)) {
          return fail('bad_record', '不能改 source')
        }
        const allowed = ['qty', 'grams', 'kcal', 'protein', 'fat', 'carb', 'ts', 'day', 'name']
        const merged = { ...row }
        for (const [k, v] of Object.entries(op.patch || {})) {
          if (allowed.includes(k)) (merged as unknown as Record<string, unknown>)[k] = v
        }
        merged.name = String(merged.name ?? '').trim()
        const origSource = logSourceOf(row.source)
        if (merged.item_id === '' || origSource === 'quick') {
          if (merged.qty !== 1) return fail('bad_record', 'qty 必須是大於 0 的數字')
          const g = merged.grams as unknown
          if (!(g === undefined || g === null || g === '')) return fail('bad_record', 'grams 格式不對')
        }
        if (!nutritionOk(merged)) return fail('bad_record', NUT_MSG)
        if (merged.day !== taipeiDay(new Date(merged.ts))) return fail('bad_record', 'day 必須等於台北日')
        Object.assign(row, merged, { updated_at: stamp() })
        return { ok: true, record: row }
      }
      case 'softDelete': {
        if (op.table === 'Stores' && kyujin) return fail('forbidden', KYU_MSG)
        if ((op.table === 'Weights' || op.table === 'Items') && kyujin) return fail('forbidden', KYU_MSG)
        const list = op.table === 'Logs' ? db.logs : op.table === 'Items' ? db.items : op.table === 'Weights' ? db.weights : op.table === 'Stores' ? db.stores : null
        if (!list) return fail('bad_table', op.table)
        const row = (list as { id: string; deleted: boolean; updated_at: string; source?: string }[]).find((x) => x.id === op.id)
        if (op.table === 'Logs' && kyujin) {
          if (!row || logSourceOf(row.source) !== 'kyujin') return fail('forbidden', KYU_MSG)
        } else if (kyujin) {
          return fail('forbidden', KYU_MSG)
        }
        if (!row || row.deleted) return { ok: true }
        const now = stamp()
        row.deleted = true
        row.updated_at = now
        if (op.table === 'Stores') {
          for (const it of db.items) {
            if (it.store === op.id && !it.deleted) {
              it.deleted = true
              it.updated_at = now
            }
          }
        }
        return { ok: true, record: row }
      }
      case 'restore': {
        if (op.table === 'Stores' && kyujin) return fail('forbidden', KYU_MSG)
        if ((op.table === 'Weights' || op.table === 'Items') && kyujin) return fail('forbidden', KYU_MSG)
        if (op.table === 'Weights') {
          if (kyujin) return fail('forbidden', KYU_MSG)
          const row = db.weights.find((x) => x.id === op.id)
          if (!row) return fail('not_found', op.id)
          if (db.weights.some((w) => w.id !== op.id && w.day === row.day && !w.deleted)) return fail('bad_record', '這天已經有一筆體重')
          row.deleted = false
          row.updated_at = stamp()
          return { ok: true, record: row }
        }
        const list = op.table === 'Logs' ? db.logs : op.table === 'Items' ? db.items : op.table === 'Stores' ? db.stores : null
        if (!list) return fail('bad_table', op.table)
        const row = (list as { id: string; deleted: boolean; updated_at: string; source?: string }[]).find((x) => x.id === op.id)
        if (op.table === 'Logs' && kyujin) {
          if (!row || logSourceOf(row.source) !== 'kyujin') return fail('forbidden', KYU_MSG)
        } else if (kyujin) {
          return fail('forbidden', KYU_MSG)
        }
        if (!row) return fail('not_found', op.id)
        const oldUpdated = row.updated_at
        row.deleted = false
        row.updated_at = stamp()
        if (op.table === 'Stores') {
          for (const it of db.items) {
            if (it.store === op.id && it.deleted && it.updated_at === oldUpdated) {
              it.deleted = false
              it.updated_at = row.updated_at
            }
          }
        }
        return { ok: true, record: row }
      }
      case 'upsertItem': {
        const r = op.record
        if (!r?.id) return fail('bad_record', '缺少 id')
        const storeId = r.store == null ? '' : String(r.store)
        if (r.id.startsWith('fm:') || r.id.startsWith('711:')) return fail('forbidden', '不能改官方品項')
        if (r.id.startsWith('ov:')) {
          if (kyujin) return fail('forbidden', KYU_MSG)
          if (r.kind !== '補填') return fail('bad_record', '補填的 kind 必須是補填')
          if (r.base_id !== r.id.slice(3)) return fail('bad_record', 'base_id 必須等於官方 id')
          if (r.created_by !== 'app') return fail('bad_record', '補填的 created_by 必須是 app')
          if (storeId) return fail('bad_record')
        } else if (r.id.startsWith('u:')) {
          if (r.kind !== '自建') return fail('bad_record', '自建的 kind 必須是自建')
          if (r.base_id) return fail('bad_record', '自建的 base_id 必須空白')
          if (storeId) {
            if (r.src !== '其他') return fail('bad_record', 'src 只能是 7-11、全家或其他')
            const st = db.stores.find((s) => s.id === storeId)
            if (!st || st.deleted) return fail('bad_record', '找不到這家店')
          }
          if (kyujin && !storeId && r.created_by !== 'kyujin') return fail('forbidden', KYU_MSG)
        } else return fail('bad_record', 'id 格式不對')
        if (typeof r.name !== 'string' || !r.name) return fail('bad_record', 'name 不能空白')
        if (typeof r.serving !== 'string' || !r.serving) return fail('bad_record', 'serving 不能空白')
        const sg = r.serving_g as unknown
        if (!(sg === undefined || sg === null || sg === '' || (typeof sg === 'number' && Number.isFinite(sg) && sg > 0))) return fail('bad_record', 'serving_g 格式不對')
        if (!nutritionOk(r)) return fail('bad_record', NUT_MSG)
        if (!SRC_OK.has(r.src)) return fail('bad_record', 'src 只能是 7-11、全家或其他')
        if (typeof r.fav !== 'boolean') return fail('bad_record', 'fav 必須是布林')
        const i = db.items.findIndex((x) => x.id === r.id)
        if (i >= 0 && db.items[i].deleted) return { ok: true, ignored: 'deleted' }
        const existStore = i >= 0 ? (db.items[i].store || '') : ''
        const isStoreItem = !!(storeId || existStore)
        if (kyujin) {
          if (!r.id.startsWith('u:')) return fail('forbidden', KYU_MSG)
          if (!isStoreItem && i >= 0 && db.items[i].created_by !== 'kyujin') return fail('forbidden', KYU_MSG)
        }
        const created_by = i >= 0 ? db.items[i].created_by : r.created_by
        const row: ItemRecord = { ...r, store: storeId || existStore, created_by, updated_at: stamp(), ts: r.ts || stamp(), deleted: !!r.deleted }
        if (i >= 0) db.items[i] = { ...db.items[i], ...row, created_by }
        else db.items.push(row)
        return { ok: true, record: i >= 0 ? db.items[i] : row }
      }
      case 'upsertStore': {
        const r = op.record
        if (!r?.id) return fail('bad_record', '缺少 id')
        if (!String(r.id).startsWith('s:')) return fail('bad_record', 'id 格式不對')
        const existing = db.stores.find((s) => s.id === r.id)
        if (existing?.deleted) return { ok: true, ignored: 'deleted' }
        const name = String(r.name ?? '').trim()
        if (!name) return fail('bad_record', '店名不能空白')
        const dup = db.stores.find((s) => !s.deleted && s.id !== r.id && norm(s.name) === norm(name))
        if (dup) {
          return fail('duplicate_name', `已經有「${dup.name}」`, { existingId: dup.id, existingName: dup.name })
        }
        let created_by: StoreRecord['created_by']
        if (existing) created_by = existing.created_by
        else if (kyujin) {
          if (r.created_by !== 'kyujin') return fail('forbidden', KYU_MSG)
          created_by = 'kyujin'
        } else created_by = 'app'
        const row: StoreRecord = {
          ...r,
          name,
          created_by,
          last_eaten_at: r.last_eaten_at ?? existing?.last_eaten_at ?? '',
          updated_at: stamp(),
          ts: r.ts || stamp(),
          deleted: !!r.deleted,
        }
        if (existing) Object.assign(existing, row, { created_by, last_eaten_at: existing.last_eaten_at })
        else db.stores.push(row)
        return { ok: true, record: existing ?? row }
      }
      case 'upsertWeight': {
        const r = op.record
        const kg = r.kg
        if (typeof kg !== 'number' || !Number.isFinite(kg) || kg < 30 || kg > 250) return fail('bad_record', 'kg 必須在 30 到 250 之間')
        if (Math.round(kg * 10) / 10 !== kg) return fail('bad_record', 'kg 最多一位小數')
        if (!r.ts || !r.day || !r.id) return fail('bad_record', '缺少 id、ts 或 day')
        if (r.day !== taipeiDay(new Date(r.ts))) return fail('bad_record', 'day 必須等於台北日')
        if (r.day > today()) return fail('bad_record', '不能記未來的日期')
        const dup = db.weights.find((w) => w.id === r.id)
        if (dup) return { ok: true, duplicate: true, record: dup }
        const live = db.weights.find((w) => w.day === r.day && !isDel(w))
        if (live) {
          live.kg = kg
          live.ts = r.ts
          live.updated_at = stamp()
          return { ok: true, overwritten: true, record: live }
        }
        const row: WeightRecord = { id: r.id, day: r.day, ts: r.ts, kg, deleted: false, updated_at: stamp() }
        db.weights.push(row)
        return { ok: true, record: row }
      }
      case 'setConfig': {
        if (kyujin) return fail('forbidden', KYU_MSG)
        if (!CONFIG_KEYS.has(op.key)) return fail('bad_record', '不能寫這個設定')
        const v = op.value == null ? '' : String(op.value)
        if (op.key === 'tdee' && v !== '' && (!/^\d+$/.test(v) || Number(v) < 1200 || Number(v) > 5000)) return fail('bad_record', '每日消耗必須是 1200 到 5000 的整數')
        if (op.key === 'target_kcal' && (!/^\d+$/.test(v) || Number(v) < 0)) return fail('bad_record', '熱量目標必須是 ≥ 0 的整數')
        db.config[op.key] = v
        return { ok: true }
      }
      case 'history': {
        if (op.table !== 'Logs' && op.table !== 'Weights') return fail('bad_table', op.table)
        const limit = Math.min(90, Math.max(1, op.limit || 35))
        const rows = (op.table === 'Logs' ? db.logs : db.weights).filter((r) => r.day < op.before)
          .sort((a, b) => b.day.localeCompare(a.day))
        return { ok: true, records: rows.slice(0, limit), hasMore: rows.length > limit }
      }
      case 'summary': {
        const logs = db.logs.filter((r) => r.day === op.day)
        let kcal = 0, p = 0, f = 0, c = 0, count = 0
        for (const l of logs) {
          if (l.deleted) continue
          count += 1
          kcal += l.kcal
          p += Math.round(l.protein * 10)
          f += Math.round(l.fat * 10)
          c += Math.round(l.carb * 10)
        }
        const totals = { kcal, protein: p / 10, fat: f / 10, carb: c / 10 }
        const targets = {
          kcal: Number(db.config.target_kcal) || 0,
          protein: Number(db.config.target_protein) || 0,
          fat: Number(db.config.target_fat) || 0,
          carb: Number(db.config.target_carb) || 0,
        }
        return {
          ok: true, day: op.day, count, totals, targets,
          remaining: { kcal: targets.kcal - totals.kcal, protein: targets.protein - totals.protein, fat: targets.fat - totals.fat, carb: targets.carb - totals.carb },
        }
      }
      case 'trends':
        return { ok: true }
      default:
        return fail('bad_action', (op as { action: string }).action)
    }
  }

  return {
    kind: 'mock',
    calls,
    setOffline(v) { offline = v },
    reset() { memory = seedData(); storage?.setItem(key, JSON.stringify(memory)); calls.length = 0 },
    async call(op) {
      calls.push(op)
      const navOffline = typeof navigator !== 'undefined' && navigator.onLine === false
      if (offline || navOffline) throw new NetworkError()
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs))
      const db = load()
      const res = handle(op, db)
      save(db)
      return res
    },
  }
}
