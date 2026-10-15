// 使用者動作（計畫 §3.6）：每個動作都是對 SyncClient.mutate 的呼叫，回傳 { undo }。
// Undo 一律是一個反向 mutation（不從待送佇列刪掉原本的那筆，避免和正在進行的 push 衝突）：
//
//   動作                       mutation          undo
//   記一筆（可能同時補填）      logs.add          logs.delete（補填保留）
//   快速記錄                   logs.add          logs.delete
//   收藏                       favorites.set     反向的 favorites.set
//   刪除品項／店家              items.delete      items.restore／stores.restore
//   記體重（當天沒有紀錄）      weights.upsert    weights.delete(rowId)
//   記體重（覆寫）              weights.upsert    weights.upsert(prevKg，新 id)
//   編輯紀錄                   logs.update       logs.update（舊值）
//   刪除紀錄                   logs.delete       logs.restore
//
// 失敗（伺服器回業務錯誤）不在這裡處理：它們進 sync-client 的 failed 表，UI 用 useFailed 顯示；
// 重試 = 用新的 mutationId 再 mutate 一次（client.retryFailed），捨棄 = 刪掉 failed 列（client.discardFailed）。
// 本機驗證失敗（例如店名重複）會當場丟出 MutationError，什麼都沒寫。
import { MutationError, fromGrams, fromQty, itemMacros, taipeiIso, taipeiToday } from '@food-log/core'
import type { MutationArgs } from '@food-log/core'
import type { FailedRow, SyncClient } from '@food-log/sync-client'
import { uid } from '@/lib/uid'
import type { LogRecord, MergedItem, SheetSrc, StoreRecord } from '@/types'

export type Undo = () => Promise<unknown>
export type Macros4 = { kcal: number; protein: number; fat: number; carb: number }

export interface ActionDeps {
  client: SyncClient
  /** 目前時間（epoch ms）；測試給固定值。 */
  now?: () => number
  /** 產生 id（預設 crypto.randomUUID）。 */
  newId?: () => string
}

export interface RecordLogInput {
  item: MergedItem
  qty: number
  grams: number | null
  /** 只有熱量的品項：補上三項營養素（會一併寫 ov:／u: 品項，同一個 mutation）。 */
  fill?: { protein: number; fat: number; carb: number }
  /** 店家品項：記錄時順便改營養素（同一個 mutation 先寫品項）。 */
  nutrition?: Macros4
}

export interface Actions {
  recordLog(a: RecordLogInput): Promise<{ logId: string; qty: number; grams: number | null; undo: Undo }>
  quickLog(v: { name: string } & Macros4): Promise<{ logId: string; undo: Undo }>
  setFavorite(itemId: string, fav: boolean): Promise<{ undo: Undo }>
  createStore(name: string): Promise<{ id: string }>
  renameStore(store: Pick<StoreRecord, 'id' | 'ts'>, name: string): Promise<void>
  deleteStore(id: string): Promise<{ undo: Undo }>
  /** 店家品項：新增或改（itemId 是既有的 u: id）。回品項 id。 */
  saveStoreItem(a: { storeId: string; itemId?: string; name: string } & Macros4): Promise<{ id: string }>
  /** 手動新增／編輯自建品項（沒有店家）。回品項 id。 */
  saveItem(a: {
    id?: string
    name: string
    src: SheetSrc
    serving: string
    servingG: number | null
    storeId?: string
  } & Macros4): Promise<{ id: string }>
  /** 只改營養素（店家品項的「儲存營養素」）。 */
  saveNutrition(item: MergedItem, n: Macros4): Promise<{ saved: true }>
  deleteItem(id: string): Promise<{ undo: Undo }>
  recordWeight(a: { day: string; kg: number; today: string }): Promise<{ undo: Undo; overwritten: boolean; prevKg: number | null }>
  updateLog(log: LogRecord, patch: LogPatchInput): Promise<{ undo: Undo }>
  deleteLog(id: string): Promise<{ undo: Undo }>
  setConfig(key: string, value: string): Promise<void>
  /** 失敗清單：重試 = 用新的 mutationId 再 mutate 一次。 */
  retryFailed(mutationId: number): Promise<unknown>
  /** 捨棄；undo 把失敗列放回去。 */
  discardFailed(row: FailedRow): Promise<{ undo: Undo }>
}

