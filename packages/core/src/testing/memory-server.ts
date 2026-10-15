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
import type { CommitInput, RecordedError, ServerStore, ServerTx, VersionedRow } from '../server/store'
import { MemoryDb, MemoryTx } from './memory-tx'

/** 固定的測試時鐘：2026-10-12（週一）中午，台北時間。 */
export const TEST_NOW = Date.parse('2026-10-12T12:00:00+08:00')

class MemoryServerTx implements ServerTx {
  readonly tx: MemoryTx
  readonly version: number
  readonly lastMutationId: number

  constructor(private readonly server: MemoryServer, private readonly clientId: string) {
    this.tx = new MemoryTx(server.db)
    this.version = server.db.version
    this.lastMutationId = server.db.clients.get(clientId) ?? 0
  }

  hasWrites(): boolean {
    return this.tx.hasWrites()
  }

  async commit(input: CommitInput): Promise<boolean> {
    const { db } = this.server
    await this.server.beforeCommit?.()
    // CAS：版本號和這台裝置的 lastMutationId 都還是 begin 時讀到的值才提交。
    if (db.version !== this.version || (db.clients.get(this.clientId) ?? 0) !== this.lastMutationId) return false
    if (input.error) {
      db.errors.push({ clientId: this.clientId, mutationId: input.mutationId, ...input.error })
    } else if (this.tx.hasWrites()) {
      const next = db.version + 1
      this.tx.applyTo(db, next)
      db.version = next
    }
    db.clients.set(this.clientId, input.mutationId)
    return true
  }
}

export class MemoryServer implements ServerStore {
  readonly db: MemoryDb
  now: () => number = () => TEST_NOW
  minClientVersion = CLIENT_VERSION
  pageRows: number | undefined
  /** 測試鉤子：commit 的 CAS 比對之前呼叫，可以在這裡插入別的寫入來製造並行衝突。 */
  beforeCommit: (() => void | Promise<void>) | undefined
  /** 統計：commit 被 CAS 擋下的次數由呼叫端自己數（見 process-push 測試）。 */
  private readonly nextIds = new Map<string, number>()

  constructor(opts: { userId?: string; now?: () => number } = {}) {
    this.db = new MemoryDb(opts.userId ?? 'u1')
    if (opts.now) this.now = opts.now
  }

  ctx(actor: Actor = OWNER): Ctx {
    return { actor, now: () => this.now() }
  }

  // ---- ServerStore ----

  async begin(clientId: string): Promise<ServerTx> {
    return new MemoryServerTx(this, clientId)
  }

  async readMeta(): Promise<{ epoch: string; version: number }> {
    return { epoch: this.db.epoch, version: this.db.version }
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

  async rowsAfter(afterVersion: number, limit: number): Promise<VersionedRow[]> {
    return this.collect((v) => v > afterVersion).slice(0, limit)
  }

  async rowsAtVersion(version: number): Promise<VersionedRow[]> {
    return this.collect((v) => v === version)
  }

  async getLastMutationId(clientId: string): Promise<number> {
    return this.db.clients.get(clientId) ?? 0
  }

  async getMutationError(clientId: string, mutationId: number): Promise<RecordedError | undefined> {
    return this.db.errors.find((e) => e.clientId === clientId && e.mutationId === mutationId)
  }

  async listErrors(clientId: string, afterMutationId: number): Promise<RecordedError[]> {
    return this.db.errors.filter((e) => e.clientId === clientId && e.mutationId > afterMutationId).sort((a, b) => a.mutationId - b.mutationId)
  }

  // ---- helpers ----

  push(req: PushRequest, actor: Actor = OWNER, opts?: ProcessPushOptions): Promise<PushResponse> {
    return processPush(this, this.ctx(actor), req, opts)
  }

  pull(query: Partial<PullQuery> & { clientId: string }): Promise<PullResponse> {
    return pull(this, { cookie: '', afterMutationId: 0, ...query }, { minClientVersion: this.minClientVersion, pageRows: this.pageRows })
  }

  /** 這個 actor 的專屬 clientId；每次呼叫 mutate 自動遞增 mutationId，像一台真的裝置。 */
  clientIdOf(actor: Actor): string {
    return `mem-${actor.name}`
  }

  /** 送一筆 mutation 並回傳它的結果。 */
  async mutate<N extends MutationName>(name: N, args: MutationArgs<N>, actor: Actor = OWNER): Promise<PushResult> {
    return this.mutateRaw(name, args, actor)
  }

  async mutateRaw(name: string, args: unknown, actor: Actor = OWNER): Promise<PushResult> {
    const clientId = this.clientIdOf(actor)
    const id = (this.nextIds.get(clientId) ?? (await this.getLastMutationId(clientId))) + 1
    this.nextIds.set(clientId, id)
    const res = await this.push({ clientId, mutations: [{ id, name, args, clientTs: this.now() }] }, actor)
    return res.results[0]!
  }

  asKyujin<N extends MutationName>(name: N, args: MutationArgs<N>): Promise<PushResult> {
    return this.mutate(name, args, KYUJIN)
  }

  /** 所有表目前的內容（含已刪除的列）。 */
  snapshot(): Changes {
    const snap = {} as Record<Table, unknown[]>
    for (const t of TABLES) snap[t] = this.db.all(t).map((r) => structuredClone(r))
    return snap as unknown as Changes
  }
}
