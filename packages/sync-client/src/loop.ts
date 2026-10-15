// 同步迴圈（PRD §5.5、計畫 §3.5）。一次「循環」= push 再 pull（由 client 提供）；這裡管什麼時候跑、失敗怎麼辦。
//
// 觸發時機：start（打開 App）、visibilitychange 變 visible、online、每次 mutate 之後、前景時每 60 秒。
// 同時只跑一個循環；跑的時候又被觸發就在這個循環結束後再補跑一次。
//
// 失敗：
//   NetworkError / 5xx / 未知錯誤  → 依序等 2、5、15 秒各重試一次；三次都失敗就不再排程，等下一個觸發時機。
//                                    被觸發時若有重試排程就取消它、立刻跑（失敗次數照算）；沒有排程（閒置或已放棄）就當作新的一輪，次數歸零。
//   4xx（非 401、409）             → phase=error，不重試，等下一個觸發時機。
//   401                            → phase=auth，pending 保留；之後的自動觸發都不跑，登入完成後呼叫 resume()。
//   409 client_too_old             → phase=too_old；停止同步（要重新載入新版本）。
import { AuthError, HttpError, NetworkError, TooOldError, errorCode } from './transport'
import type { StatusStore } from './status'

export const BACKOFF_MS = [2_000, 5_000, 15_000] as const
export const FOREGROUND_INTERVAL_MS = 60_000

/** 外部事件來源（瀏覽器的 document／window）。測試給假的。 */
export interface LoopEnv {
  isVisible(): boolean
  /** 頁面回到前景。回傳取消訂閱。 */
  onVisible(cb: () => void): () => void
  /** 網路恢復。回傳取消訂閱。 */
  onOnline(cb: () => void): () => void
}

export function browserLoopEnv(): LoopEnv {
  const doc = typeof document === 'undefined' ? undefined : document
  const win = typeof window === 'undefined' ? undefined : window
  return {
    isVisible: () => (doc ? doc.visibilityState === 'visible' : true),
    onVisible: (cb) => {
      if (!doc) return () => {}
      const h = () => {
        if (doc.visibilityState === 'visible') cb()
      }
      doc.addEventListener('visibilitychange', h)
      return () => doc.removeEventListener('visibilitychange', h)
    },
    onOnline: (cb) => {
      if (!win) return () => {}
      win.addEventListener('online', cb)
      return () => win.removeEventListener('online', cb)
    },
  }
}

export interface SyncLoopOptions {
  /** 一次 push + pull。丟出 transport 的錯誤類別。 */
  cycle: () => Promise<void>
  status: StatusStore
  env?: LoopEnv
  backoffMs?: readonly number[]
  intervalMs?: number
  /** 一個循環成功之後呼叫（更新 lastPullAt 之類）。 */
  onSuccess?: () => void
}

export class SyncLoop {
  private readonly cycle: () => Promise<void>
  private readonly status: StatusStore
  private readonly env: LoopEnv
  private readonly backoff: readonly number[]
  private readonly intervalMs: number
  private readonly onSuccess: (() => void) | undefined

  private running: Promise<void> | null = null
  private rerun = false
  private failures = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private intervalTimer: ReturnType<typeof setInterval> | undefined
  private unsubs: (() => void)[] = []
  private started = false
  /** auth / too_old：不再自動同步。 */
  private halted = false

  constructor(opts: SyncLoopOptions) {
    this.cycle = opts.cycle
    this.status = opts.status
    this.env = opts.env ?? browserLoopEnv()
    this.backoff = opts.backoffMs ?? BACKOFF_MS
    this.intervalMs = opts.intervalMs ?? FOREGROUND_INTERVAL_MS
    this.onSuccess = opts.onSuccess
  }

  get isStarted(): boolean {
    return this.started
  }

  /** 開始：註冊觸發時機並立刻跑一次。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.unsubs.push(this.env.onVisible(() => this.trigger('visible')))
    this.unsubs.push(this.env.onOnline(() => this.trigger('online')))
    this.intervalTimer = setInterval(() => {
      if (this.env.isVisible()) this.trigger('interval')
    }, this.intervalMs)
    this.trigger('start')
  }

  stop(): void {
    this.started = false
    for (const u of this.unsubs) u()
    this.unsubs = []
    clearInterval(this.intervalTimer)
    this.intervalTimer = undefined
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  /** 登入完成後：解除 auth 狀態並立刻同步。（too_old 不能 resume：要重新載入。） */
  resume(): void {
    if (this.status.getSnapshot().phase === 'too_old') return
    this.halted = false
    this.trigger('resume')
  }

  /** 觸發一次循環（不等它）。 */
  trigger(_reason: string): void {
    if (this.halted) return
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    } else if (!this.running) {
      this.failures = 0 // 閒置或已放棄重試後的新觸發：新的一輪退避
    }
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = this.drain()
  }

  /** 等目前的循環（含補跑）結束。測試和「立刻同步」用；失敗不會丟出，看 status。 */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.rerun = false
        await this.runOnce()
      } while (this.rerun && !this.halted)
    } finally {
      this.running = null
    }
  }

  private async runOnce(): Promise<void> {
    clearTimeout(this.retryTimer) // 補跑（或被觸發）時，舊的重試排程作廢
    this.retryTimer = undefined
    this.status.set({ phase: 'syncing' })
    try {
      await this.cycle()
    } catch (e) {
      this.onFailure(e)
      return
    }
    this.failures = 0
    this.status.set({ phase: 'idle', error: null })
    this.onSuccess?.()
  }

  private onFailure(e: unknown): void {
    const error = errorCode(e)
    if (e instanceof AuthError) {
      this.halted = true
      this.rerun = false
      this.status.set({ phase: 'auth', error })
      return
    }
    if (e instanceof TooOldError) {
      this.halted = true
      this.rerun = false
      this.status.set({ phase: 'too_old', error })
      return
    }
    const transient = e instanceof NetworkError || (e instanceof HttpError ? e.status >= 500 : true)
    this.status.set({ phase: e instanceof NetworkError ? 'offline' : 'error', error })
    if (!transient) return
    const delay = this.backoff[this.failures]
    this.failures++
    if (delay !== undefined && this.started) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        if (this.running) this.rerun = true
        else this.running = this.drain()
      }, delay)
    }
  }
}
