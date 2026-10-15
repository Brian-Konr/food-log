// MemoryServer：記憶體版 ServerStore（樂觀並行控制和 D1 版同一套流程），加上方便測試的 helper。
import { KYUJIN, OWNER } from '../actor'
import type { Actor, Ctx } from '../actor'
import type { Changes, PullQuery, PullResponse } from '../protocol/pull'
import type { PushRequest, PushResponse, PushResult } from '../protocol/push'
import { CLIENT_VERSION } from '../protocol/version'
import type { MutationArgs, MutationName } from '../registry'
import { TABLES } from '../schema/rows'
import type { Table } from '../schema/rows'
import { processPush } from '../server/process-push'
import type { ProcessPushOptions } from '../server/process-push'
import { pull } from '../server/pull'
import { MUTATION_OUTCOME_RETENTION } from '../server/store'
import type { CommitInput, MutationOutcome, RecordedError, ServerStore, ServerTx, UserStore, VersionedRow } from '../server/store'
import { MemoryDb, MemoryTx } from './memory-tx'
import type { MemoryMeta } from './memory-tx'

/** 固定的測試時鐘：2026-10-12（週一）中午，台北時間。 */
export const TEST_NOW = Date.parse('2026-10-12T12:00:00+08:00')

/** 讀取的種類（給 MemoryServer.afterRead 鉤子用）。 */
export type ReadOp = 'getLastMutationId' | 'listErrors' | 'readMeta' | 'rowsAfter' | 'rowsAtVersion' | 'getMutationOutcome'

class MemoryServerTx implements ServerTx {
  readonly tx: MemoryTx
  readonly version: number
  readonly lastMutationId: number

  constructor(private readonly server: MemoryServer, private readonly db: MemoryDb, private readonly clientId: string) {
    this.tx = new MemoryTx(db)
    this.version = db.version
    this.lastMutationId = db.clients.get(clientId) ?? 0
  }

  hasWrites(): boolean {
    return this.tx.hasWrites()
  }

  async commit(input: CommitInput): Promise<boolean> {
    const { db } = this
    await this.server.beforeCommit?.()
    // CAS：全域版本號和這台裝置的 lastMutationId 都還是 begin 時讀到的值才提交（兩個 guard，見 server/store.ts）。
    if (db.version !== this.version || (db.clients.get(this.clientId) ?? 0) !== this.lastMutationId) return false
    if (!input.ok) {
      db.errors.push({ clientId: this.clientId, mutationId: input.mutationId, ...input.error })
    } else {
      if (this.tx.hasWrites()) {
        this.tx.assertUnique(db) // 丟 MutationError('bad_record')；什麼都還沒寫
        const next = db.version + 1
        this.tx.applyTo(db, next)
        db.version = next
      }
      db.outcomes.set(outcomeKey(this.clientId, input.mutationId), JSON.stringify(input.result ?? null))
      // 只保留最近 MUTATION_OUTCOME_RETENTION 筆。
      const cutoff = input.mutationId - MUTATION_OUTCOME_RETENTION
      const prefix = `${this.clientId}\u0000`
      for (const key of db.outcomes.keys()) {
        if (key.startsWith(prefix) && Number(key.slice(prefix.length)) <= cutoff) db.outcomes.delete(key)
      }
    }
    db.clients.set(this.clientId, input.mutationId)
    return true
  }
}

const outcomeKey = (clientId: string, mutationId: number) => `${clientId}\u0000${mutationId}`

/** 綁定一個使用者的記憶體儲存。 */
class MemoryUserStore implements UserStore {
  constructor(private readonly server: MemoryServer, readonly db: MemoryDb) {}

  get userId(): string {
    return this.db.userId
  }

  private async read<T>(op: ReadOp, f: () => T): Promise<T> {
    const out = f()
    await this.server.afterRead?.(op)
    return out
  }

  async begin(clientId: string): Promise<ServerTx> {
    return new MemoryServerTx(this.server, this.db, clientId)
  }

  readMeta(): Promise<{ epoch: string; version: number }> {
    return this.read('readMeta', () => ({ epoch: this.db.epoch, version: this.db.version }))
  }

  private collect(pred: (version: number) => boolean): VersionedRow[] {
    const out: VersionedRow[] = []
    for (const table of TABLES) {
      for (const row of this.db.tables[table].values()) {
        if (pred(row.version)) out.push({ table, row: structuredClone(row) } as VersionedRow)
      }
    }
    const order = (t: Table) => TABLES.indexOf(t)
    return out.sort((a, b) => a.row.version - b.row.version || order(a.table) - order(b.table))
  }

  rowsAfter(afterVersion: number, limit: number): Promise<VersionedRow[]> {
    return this.read('rowsAfter', () => this.collect((v) => v > afterVersion).slice(0, limit))
  }

  rowsAtVersion(version: number): Promise<VersionedRow[]> {
    return this.read('rowsAtVersion', () => this.collect((v) => v === version))
  }

  getLastMutationId(clientId: string): Promise<number> {
    return this.read('getLastMutationId', () => this.db.clients.get(clientId) ?? 0)
  }

  getMutationOutcome(clientId: string, mutationId: number): Promise<MutationOutcome | undefined> {
    return this.read('getMutationOutcome', (): MutationOutcome | undefined => {
      const err = this.db.errors.find((e) => e.clientId === clientId && e.mutationId === mutationId)
      if (err) return { ok: false, error: err }
      const json = this.db.outcomes.get(outcomeKey(clientId, mutationId))
      return json === undefined ? undefined : { ok: true, result: JSON.parse(json) as unknown }
    })
  }

