export type Kv = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
}

export function memoryKv(init?: Record<string, string>): Kv {
  const m = new Map<string, string>(Object.entries(init ?? {}))
  return {
    async get(key) { return m.has(key) ? m.get(key)! : null },
    async set(key, value) { m.set(key, value) },
    async del(key) { m.delete(key) },
  }
}

const DB_NAME = 'food-log'
const STORE = 'kv'
const VERSION = 1

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function idbKv(): Kv {
  let dbp: Promise<IDBDatabase> | null = null
  const open = () => {
    if (dbp) return dbp
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return dbp
  }
  async function tx(mode: IDBTransactionMode) {
    const db = await open()
    return db.transaction(STORE, mode).objectStore(STORE)
  }
  return {
    async get(key) {
      const store = await tx('readonly')
      const v = await idbReq(store.get(key))
      return v == null ? null : String(v)
    },
    async set(key, value) {
      const store = await tx('readwrite')
      await idbReq(store.put(value, key))
    },
    async del(key) {
      const store = await tx('readwrite')
      await idbReq(store.delete(key))
    },
  }
}

export function defaultKv(): Kv {
  if (typeof indexedDB === 'undefined') return memoryKv()
  return idbKv()
}