export type LogPatchInput = Partial<Pick<LogRecord, 'qty' | 'grams' | 'kcal' | 'protein' | 'fat' | 'carb' | 'ts' | 'day' | 'name'>>

type ItemInput = MutationArgs<'items.upsert@1'>

/** 本機驗證丟出的「店名重複」：回 { id, name }，不是就回 null。 */
export function duplicateStoreOf(e: unknown): { id: string; name: string } | null {
  if (!(e instanceof MutationError) || e.code !== 'duplicate_name') return null
  const d = e.details as { existingId?: unknown; existingName?: unknown } | undefined
  return typeof d?.existingId === 'string' && typeof d?.existingName === 'string' ? { id: d.existingId, name: d.existingName } : null
}

export function createActions(deps: ActionDeps): Actions {
  const { client } = deps
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? uid

  const mutate = client.mutate.bind(client)

  /**
   * 品項的 ts 是「建立時間」，core 的 items.upsert 用 `a.ts || existing.ts`。編輯既有品項要把原本的 ts 帶回去
   * （不然每改一次營養素，建立時間就被洗掉）；新的 id 才用現在。
   */
  async function itemTs(id: string): Promise<string> {
    return (await client.db.view('items').get(id))?.ts ?? taipeiIso(now())
  }

  function itemInput(item: MergedItem, macros: Macros4, ts: string): ItemInput {
    if (item.src === 'custom') {
      return {
        id: item.id,
        kind: '自建',
        base_id: null,
        src: item.sheetSrc,
        name: item.name,
        serving: item.serving,
        serving_g: item.servingG,
        ...macros,
        store_id: item.storeId || null,
        ts,
      }
    }
    // 官方品項：補填存成 ov:<官方 id>
    return {
      id: 'ov:' + item.id,
      kind: '補填',
      base_id: item.id,
      src: item.sheetSrc,
      name: item.name,
      serving: item.serving,
      serving_g: item.servingG,
      ...macros,
      store_id: null,
      ts,
    }
  }

  return {
    async recordLog(a) {
      const { item } = a
      const filled = a.nutrition
        ? { ...item, ...a.nutrition, needsFill: false }
        : a.fill
          ? { ...item, protein: a.fill.protein, fat: a.fill.fat, carb: a.fill.carb, needsFill: false }
          : item
      const per = itemMacros(filled)
      if (!per) throw new Error('品項缺少營養素')
      const useGrams = a.grams != null && !!item.servingG
      const macros = useGrams ? fromGrams(per, a.grams as number, item.servingG as number).macros : fromQty(per, a.qty)
      const qty = useGrams ? (a.grams as number) / (item.servingG as number) : a.qty
      const ms = now()
      const ts = taipeiIso(ms)
      const logId = newId()
      let fillItem: ItemInput | undefined
      const fillId = item.src === 'custom' ? item.id : 'ov:' + item.id
      if (a.fill) {
        fillItem = itemInput(item, { kcal: item.kcal, protein: a.fill.protein, fat: a.fill.fat, carb: a.fill.carb }, await itemTs(fillId))
      } else if (a.nutrition && item.src === 'custom') {
        fillItem = itemInput(filled, a.nutrition, await itemTs(fillId))
      }
      await mutate('logs.add@1', {
        log: {
          id: logId,
          ts,
          day: taipeiToday(ms),
          item_id: item.id,
          name: item.name,
          src: item.sheetSrc,
          qty,
          grams: a.grams,
          ...macros,
          source: 'app',
          store_id: item.storeId || null,
        },
        ...(fillItem ? { item: fillItem } : {}),
      })
      return { logId, qty, grams: a.grams, undo: () => mutate('logs.delete@1', { id: logId }) }
    },

    async quickLog(v) {
      const ms = now()
      const logId = newId()
      await mutate('logs.add@1', {
        log: {
          id: logId,
          ts: taipeiIso(ms),
          day: taipeiToday(ms),
          item_id: null,
          name: v.name.trim(),
          src: '其他',
          qty: 1,
          grams: null,
          kcal: v.kcal,
          protein: v.protein,
          fat: v.fat,
          carb: v.carb,
          source: 'quick',
          store_id: null,
        },
      })
      return { logId, undo: () => mutate('logs.delete@1', { id: logId }) }
    },

    async setFavorite(itemId, fav) {
      await mutate('favorites.set@1', { item_id: itemId, fav })
      return { undo: () => mutate('favorites.set@1', { item_id: itemId, fav: !fav }) }
    },

    async createStore(name) {
      const id = 's:' + newId()
      await mutate('stores.upsert@1', { id, name, ts: taipeiIso(now()) })
      return { id }
    },

    async renameStore(store, name) {
      await mutate('stores.upsert@1', { id: store.id, name, ts: store.ts })
    },

    async deleteStore(id) {
      await mutate('stores.delete@1', { id })
      return { undo: () => mutate('stores.restore@1', { id }) }
    },

    async saveStoreItem(a) {
      const id = a.itemId?.startsWith('u:') ? a.itemId : 'u:' + newId()
      await mutate('items.upsert@1', {
        id,
        kind: '自建',
        base_id: null,
        src: '其他',
        name: a.name,
        serving: '1 份',
        serving_g: null,
        kcal: a.kcal,
        protein: a.protein,
        fat: a.fat,
        carb: a.carb,
        store_id: a.storeId,
        ts: await itemTs(id),
      })
      return { id }
    },

    async saveItem(a) {
      const id = a.id?.startsWith('u:') ? a.id : 'u:' + newId()
      await mutate('items.upsert@1', {
        id,
        kind: '自建',
        base_id: null,
        src: a.src,
        name: a.name,
        serving: a.serving,
        serving_g: a.servingG,
        kcal: a.kcal,
        protein: a.protein,
        fat: a.fat,
        carb: a.carb,
        store_id: a.storeId || null,
        ts: await itemTs(id),
      })
      return { id }
    },

    async saveNutrition(item, n) {
      await mutate('items.upsert@1', itemInput(item, n, await itemTs(item.src === 'custom' ? item.id : 'ov:' + item.id)))
      return { saved: true as const }
    },

    async deleteItem(id) {
      await mutate('items.delete@1', { id })
      return { undo: () => mutate('items.restore@1', { id }) }
    },

    async recordWeight({ day, kg, today }) {
      const ts = day === today ? taipeiIso(now()) : `${day}T12:00:00+08:00`
      const res = await mutate('weights.upsert@1', { id: newId(), day, ts, kg })
      if ('duplicate' in res) return { undo: async () => undefined, overwritten: false, prevKg: null }
      if (res.overwritten && res.prevKg != null) {
        const prevKg = res.prevKg
        return { overwritten: true, prevKg, undo: () => mutate('weights.upsert@1', { id: newId(), day, ts, kg: prevKg }) }
      }
      return { overwritten: false, prevKg: null, undo: () => mutate('weights.delete@1', { id: res.rowId }) }
    },

    async updateLog(log, patch) {
      await mutate('logs.update@1', { id: log.id, patch })
      return {
        undo: () =>
          mutate('logs.update@1', {
            id: log.id,
            patch: { qty: log.qty, grams: log.grams, kcal: log.kcal, protein: log.protein, fat: log.fat, carb: log.carb, ts: log.ts, day: log.day, name: log.name },
          }),
      }
    },

    async deleteLog(id) {
      await mutate('logs.delete@1', { id })
      return { undo: () => mutate('logs.restore@1', { id }) }
    },

    async setConfig(key, value) {
      await mutate('config.set@1', { key, value })
    },

    retryFailed: (mutationId) => client.retryFailed(mutationId),

    async discardFailed(row) {
      await client.discardFailed(row.mutationId)
      return {
        undo: async () => {
          await client.db.failed.put(row)
          await client.status.refresh(client.db)
        },
      }
    },
  }
}
