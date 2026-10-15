// 內建官方品項快照 + 從本機資料庫（Dexie）來的 ov: 補填、u: 自建、收藏、店家，合併成畫面用的品項清單。
// 收藏來自 favorites 表（官方品項與自建品項一視同仁）；v1 的 Config.fav_ids 與 items.fav 已經不存在。
import type { ItemRow, StoreRow } from '@food-log/core'
import type { CatalogItem, MergedItem, SheetSrc } from '@/types'
import { needsFill } from '@/lib/nutrition'

export { needsFill }

function sheetSrcOf(src: CatalogItem['src']): SheetSrc {
  if (src === 'familymart') return '全家'
  if (src === '711') return '7-11'
  return '其他'
}

export function mergeCatalog(
  snapshot: CatalogItem[],
  itemRows: readonly ItemRow[],
  favIds: Iterable<string> = [],
  stores: readonly Pick<StoreRow, 'id' | 'name'>[] = [],
): MergedItem[] {
  const favSet = new Set(favIds)
  const storeName = new Map(stores.map((s) => [s.id, s.name]))
  const live = itemRows.filter((r) => r.deleted_at === null)
  const overrides = new Map<string, ItemRow>()
  const custom: ItemRow[] = []
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
    const sid = r.store_id ?? ''
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
      fav: favSet.has(r.id),
      createdBy: r.created_by,
      override: false,
      needsFill: false,
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
