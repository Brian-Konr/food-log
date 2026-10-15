// 伺服器處理 push（計畫 §3.4）。對每一筆 mutation：
//   1. id <= lastMutationId：已經處理過，不再執行，回傳當時的結果（成功的結果和業務錯誤都原樣再回一次；
//      成功結果只保留最近 MUTATION_OUTCOME_RETENTION 筆，更舊的退回 {replayed:true}）。
//   2. 名稱不認得、zod 驗證失敗：bad_record（業務錯誤）。
//   3. 讀到版本號 V，執行 mutator，提交（CAS；失敗重讀重試，最多 5 次，之後當暫時性錯誤）。
//   4. 業務錯誤：記錄、推進 lastMutationId、版本號不變。commit 時違反唯一索引（guard 已通過）也算業務錯誤 bad_record，不重試。
//   5. ignored／duplicate（沒有寫入）：只推進 lastMutationId。
//   6. 其他錯誤（儲存層失敗、CAS 用盡）：整批中止，丟出去給路由回 503；前面已提交的會在重送時被當成已處理。
import type { Ctx } from '../actor'
import { MutationError, TransientError, isMutationError } from '../errors'
import { taipeiIso } from '../time'
import type { PushMutation, PushRequest, PushResponse, PushResult } from '../protocol/push'
import { executeMutation, lookupMutation } from '../registry'
import type { CommitInput, ErrorInput, UserStore } from './store'

export const MAX_CAS_ATTEMPTS = 5

export type ProcessPushOptions = {
  /** 只允許這些 `name@version`（/bot/v1/mutate 用）。不在清單內的回 forbidden。 */
  allow?: readonly string[] | undefined
  maxAttempts?: number | undefined
}

export async function processPush(store: UserStore, ctx: Ctx, req: PushRequest, opts: ProcessPushOptions = {}): Promise<PushResponse> {
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
      let committed: boolean
      try {
        committed = await stx.commit(commitInput(m.id, error, result))
      } catch (e) {
        // guard 通過後違反唯一索引：mutator 寫出了不合法的列（不是並行衝突）。改用業務錯誤提交，不重試同一份寫入。
        if (!isMutationError(e) || error) throw e
        error = { name: m.name, error: e.code, message: e.message, details: e.details, at: taipeiIso(ctx.now()) }
        committed = await stx.commit(commitInput(m.id, error, undefined))
      }
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

function commitInput(mutationId: number, error: ErrorInput | undefined, result: unknown): CommitInput {
  return error ? { ok: false, mutationId, error } : { ok: true, mutationId, result }
}

async function replayed(store: UserStore, clientId: string, m: PushMutation): Promise<PushResult> {
  const rec = await store.getMutationOutcome(clientId, m.id)
  if (rec?.ok === false) return errorResult(m.id, rec.error)
  if (rec?.ok === true) return { id: m.id, ok: true, result: rec.result }
  // 超過成功結果的保留範圍：只知道「已經生效」，拿不到原本的結果。
  return { id: m.id, ok: true, result: { replayed: true } }
}
