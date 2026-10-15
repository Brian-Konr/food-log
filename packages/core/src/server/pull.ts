// 伺服器處理 pull（計畫 §3.4、PRD §5.3）。
//   - cookie = `<epoch>:<version>`，回傳 version > cookie.version 的所有列（含軟刪除的 tombstone）。
//   - 一律分頁：每頁最多 pageRows 列，只在版本號之間切（同一個版本的列一定在同一頁；單一版本比一頁大時整個版本放一頁）。
//   - epoch 不同（備份還原／重新匯入）或 cookie 比伺服器還新：reset=true，從頭開始送。
//   - 也回傳這台裝置的 lastMutationId 與它的業務錯誤。
//   - 讀取順序：先 cursor（lastMutationId 與錯誤），再 meta，最後列。一筆 mutation 的列和 cursor 在同一個 batch 提交，
//     所以「先讀到 cursor = m」代表 m 的列在之後讀的 meta／列裡一定看得到；反過來（先讀列再讀 cursor）會出現
//     「回應宣稱 m 已處理、但列還沒在回應裡」，前端會把待送的 m 丟掉，畫面上那一列閃一下消失。
import { emptyChanges, formatCookie, parseCookie } from '../protocol/pull'
import type { PullQuery, PullResponse } from '../protocol/pull'
import type { UserStore, VersionedRow } from './store'
import { PULL_PAGE_ROWS } from '../protocol/pull'

export type PullOptions = {
  minClientVersion: number
  pageRows?: number | undefined
}

export async function pull(store: UserStore, query: PullQuery, opts: PullOptions): Promise<PullResponse> {
  const limit = opts.pageRows ?? PULL_PAGE_ROWS
  // 1. cursor 與錯誤（錯誤在 cursor 之後讀，才不會漏掉 <= cursor 的；之後才提交的 > cursor 的不回，因為還沒「宣稱」它）。
  const lastMutationId = await store.getLastMutationId(query.clientId)
  const errors = (await store.listErrors(query.clientId, query.afterMutationId))
    .filter((e) => e.mutationId <= lastMutationId)
    .map((e) => ({
      mutationId: e.mutationId,
      name: e.name,
      error: e.error,
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
      at: e.at,
    }))
  // 2. meta，3. 列：版本號按提交順序遞增，meta.version 以內的列一定已經提交。
  const meta = await store.readMeta()
  const cookie = parseCookie(query.cookie)
  const reset = cookie.epoch !== null && (cookie.epoch !== meta.epoch || cookie.version > meta.version)
  const after = reset ? 0 : cookie.version

  const fetched = await store.rowsAfter(after, limit + 1)
  let page: VersionedRow[]
  let more: boolean
  let nextVersion: number
  if (fetched.length <= limit) {
    page = fetched
    more = false
    nextVersion = Math.max(after, meta.version, fetched.at(-1)?.row.version ?? 0)
  } else {
    // 多了一列：從第 limit+1 列的版本號切開，這一頁只放更早的版本。
    const boundary = fetched[limit]!.row.version
    page = fetched.filter((r) => r.row.version < boundary)
    more = true
    if (page.length === 0) {
      // 第一個版本就超過一頁：整個版本放這一頁。
      page = await store.rowsAtVersion(boundary)
      nextVersion = boundary
    } else {
      nextVersion = page.at(-1)!.row.version
    }
  }

  const changes = emptyChanges()
  for (const r of page) (changes[r.table] as unknown[]).push(r.row)

  return {
    cookie: formatCookie(meta.epoch, nextVersion),
    more,
    reset,
    lastMutationId,
    minClientVersion: opts.minClientVersion,
    changes,
    errors,
  }
}
