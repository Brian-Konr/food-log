import { expect, test } from 'vitest'
import { expectErr, expectOk, newServer, row } from './helpers'

test('favorites.set：加入、取消（deleted_at）、再加入；pull 帶得走取消收藏', async () => {
  const s = newServer()
  expectOk(await s.mutate('favorites.set@1', { item_id: 'fm:1', fav: true }))
  expect(row(s, 'favorites', 'fm:1').deleted_at).toBeNull()
  const v1 = s.db.version
  expectOk(await s.mutate('favorites.set@1', { item_id: 'fm:1', fav: true })) // 已經是：不寫入
  expect(s.db.version).toBe(v1)
  const cookie = (await s.pull({ clientId: 'c' })).cookie
  expectOk(await s.mutate('favorites.set@1', { item_id: 'fm:1', fav: false }))
  expect(row(s, 'favorites', 'fm:1').deleted_at).not.toBeNull()
  const p = await s.pull({ clientId: 'c', cookie })
  expect(p.changes.favorites).toHaveLength(1)
  expect(p.changes.favorites[0]!.deleted_at).not.toBeNull()
  expectOk(await s.mutate('favorites.set@1', { item_id: 'fm:1', fav: true }))
  expect(row(s, 'favorites', 'fm:1').deleted_at).toBeNull()
})

test('取消一個從沒收藏過的品項：不產生列', async () => {
  const s = newServer()
  expectOk(await s.mutate('favorites.set@1', { item_id: 'u:x', fav: false }))
  expect(s.db.all('favorites')).toHaveLength(0)
  expect(s.db.version).toBe(0)
})

test('只有 owner：Kyujin forbidden；缺 item_id bad_record', async () => {
  const s = newServer()
  expectErr(await s.asKyujin('favorites.set@1', { item_id: 'fm:1', fav: true }), 'forbidden')
  expectErr(await s.mutate('favorites.set@1', { item_id: '', fav: true }), 'bad_record')
  expectErr(await s.mutateRaw('favorites.set@1', { item_id: 'fm:1', fav: 'yes' }), 'bad_record')
})
