// 曾經的 core 已知問題（property test 找到的），修好後留作回歸測試。
// items.restore 以前會讓「未刪除的品項」出現在已刪除的店（stores.delete 之後單獨復原品項）；現在 core 回 bad_record 擋下。
import { MemoryServer, itemArgs, storeArgs } from '@food-log/core/testing'
import { describe, expect, it } from 'vitest'

describe('core 回歸：items.restore 不能讓品項復活在已刪除的店', () => {
  it('stores.delete 之後單獨復原品項 → bad_record，品項仍是已刪除；先復原店家才能一起回來', async () => {
    const server = new MemoryServer()
    await server.mutate('stores.upsert@1', storeArgs({ id: 's:1', name: '店' }))
    await server.mutate('items.upsert@1', itemArgs({ id: 'u:1', store_id: 's:1' }))
    await server.mutate('stores.delete@1', { id: 's:1' }) // 連帶刪除品項（cascade_of = s:1）
    const res = await server.mutate('items.restore@1', { id: 'u:1' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toBe('bad_record')
    expect(server.db.tables.stores.get('s:1')!.deleted_at).not.toBeNull()
    expect(server.db.tables.items.get('u:1')!.deleted_at).not.toBeNull()
    await server.mutate('stores.restore@1', { id: 's:1' })
    expect(server.db.tables.items.get('u:1')!.deleted_at).toBeNull()
  })
})
