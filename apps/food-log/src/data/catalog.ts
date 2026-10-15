import type { CatalogItem, ItemRecord, MergedItem, SheetSrc, StoreRecord } from '@/types'
import { needsFill } from '@/lib/nutrition'

export { needsFill }

export function parseFavIds(raw: string | undefined | null): string[] {
  return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

function sheetSrcOf(src: CatalogItem['src']): SheetSrc {
  if (src === 'familymart') return '全家'
  if (src === '711') return '7-11'
  return '其他'
}

export function mergeCatalog(
  snapshot: CatalogItem[],
  sheetItems: ItemRecord[],
  favIds: string[] | string = [],
  stores: StoreRecord[] = [],
): MergedItem[] {
  const favSet = new Set(Array.isArray(favIds) ? favIds : parseFavIds(favIds))
  const storeName = new Map(stores.map((s) => [s.id, s.name]))
  const live = sheetItems.filter((r) => !r.deleted)
  const overrides = new Map<string, ItemRecord>()
  const custom: ItemRecord[] = []
  for (const r of live) {
    if (r.id.startsWith('ov:') && r.base_id === r.id.slice(3)) overrides.set(r.base_id, r)
    else if (r.id.startsWith('u:')) custom.push(r)
  }
  const out: MergedItem[] = snapshot.map((item) => {
    const ov = overrides.get(item.id)
    if (ov) {
      return {
        ...item,
        serving: ov.serving || item.serving,
        servingG: ov.serving_g ?? item.servingG,
        kcal: ov.kcal,
        protein: ov.protein,
        fat: ov.fat,
        carb: ov.carb,
        fav: favSet.has(item.id),
        createdBy: null,
        override: true,
        needsFill: false,
        sheetSrc: sheetSrcOf(item.src),
        storeId: '',
        storeName: '',
      }
    }
    return {
      ...item,
      fav: favSet.has(item.id),
      createdBy: null,
      override: false,
      needsFill: needsFill(item),
      sheetSrc: sheetSrcOf(item.src),
      storeId: '',
      storeName: '',
    }
  })
  for (const r of custom) {
    const sid = r.store || ''
    out.push({
      id: r.id,
      src: 'custom',
      name: r.name,
      cat: '',
      serving: r.serving,
      servingG: r.serving_g,
      perPack: 1,
      kcal: r.kcal,
      protein: r.protein,
      fat: r.fat,
      carb: r.carb,
      fav: !!r.fav,
      createdBy: r.created_by,
      override: false,
      needsFill: sid ? false : needsFill(r),
      sheetSrc: r.src,
      storeId: sid,
      storeName: sid ? (storeName.get(sid) ?? '') : '',
    })
  }
  return out
}

export async function loadSnapshot(base = import.meta.env.BASE_URL || '/'): Promise<CatalogItem[]> {
  try {
    const url = `${base.replace(/\/?$/, '/') }catalog-v1.json`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json() as { items?: CatalogItem[] }
    return Array.isArray(data.items) ? data.items : []
  } catch {
    return []
  }
}
