// LocalTx：core 的 Tx 在 Dexie「畫面表」上的實作（和 D1 版、MemoryTx 版共用同一組 mutator）。
//
// ── Dexie 交易的自動提交規則（一定要遵守）──────────────────────────────────────────────────
// IndexedDB 交易在「沒有待處理的請求」時會自動提交。Dexie 讓 `await` Dexie 自己的 promise 時交易保持開著，
// 但 mutator 如果 `await` 了「外來的」promise（fetch、setTimeout、crypto.subtle、別的資料庫…），
// 等它回來時交易已經提交完了：後面的 Dexie 操作會丟 TransactionInactiveError / PrematureCommitError，
// 而且前面已經做的寫入不會回滾，狀態就壞了。所以：
//   1. mutator（以及 LocalTx 的所有方法）在交易裡只能 await Dexie 的操作，不可以 await 別的東西。
//   2. LocalTx 自己遵守：讀取只 await Dexie；put 只進記憶體緩衝區，mutator 成功後由呼叫端 `flush()` 一次寫入
//      （所以 mutator 丟 MutationError 時什麼都沒寫，不依賴交易回滾）。
//   3. core 的 mutator 本來就是純的（見 packages/core/src/mutators）；test/local-tx.test.ts 有兩道防線：
//      靜態掃描 mutator 原始碼不得出現 fetch／setTimeout／new Promise 等，以及實際跑一個會 await 外來 promise 的
//      mutator，確認會失敗（而不是悄悄寫出半套資料）。
//
// ── 先讀後寫 ───────────────────────────────────────────────────────────────────────────────
// 和 MemoryTx 一樣：寫了之後再讀會直接丟錯。D1 版的寫入是緩衝的，寫後讀會讀到舊值；
// 本機也照這個語意，才不會出現「本機行得通、伺服器行為不同」的 mutator。
//
// ── touched ──────────────────────────────────────────────────────────────────────────────
// 記錄這次執行「寫過」的鍵（`<table>:<key>`）。讀過但沒寫的鍵不算：rebase 重設髒鍵時只需要知道 pending 會改到哪些列。
import { OWNER, defaultConfigRow, executeMutation, rowKey } from '@food-log/core'
import type { ConfigRow, Ctx, ItemRow, Row, RowInput, StoreRow, Table, Tx, WeightRow } from '@food-log/core'
import { CONFIG_KEY, putRows, touchKey } from './db'
import type { FoodLogDb } from './db'

type Buffered = { [T in Table]: { table: T; row: RowInput<T> } }[Table]

export class LocalTx implements Tx {
  private buffer: Buffered[] = []

  /** userId：蓋在本機寫入的列上（和 MemoryTx.applyTo 一樣）；version 一律 0（本機列沒有伺服器版本號）。 */
  constructor(
    private readonly db: FoodLogDb,
    readonly userId: string,
  ) {}

  private assertNoWrites(op: string): void {
    if (this.buffer.length > 0) {
      throw new Error(`LocalTx: 先寫後讀（${op}）。mutator 的讀取必須全部在第一個 put 之前（D1 的寫入是緩衝的，讀不到）。`)
    }
  }

  async get<T extends Table>(t: T, id: string): Promise<Row<T> | undefined> {
    this.assertNoWrites(`get ${t}`)
    const tbl = this.db.view(t)
    return (await tbl.get(t === 'config' ? CONFIG_KEY : id)) as Row<T> | undefined
  }

  async liveWeightOnDay(day: string): Promise<WeightRow | undefined> {
    this.assertNoWrites('liveWeightOnDay')
    return this.db.view('weights').where('day').equals(day).filter((w) => w.deleted_at === null).first()
  }

  async liveStoreByNorm(norm: string, exceptId?: string): Promise<StoreRow | undefined> {
    this.assertNoWrites('liveStoreByNorm')
    return this.db.view('stores').where('name_norm').equals(norm).filter((s) => s.deleted_at === null && s.id !== exceptId).first()
  }

  async itemsOfStore(storeId: string): Promise<ItemRow[]> {
    this.assertNoWrites('itemsOfStore')
    return this.db.view('items').where('store_id').equals(storeId).toArray()
  }

  async getConfig(): Promise<ConfigRow> {
    this.assertNoWrites('getConfig')
    return (await this.db.view('config').get(CONFIG_KEY)) ?? defaultConfigRow(this.userId)
  }

  put<T extends Table>(t: T, row: RowInput<T>): void {
    this.buffer.push({ table: t, row: structuredClone(row) } as Buffered)
  }

  hasWrites(): boolean {
    return this.buffer.length > 0
  }

  /** 這次寫過的鍵（去重）。 */
  touchedKeys(): string[] {
    return [...new Set(this.buffer.map((w) => touchKey(w.table, rowKey(w.table, w.row as { id?: string; item_id?: string }))))]
  }

  /** 把緩衝的寫入放進畫面表（trial 模式同時放進 srv 表）。只 await Dexie 操作。 */
  async flush(opts: { alsoSrv?: boolean } = {}): Promise<void> {
    const byTable = new Map<Table, Row<Table>[]>()
    for (const w of this.buffer) {
      const full = { ...w.row, user_id: this.userId, version: 0 } as Row<Table>
      const list = byTable.get(w.table)
      if (list) list.push(full)
      else byTable.set(w.table, [full])
    }
    this.buffer = []
    for (const [table, rows] of byTable) {
      await putRows(this.db.view(table) as never, table, rows as never)
      if (opts.alsoSrv) await putRows(this.db.srv(table) as never, table, rows as never)
    }
  }
}

/** 本機執行 mutator 用的 ctx：永遠是 owner，時間固定成 mutation 的 clientTs（重播才是確定的）。 */
export const localCtx = (clientTs: number): Ctx => ({ actor: OWNER, now: () => clientTs })

/**
 * 在「目前的 Dexie 交易裡」跑一次 mutator（參數驗證和業務規則都走 core 的 executeMutation，和 Worker 同一個入口）。
 * 還沒有 flush：呼叫端決定要不要寫（MutationError 時什麼都不寫）。必須在 db.transaction 裡呼叫。
 */
export async function runLocal(db: FoodLogDb, userId: string, name: string, args: unknown, clientTs: number): Promise<{ result: unknown; tx: LocalTx }> {
  const tx = new LocalTx(db, userId)
  const result = await executeMutation(tx, localCtx(clientTs), name, args)
  return { result, tx }
}
