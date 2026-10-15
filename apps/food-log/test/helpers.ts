import type { ItemRecord, LogRecord, MergedItem, StoreRecord } from '@/types'

export function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  }
}

export function logFields(p: Partial<LogRecord> & Pick<LogRecord, 'id'>): LogRecord {
  return {
    ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-10',
    item_id: 'fm:1', name: '雞胸', src: '全家', qty: 1, grams: null, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
    source: 'app', store: '',
    ...p,
  }
}

export function itemFields(p: Partial<ItemRecord> & Pick<ItemRecord, 'id'>): ItemRecord {
  return {
    ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '', kind: '自建', base_id: '', src: '其他',
    name: 'x', serving: '1 份', serving_g: null, kcal: 100, protein: 10, fat: 1, carb: 2, fav: false, created_by: 'app',
    store: '',
    ...p,
  }
}

export function storeFields(p: Partial<StoreRecord> & Pick<StoreRecord, 'id' | 'name'>): StoreRecord {
  return {
    ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '', last_eaten_at: '', created_by: 'app',
    ...p,
  }
}

export function merged(p: Partial<MergedItem> & Pick<MergedItem, 'id' | 'name'>): MergedItem {
  return {
    src: 'familymart', cat: '', serving: '1 份', servingG: 100, perPack: 1, kcal: 100,
    protein: 10, fat: 1, carb: 2, fav: false, createdBy: null, override: false, needsFill: false, sheetSrc: '全家',
    storeId: '', storeName: '',
    ...p,
  }
}
