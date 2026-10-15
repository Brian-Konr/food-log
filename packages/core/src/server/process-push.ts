// 伺服器處理 push（計畫 §3.4）。對每一筆 mutation：
//   1. id <= lastMutationId：已經處理過，不再執行，回傳當時的結果（業務錯誤會原樣再回一次）。
//   2. 名稱不認得、zod 驗證失敗：bad_record（業務錯誤）。
//   3. 讀到版本號 V，執行 mutator，提交（CAS；失敗重讀重試，最多 5 次，之後當暫時性錯誤）。
//   4. 業務錯誤：記錄、推進 lastMutationId、版本號不變。
//   5. ignored／duplicate（沒有寫入）：只推進 lastMutationId。
//   6. 其他錯誤（儲存層失敗、CAS 用盡）：整批中止，丟出去給路由回 503；前面已提交的會在重送時被當成已處理。
import type { Ctx } from '../actor'
import { MutationError, TransientError, isMutationError } from '../errors'
import { taipeiIso } from '../time'
import type { PushMutation, PushRequest, PushResponse, PushResult } from '../protocol/push'
import { executeMutation, lookupMutation } from '../registry'
import type { ErrorInput, ServerStore } from './store'

export const MAX_CAS_ATTEMPTS = 5

export type ProcessPushOptions = {
  /** 只允許這些 `name@version`（/bot/v1/mutate 用）。不在清單內的回 forbidden。 */
  allow?: readonly string[] | undefined
  maxAttempts?: number | undefined
}

export async function processPush(store: ServerStore, ctx: Ctx, req: PushRequest, opts: ProcessPushOptions = {}): Promise<PushResponse> {
  const maxAttempts = opts.maxAttempts ?? MAX_CAS_ATTEMPTS
  const results: PushResult[] = []
  let lastMutationId = await store.getLastMutationId(req.clientId)
  for (const m of req.mutations) {
    let done = false
    for (let attempt = 0; attempt < maxAttempts && !done; attempt++) {
      const stx = await store.begin(req.clientId)
      lastMutationId = stx.lastMutationId
      if (m.id <= stx.lastMutationId) {
        results.push(await replayed(store, req.clientId, m))
        done = true
        break
      }
      let error: ErrorInput | undefined
      let result: unknown
      try {
        const rejected = rejectReason(m, opts)
        if (rejected) throw rejected
        result = await executeMutation(stx.tx, ctx, m.name, m.args)
      } catch (e) {
        if (!isMutationError(e)) throw e
        error = { name: m.name, error: e.code, message: e.message, details: e.details, at: taipeiIso(ctx.now()) }
      }
      const committed = await stx.commit({ mutationId: m.id, error })
      if (!committed) continue // CAS 失敗：重讀重試
      lastMutationId = m.id
      results.push(error ? errorResult(m.id, error) : { id: m.id, ok: true, result })
      done = true
    }
    if (!done) throw new TransientError(`mutation ${m.id} 的 CAS 重試 ${maxAttempts} 次仍失敗`)
  }
  return { lastMutationId, results }
}

function rejectReason(m: PushMutation, opts: ProcessPushOptions): MutationError | null {
  if (opts.allow && !opts.allow.includes(m.name)) return new MutationError('forbidden', `這個身分不能執行 ${m.name}`)
  if (!lookupMutation(m.name)) return new MutationError('bad_record', `未知的 mutation：${m.name}`)
  return null
}

function errorResult(id: number, e: ErrorInput): PushResult {
  return { id, ok: false, error: e.error, message: e.message, ...(e.details ? { details: e.details } : {}) }
}

async function replayed(store: ServerStore, clientId: string, m: PushMutation): Promise<PushResult> {
  const rec = await store.getMutationError(clientId, m.id)
  if (rec) return errorResult(m.id, rec)
  // 成功的結果沒有另外存；重送只需要知道「已經生效」。
  return { id: m.id, ok: true, result: { replayed: true } }
}
