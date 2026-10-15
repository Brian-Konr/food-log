// MemoryTransport：把 Transport 接到 core 的 MemoryServer（直接呼叫 processPush／pull，固定一個使用者，不經過網路）。
// 請求與回應都先過一次 JSON，行為和真的 HTTP 一樣（不能偷偷傳 Date、undefined 或共用參照）。
// 測試可以控制：離線、未登入（401）、版本太舊（409）、下一次 push 的故障（掉請求、掉回應、重複送）。
import { CLIENT_VERSION, OWNER, isClientTooOld, processPush, pull } from '@food-log/core'
import type { PullQuery, PullResponse, PushMutation, PushRequest, PushResponse, UserStore } from '@food-log/core'
import type { MemoryServer } from '@food-log/core/testing'
import { AuthError, HttpError, NetworkError, TooOldError } from '../transport'
import type { Transport } from '../transport'

/**
 * 下一次 push 的故障：
 *   none          正常
 *   dropRequest   請求在路上掉了（伺服器沒收到）→ NetworkError
 *   dropResponse  伺服器處理完了，但回應掉了 → NetworkError（用戶端不知道已經生效）
 *   duplicate     同一個請求送了兩次（重送／重複投遞），用戶端收到其中一個回應
 */
export type PushFault = 'none' | 'dropRequest' | 'dropResponse' | 'duplicate'

export interface MemoryTransportOptions {
  server: MemoryServer
  /** 預設是 MemoryServer 的預設使用者。 */
  userId?: string
  /** 包一層 UserStore（測試用來計算 commit 次數）。 */
  wrapStore?: (store: UserStore) => UserStore
}

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export class MemoryTransport implements Transport {
  online = true
  signedIn = true
  clientVersion = CLIENT_VERSION
  nextPushFault: PushFault = 'none'
  /** 統計 */
  pushCalls = 0
  pullCalls = 0
  /**
   * 測試用：讓含有特定 mutation 的 push 請求整個被伺服器以 4xx 拒絕（毒藥 mutation，例如 400 validation）。
   * 回傳 null 表示這筆沒問題。請求被拒時伺服器什麼都沒處理，也不算進 pushedIds。
   */
  rejectMutation: ((m: PushMutation) => { status: number; message: string } | null) | null = null
  /** 被 rejectMutation 拒絕的請求（每次記含的 mutation id）。 */
  readonly rejectedIds: number[][] = []
  /** 每次 push 請求到達伺服器時帶的 mutation id（掉請求的不算）。 */
  readonly pushedIds: number[][] = []

  constructor(private readonly opts: MemoryTransportOptions) {}

  private store(): UserStore {
    const s = this.opts.server.forUser(this.opts.userId ?? this.opts.server.defaultUserId)
    return this.opts.wrapStore ? this.opts.wrapStore(s) : s
  }

  private gate(): void {
    if (!this.online) throw new NetworkError('offline')
    if (!this.signedIn) throw new AuthError()
    if (isClientTooOld(this.clientVersion, this.opts.server.minClientVersion)) throw new TooOldError(this.opts.server.minClientVersion)
  }

  async push(req: PushRequest): Promise<PushResponse> {
    this.pushCalls++
    this.gate()
    const fault = this.nextPushFault
    this.nextPushFault = 'none'
    if (fault === 'dropRequest') throw new NetworkError('request lost')
    const body = json(req)
    if (this.rejectMutation) {
      for (const m of body.mutations) {
        const rej = this.rejectMutation(m)
        if (rej) {
          this.rejectedIds.push(body.mutations.map((x) => x.id))
          throw new HttpError(rej.status, rej.message)
        }
      }
    }
    this.pushedIds.push(body.mutations.map((m) => m.id))
    const { server } = this.opts
    const res = json(await processPush(this.store(), server.ctx(OWNER), body))
    if (fault === 'duplicate') await processPush(this.store(), server.ctx(OWNER), json(req))
    if (fault === 'dropResponse') throw new NetworkError('response lost')
    return res
  }

  async pull(query: PullQuery): Promise<PullResponse> {
    this.pullCalls++
    this.gate()
    const { server } = this.opts
    return json(await pull(this.store(), json(query), { minClientVersion: server.minClientVersion, pageRows: server.pageRows }))
  }
}
