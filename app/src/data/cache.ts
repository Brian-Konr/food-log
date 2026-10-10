import type { ConfigMap, ItemRecord, LogRecord, Snapshot, StoreRecord, WeightRecord } from '@/types'
import { taipeiIso, taipeiToday } from '@/lib/day'
import type { Kv } from './kv'

const META = ['__pending', '__write', '__queuedAt', '__failMessage', '__cascade', '__groupId'] as const

export type CachedSnapshot = {
  savedAt: string
  serverTime: string
  day: string
  config: ConfigMap
  items: ItemRecord[]
  stores: StoreRecord[]
  logs: LogRecord[]
  weights: WeightRecord[]
}

function stripRow<T extends object>(r: T): T {
  const o = { ...r } as Record<string, unknown>
  for (const k of META) delete o[k]
  return o as T
}

export function toCached(snap: Snapshot, now: number): CachedSnapshot {
  return {
    savedAt: taipeiIso(now),
    serverTime: snap.serverTime,
    day: taipeiToday(now),
    config: { ...snap.config },
    items: snap.items.map(stripRow),
    stores: (snap.stores ?? []).map(stripRow),
    logs: snap.logs.map(stripRow),
    weights: snap.weights.map(stripRow),
  }
}

export function snapshotFromCache(c: CachedSnapshot): Snapshot {
  return {
    ok: true,
    version: 1,
    serverTime: c.serverTime,
    config: c.config,
    items: c.items ?? [],
    stores: c.stores ?? [],
    logs: c.logs ?? [],
    weights: c.weights ?? [],
  }
}

export async function saveCache(kv: Kv, snap: CachedSnapshot): Promise<void> {
  await kv.set('snapshot', JSON.stringify(snap))
}

export async function loadCache(kv: Kv): Promise<CachedSnapshot | null> {
  const raw = await kv.get('snapshot')
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as CachedSnapshot
    if (!v || typeof v !== 'object') return null
    return v
  } catch {
    return null
  }
}

export function isStaleToday(cache: CachedSnapshot | null, today: string): boolean {
  return !!cache && cache.day !== today
}
