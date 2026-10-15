// SyncClient：把 db、mutate、push、pull、loop、status 接起來的門面。App 只持有一個（登入後 userId 一個資料庫；試用模式 userId=null）。
//
// 試用模式（userId === null，資料庫 food-log-local）：
//   - mutate 同時寫 srv 與畫面表，不進 pending；
//   - 沒有 transport、沒有 loop，永遠不 push；
//   - 登入是另開一個 food-log-<userId> 資料庫，**不會**把試用資料上傳或搬過去。
import type { MutationArgs, MutationName, MutationResult } from '@food-log/core'
import { openDb } from './db'
import type { FailedRow, FoodLogDb, Mode } from './db'
import { SyncLoop, browserLoopEnv } from './loop'
import type { LoopEnv } from './loop'
import { mutate as mutateLocal, mutateUntyped } from './mutate'
import { PushCursor, pushPending } from './push'
import { pullAll } from './pull'
import { StatusStore, initialStatus } from './status'
import type { SyncStatus } from './status'
import type { Transport } from './transport'

export interface SyncClientOptions {
  /** 登入的使用者 id；null = 本機試用模式。 */
  userId: string | null
  /** 帳號模式必填；試用模式不給。 */
  transport?: Transport
  now?: () => number
  loopEnv?: LoopEnv
  backoffMs?: readonly number[]
  intervalMs?: number
  /** 測試用：指定 IDBFactory（每台模擬裝置一個）與 IDBKeyRange。 */
  dexie?: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }
  /** 測試用：clientId 產生器（預設 crypto.randomUUID）。 */
  newId?: () => string
}

export class SyncClient {
  readonly mode: Mode
  readonly status = new StatusStore()
  private readonly loop: SyncLoop | null
  private readonly cursor = new PushCursor()
  private readonly now: () => number
  /** push／pull 一次只跑一個（loop 的循環和手動呼叫不會交錯）。 */
  private chain: Promise<unknown> = Promise.resolve()

  private constructor(
    readonly db: FoodLogDb,
    readonly userId: string | null,
    private readonly transport: Transport | null,
    opts: SyncClientOptions,
  ) {
    this.mode = userId === null ? 'trial' : 'account'
    this.now = opts.now ?? Date.now
    if (this.mode === 'trial') {
      this.status.set({ phase: 'local' })
      this.loop = null
    } else {
      this.loop = new SyncLoop({
        cycle: () => this.syncCycle(),
        status: this.status,
        env: opts.loopEnv ?? browserLoopEnv(),
        ...(opts.backoffMs ? { backoffMs: opts.backoffMs } : {}),
        ...(opts.intervalMs ? { intervalMs: opts.intervalMs } : {}),
      })
    }
  }

  static async open(opts: SyncClientOptions): Promise<SyncClient> {
    if (opts.userId !== null && !opts.transport) throw new Error('帳號模式需要 transport')
    const db = await openDb(opts.userId, { ...(opts.dexie ? { dexie: opts.dexie } : {}), ...(opts.newId ? { newId: opts.newId } : {}) })
    const client = new SyncClient(db, opts.userId, opts.userId === null ? null : (opts.transport ?? null), opts)
    await client.status.refresh(db)
    return client
  }

  // ---- 本機寫入 ----

  /** 本機優先寫入（見 mutate.ts）。MutationError 原樣丟出，什麼都沒寫。 */
  async mutate<N extends MutationName>(name: N, args: MutationArgs<N>): Promise<MutationResult<N>> {
    const r = await mutateLocal({ db: this.db, mode: this.mode, now: this.now, onQueued: () => this.afterMutate() }, name, args)
    await this.status.refresh(this.db)
    return r
  }

  private afterMutate(): void {
    // 只有 start() 過（App 正在前景同步）才自動 push；手動模式（測試、尚未登入完成）不動。
    if (this.loop?.isStarted) this.loop.trigger('mutate')
  }

  // ---- 失敗清單（重試 = 用新的 mutationId 再 mutate 一次；捨棄 = 刪掉） ----

  async retryFailed(mutationId: number): Promise<unknown> {
    const row = await this.db.failed.get(mutationId)
    if (!row) throw new Error(`沒有這筆失敗紀錄：${mutationId}`)
    const result = await mutateUntyped({ db: this.db, mode: this.mode, now: this.now, onQueued: () => this.afterMutate() }, row.name, row.args)
    await this.db.failed.delete(mutationId)
    await this.status.refresh(this.db)
    return result
  }

  async discardFailed(mutationId: number): Promise<void> {
    await this.db.failed.delete(mutationId)
    await this.status.refresh(this.db)
  }

  failedRows(): Promise<FailedRow[]> {
    return this.db.failed.orderBy('mutationId').toArray()
  }

  // ---- 同步 ----

  /** push 一次（不 pull）。傳輸錯誤直接丟出。給 loop 與測試用。 */
  pushOnce(): Promise<void> {
    return this.serial(async () => {
      if (!this.transport) throw new Error('試用模式不同步')
      await pushPending({ db: this.db, transport: this.transport, cursor: this.cursor, now: this.now, onChanged: () => void this.status.refresh(this.db).catch(() => {}) })
      await this.status.refresh(this.db)
    })
  }

  /** pull 到沒有下一頁為止（不 push）。傳輸錯誤直接丟出。 */
  pullOnce(): Promise<void> {
    return this.serial(async () => {
      if (!this.transport) throw new Error('試用模式不同步')
      await pullAll({ db: this.db, transport: this.transport, now: this.now })
      await this.status.refresh(this.db)
    })
  }

  private async syncCycle(): Promise<void> {
    await this.pushOnce()
    await this.pullOnce()
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f)
    this.chain = run.catch(() => undefined)
    return run
  }

  /** 開始自動同步（打開 App 時呼叫）。試用模式什麼都不做。 */
  start(): void {
    this.loop?.start()
  }

  stop(): void {
    this.loop?.stop()
  }

  /** 登入完成後（auth 狀態）重新開始同步。 */
  resume(): void {
    this.loop?.resume()
  }

  /** 立刻同步一次並等它結束（含補跑）；失敗不丟出，看 status。試用模式不做事。 */
  async syncNow(): Promise<void> {
    if (!this.loop) return
    this.loop.trigger('syncNow')
    await this.loop.whenIdle()
  }

  /** 等目前的同步循環結束（測試用）。 */
  async whenIdle(): Promise<void> {
    await this.loop?.whenIdle()
  }

  getStatus(): SyncStatus {
    return this.status.getSnapshot()
  }

  close(): void {
    this.stop()
    this.db.close()
  }

  /** 登出：停止同步並刪掉整個本機資料庫（有 pending 時 UI 要先確認，見 status.pendingCount）。 */
  async destroy(): Promise<void> {
    this.stop()
    await this.loop?.whenIdle()
    await this.db.delete()
    this.status.set(initialStatus(this.mode === 'trial' ? 'local' : 'idle'))
  }
}
