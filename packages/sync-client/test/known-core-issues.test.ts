// core 的已知問題（property test 找到的）。不在 sync-client 修（計畫：core 由別處維護）；
// 用 it.fails 把現況記下來——等 core 修好，這個測試會「意外通過」而失敗，到時候把 it.fails 改成 it，並放寬 property.test.ts 的 item.restore。
import { MemoryServer, itemArgs, storeArgs } from '@food-log/core/testing'
import { describe, expect, it } from 'vitest'

describe('core 已知問題', () => {
  it.fails('items.restore 會讓「未刪除的品項」出現在已刪除的店（stores.delete 之後單獨復原品項）', async () => {
    const server = new MemoryServer()
    await server.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '店' }))
    await server.mutate('items.upsert@1', itemArgs({ id: 'u:1', store_id: 's:1' }))
    await server.mutate('stores.delete@1', { id: 's:1' }) // 連帶刪除品項（cascade_of = s:1）
    await server.mutate('items.restore@1', { id: 'u:1' }) // 伺服器照單全收：品項復活，店還是刪除的
    const store = server.db.tables.stores.get('s:1')!
    const item = server.db.tables.items.get('u:1')!
    expect(store.deleted_at).not.toBeNull()
    // 期望：復原要嘛被擋下（bad_record），要嘛品項仍是已刪除。
    expect(item.deleted_at).not.toBeNull()
  })
})
