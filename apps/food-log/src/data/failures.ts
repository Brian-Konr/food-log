// 失敗清單（sync-client 的 failed 表）的文案。沿用 v1 的字：「沒有存到」「刪除失敗，已還原 …」「收藏沒有存到」。
// 重試 = 用新的 mutationId 再 mutate 一次；捨棄 = 刪掉失敗列。
import type { FailedRow } from '@food-log/sync-client'

/** 這些錯誤重送也不會好：只留「捨棄」。其他（未知的、暫時性的）給「重試」。read_only 已不存在。 */
export const PERMANENT_ERRORS = new Set(['bad_record', 'forbidden', 'duplicate_name', 'not_found', 'bad_request'])

export const isPermanent = (f: FailedRow): boolean => PERMANENT_ERRORS.has(f.error)

const CONFIG_LABEL: Record<string, string> = {
  target_kcal: '熱量目標',
  target_protein: '蛋白質目標',
  target_carb: '碳水目標',
  target_fat: '脂肪目標',
  tdee: '每日消耗',
  remind_meal_times: '提醒時間',
  remind_weight_time: '提醒時間',
}

export type NameLookup = (table: 'logs' | 'items' | 'stores', id: string) => string | undefined

type Args = Record<string, unknown>
const argsOf = (f: FailedRow): Args => (f.args && typeof f.args === 'object' ? (f.args as Args) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 設定頁失敗清單的一行描述（不含「沒有存到」）。 */
export function failureLabel(f: FailedRow, nameOf?: NameLookup): string {
  const a = argsOf(f)
  const log = (a.log ?? {}) as Args
  switch (f.name) {
    case 'logs.add@1':
      return `新增 ${str(log.name).trim() || '快速記錄'}`
    case 'logs.update@1':
      return `修改 ${nameOf?.('logs', str(a.id)) ?? '紀錄'}`
    case 'logs.delete@1':
      return `刪除 ${nameOf?.('logs', str(a.id)) ?? '紀錄'}`
    case 'logs.restore@1':
      return `復原 ${nameOf?.('logs', str(a.id)) ?? '紀錄'}`
    case 'items.upsert@1':
      return `品項 ${str(a.name) || '品項'}`
    case 'items.delete@1':
      return `刪除 ${nameOf?.('items', str(a.id)) ?? '品項'}`
    case 'items.restore@1':
      return `復原 ${nameOf?.('items', str(a.id)) ?? '品項'}`
    case 'stores.upsert@1':
      return `店家 ${str(a.name) || '店家'}`
    case 'stores.delete@1':
      return `刪除 ${nameOf?.('stores', str(a.id)) ?? '店家'}`
    case 'stores.restore@1':
      return `復原 ${nameOf?.('stores', str(a.id)) ?? '店家'}`
    case 'weights.upsert@1':
      return typeof a.kg === 'number' ? `體重 ${a.kg.toFixed(1)} kg` : '體重'
    case 'weights.delete@1':
    case 'weights.restore@1':
      return '體重'
    case 'favorites.set@1':
      return '收藏'
    case 'config.set@1':
      return CONFIG_LABEL[str(a.key)] ?? '設定'
    default:
      return f.name
  }
}

/** 新出現的失敗要不要跳 toast；沒有（例如記一筆失敗，改列在清單裡）就回 null。 */
export function failureToast(f: FailedRow, nameOf?: NameLookup): { message: string } | null {
  const a = argsOf(f)
  if (f.name === 'stores.upsert@1') return { message: `${str(a.name) || '店家'}沒有存到` }
  if (f.name === 'logs.delete@1') {
    if (f.error === 'not_found') return null
    return { message: `刪除失敗，已還原 ${nameOf?.('logs', str(a.id)) || '紀錄'}` }
  }
  if (f.name === 'favorites.set@1') return { message: '收藏沒有存到' }
  return null
}
