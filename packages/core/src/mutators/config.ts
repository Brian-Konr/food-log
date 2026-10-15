// config.set。驗證規則照 legacy/gas/Code.gs 的 setConfig_，存成有型別的欄位。只有 owner。
import type { Ctx } from '../actor'
import { badRecord, forbidden } from '../errors'
import { KYU_MSG, canSetConfig } from '../permissions'
import type { ConfigSetArgs } from '../schema/args'
import { isConfigKey } from '../schema/config'
import type { ConfigKey } from '../schema/config'
import type { ConfigRow } from '../schema/rows'
import type { Tx } from '../tx'
import { nowIso, stripKeys } from './common'

export type ConfigSetResult = { key: ConfigKey }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function validHhmm(s: string): boolean {
  return HHMM.test(s)
}

export async function runConfigSet(tx: Tx, ctx: Ctx, a: ConfigSetArgs): Promise<ConfigSetResult> {
  if (!canSetConfig(ctx.actor)) throw forbidden(KYU_MSG)
  const key = a.key
  if (!isConfigKey(key)) throw badRecord('不能寫這個設定')
  const value = a.value
  const v = value === undefined || value === null ? '' : Array.isArray(value) ? value.join(',') : String(value)
  const patch: Partial<ConfigRow> = {}
  switch (key) {
    case 'tdee':
      if (v !== '' && (!/^\d+$/.test(v) || Number(v) < 1200 || Number(v) > 5000)) {
        throw badRecord('每日消耗必須是 1200 到 5000 的整數')
      }
      patch.tdee = v === '' ? null : Number(v)
      break
    case 'target_kcal':
      if (!/^\d+$/.test(v) || Number(v) < 0) throw badRecord('熱量目標必須是 ≥ 0 的整數')
      patch.target_kcal = Number(v)
      break
    case 'target_protein':
    case 'target_fat':
    case 'target_carb':
      if (v === '' || Number(v) < 0 || !isFinite(Number(v))) throw badRecord('營養素目標必須 ≥ 0')
      patch[key] = Number(v)
      break
    case 'remind_meal_times': {
      const parts = v === '' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean)
      for (const p of parts) if (!validHhmm(p)) throw badRecord('提醒時間格式不對')
      patch.remind_meal_times = parts
      break
    }
    case 'remind_weight_time':
      if (v !== '' && !validHhmm(v)) throw badRecord('提醒時間格式不對')
      patch.remind_weight_time = v === '' ? null : v
      break
  }
  const cur = await tx.getConfig()
  tx.put('config', { ...stripKeys(cur), ...patch, deleted_at: null, updated_at: nowIso(ctx) })
  return { key }
}
