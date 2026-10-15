// POST /sync/push（計畫 §3.4）
//   請求：{ clientId, mutations: [{ id, name: "logs.add@1", args, clientTs }] }   ≤ 50 筆
//   200：{ lastMutationId, results: [{id, ok, result?} | {id, ok:false, error, message, details?}] }
//   409：{ error:'client_too_old', minClientVersion }；401；5xx（暫時性，前端退避 2/5/15 秒）
import { z } from 'zod'

export const MAX_PUSH_MUTATIONS = 50

export const pushMutationSchema = z.object({
  /** 這台裝置遞增的 mutationId（正整數）。 */
  id: z.number().int().positive(),
  /** `name@version`，例如 logs.add@1。 */
  name: z.string(),
  args: z.unknown(),
  /** 前端產生 mutation 的時間（epoch ms）。只用來除錯，伺服器不依賴它。 */
  clientTs: z.number(),
})
export type PushMutation = z.infer<typeof pushMutationSchema>

export const pushRequestSchema = z.object({
  /** 每個安裝一個 UUID。 */
  clientId: z.string().min(1),
  mutations: z.array(pushMutationSchema).max(MAX_PUSH_MUTATIONS),
})
export type PushRequest = z.infer<typeof pushRequestSchema>

export type PushResultOk = { id: number; ok: true; result?: unknown }
export type PushResultError = {
  id: number
  ok: false
  /** bad_record | forbidden | duplicate_name | not_found */
  error: string
  message: string
  details?: Record<string, unknown>
}
export type PushResult = PushResultOk | PushResultError

export type PushResponse = {
  /** 這台裝置伺服器已處理到的 mutationId。 */
  lastMutationId: number
  results: PushResult[]
}

export type ClientTooOldResponse = { error: 'client_too_old'; minClientVersion: number }