  listErrors(clientId: string, afterMutationId: number): Promise<RecordedError[]> {
    return this.read('listErrors', () =>
      this.db.errors.filter((e) => e.clientId === clientId && e.mutationId > afterMutationId).sort((a, b) => a.mutationId - b.mutationId),
    )
  }
}

/**
 * MemoryServer：記憶體版 ServerStore（`forUser` 給出各使用者互相隔離的資料；版本號與 epoch 全域共用，和 D1 一樣），
 * 加上方便測試的 helper。helper（push／pull／mutate／getLastMutationId／db…）都針對「預設使用者」（`opts.userId`，預設 u1）。
 */
export class MemoryServer implements ServerStore {
  /** 預設使用者的資料（測試直接讀寫用）。 */
  readonly db: MemoryDb
  readonly meta: MemoryMeta = { version: 0, epoch: 'e1' }
  now: () => number = () => TEST_NOW
  minClientVersion = CLIENT_VERSION
  pageRows: number | undefined
  /** 測試鉤子：commit 的 CAS 比對之前呼叫，可以在這裡插入別的寫入來製造並行衝突。 */
  beforeCommit: (() => void | Promise<void>) | undefined
  /** 測試鉤子：每次讀取完成之後呼叫（讀的結果已經定下來），可以在這裡讓別的 push 提交，驗證 pull 的讀取順序。 */
  afterRead: ((op: ReadOp) => void | Promise<void>) | undefined
  /** 統計：commit 被 CAS 擋下的次數由呼叫端自己數（見 process-push 測試）。 */
  private readonly nextIds = new Map<string, number>()
  private readonly users = new Map<string, MemoryUserStore>()
  readonly defaultUserId: string

  constructor(opts: { userId?: string; now?: () => number } = {}) {
    this.defaultUserId = opts.userId ?? 'u1'
    this.db = this.userStore(this.defaultUserId).db
    if (opts.now) this.now = opts.now
  }

  ctx(actor: Actor = OWNER): Ctx {
    return { actor, now: () => this.now() }
  }

  // ---- ServerStore ----

  private userStore(userId: string): MemoryUserStore {
    let u = this.users.get(userId)
    if (!u) {
      u = new MemoryUserStore(this, new MemoryDb(userId, this.meta))
      this.users.set(userId, u)
    }
    return u
  }

  forUser(userId: string): UserStore {
    return this.userStore(userId)
  }

  /** 某個使用者的資料（測試直接讀寫用）。 */
  dbOf(userId: string): MemoryDb {
    return this.userStore(userId).db
  }

  /** 預設使用者的儲存。 */
  get store(): UserStore {
    return this.userStore(this.defaultUserId)
  }

  getLastMutationId(clientId: string): Promise<number> {
    return this.store.getLastMutationId(clientId)
  }

  // ---- helpers ----

  push(req: PushRequest, actor: Actor = OWNER, opts?: ProcessPushOptions, userId: string = this.defaultUserId): Promise<PushResponse> {
    return processPush(this.forUser(userId), this.ctx(actor), req, opts)
  }

  pull(query: Partial<PullQuery> & { clientId: string }, userId: string = this.defaultUserId): Promise<PullResponse> {
    return pull(this.forUser(userId), { cookie: '', afterMutationId: 0, ...query }, { minClientVersion: this.minClientVersion, pageRows: this.pageRows })
  }

  /** 這個 actor 的專屬 clientId；每次呼叫 mutate 自動遞增 mutationId，像一台真的裝置。 */
  clientIdOf(actor: Actor): string {
    return `mem-${actor.name}`
  }

  /** 送一筆 mutation 並回傳它的結果。 */
  async mutate<N extends MutationName>(name: N, args: MutationArgs<N>, actor: Actor = OWNER): Promise<PushResult> {
    return this.mutateRaw(name, args, actor)
  }

  async mutateRaw(name: string, args: unknown, actor: Actor = OWNER, userId: string = this.defaultUserId): Promise<PushResult> {
    const clientId = this.clientIdOf(actor)
    const key = `${userId}|${clientId}`
    const id = (this.nextIds.get(key) ?? (await this.forUser(userId).getLastMutationId(clientId))) + 1
    this.nextIds.set(key, id)
    const res = await this.push({ clientId, mutations: [{ id, name, args, clientTs: this.now() }] }, actor, undefined, userId)
    return res.results[0]!
  }

  /** 以另一個使用者的身分送一筆 mutation（測試使用者隔離）。 */
  mutateAs<N extends MutationName>(userId: string, name: N, args: MutationArgs<N>, actor: Actor = OWNER): Promise<PushResult> {
    return this.mutateRaw(name, args, actor, userId)
  }

  asKyujin<N extends MutationName>(name: N, args: MutationArgs<N>): Promise<PushResult> {
    return this.mutate(name, args, KYUJIN)
  }

  /** 預設使用者所有表目前的內容（含已刪除的列）。 */
  snapshot(): Changes {
    const snap = {} as Record<Table, unknown[]>
    for (const t of TABLES) snap[t] = this.db.all(t).map((r) => structuredClone(r))
    return snap as unknown as Changes
  }
}
