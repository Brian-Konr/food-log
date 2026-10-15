// pull：帶著 cookie 一頁一頁拉，`more=true` 就繼續（計畫 §3.4）。
// 每一頁一個 Dexie 交易（applyPullPage）；只有 more=false 的最後一頁才處理 lastMutationId 與 errors，reset 在第一頁。
// cookie 每頁都存：中途斷線下次從上次的版本號繼續。
import { CLIENT_VERSION, isClientTooOld } from '@food-log/core'
import type { FoodLogDb } from './db'
import { applyPullPage } from './rebase'
import { TooOldError } from './transport'
import type { Transport } from './transport'

/** 單次 pull 最多幾頁（防無窮迴圈；每頁 1,000 列，一年資料不到 1 萬列）。 */
export const MAX_PULL_PAGES = 500

export interface PullEnv {
  db: FoodLogDb
  transport: Transport
  now: () => number
  onChanged?: (() => void) | undefined
}

export async function pullAll(env: PullEnv): Promise<void> {
  const { db, transport } = env
  const clientId = await db.getMeta<string>('clientId', '')
  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const cookie = await db.getMeta<string>('cookie', '')
    const afterMutationId = await db.getMeta<number>('lastMutationId', 0)
    const resp = await transport.pull({ cookie, clientId, afterMutationId })
    if (isClientTooOld(CLIENT_VERSION, resp.minClientVersion)) throw new TooOldError(resp.minClientVersion)
    await applyPullPage(db, resp, env.now())
    env.onChanged?.()
    if (!resp.more) return
  }
  throw new Error(`pull 超過 ${MAX_PULL_PAGES} 頁還沒結束`)
}
