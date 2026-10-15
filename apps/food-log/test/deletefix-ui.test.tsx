// @vitest-environment jsdom
// 失敗清單（sync-client 的 failed 表）在畫面上的樣子：v1 文案、重試／捨棄、復原回失敗清單。
// 讓伺服器拒絕特定 mutation（MemoryTransport.rejectMutation → 4xx）來製造失敗。
import { afterEach, expect, test } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { mountApp, openEnv, seed, settle } from './harness'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const SEARCH = '搜尋店家、7-11、全家、我的品項'

async function quickLogSoy(user: ReturnType<typeof mountApp>['user'], name = '刪除修復豆漿') {
  await user.click(await screen.findByRole('button', { name: SEARCH }))
  await user.click(screen.getByRole('button', { name: '不指定店家' }))
  await user.type(screen.getByLabelText('品名'), name)
  await user.type(screen.getByLabelText('熱量'), '100')
  await user.type(screen.getByLabelText('蛋白質'), '10')
  await user.type(screen.getByLabelText('碳水'), '10')
  await user.type(screen.getByLabelText('脂肪'), '1')
  await user.click(screen.getByRole('button', { name: '記錄' }))
}

test('刪掉失敗的新增，復原回失敗清單，不送 logs.delete', async () => {
  const env = await openEnv({ synced: true })
  env.transport.rejectMutation = (m) => (m.name === 'logs.add@1' ? { status: 400, message: '壞' } : null)
  const { user } = mountApp(env)
  await quickLogSoy(user)
  await waitFor(() => expect(screen.getAllByText(/沒有存到/).length).toBeGreaterThan(0))
  await user.click(screen.getByRole('button', { name: /刪除修復豆漿/ }))
  await user.click(screen.getByRole('button', { name: '刪除' }))
  await waitFor(() => expect(screen.getByText('已刪除 刪除修復豆漿')).toBeTruthy())
  expect(screen.getByRole('button', { name: '復原' })).toBeTruthy()
  expect(screen.queryByText('刪除失敗')).toBeNull()
  await waitFor(() => expect(screen.queryByRole('button', { name: /刪除修復豆漿/ })).toBeNull())
  await user.click(screen.getByRole('button', { name: '復原' }))
  await waitFor(() => expect(screen.getAllByText(/沒有存到/).length).toBeGreaterThan(0))
  expect(screen.getByRole('button', { name: /刪除修復豆漿/ })).toBeTruthy()
  // 從頭到尾沒有任何 logs.delete 進佇列或送出
  expect(env.transport.rejectedIds.flat().length).toBeGreaterThan(0)
  expect((await env.client.db.pending.toArray()).some((p) => p.name === 'logs.delete@1')).toBe(false)
  expect(await env.client.db.failed.count()).toBe(1)
})

test('失敗的新增：編輯面板有重試與捨棄；重試用新的 mutationId 再送一次', async () => {
  const env = await openEnv({ synced: true })
  let reject = true
  env.transport.rejectMutation = (m) => (reject && m.name === 'logs.add@1' ? { status: 400, message: '壞' } : null)
  const { user } = mountApp(env)
  await quickLogSoy(user, '重試豆漿')
  await waitFor(() => expect(screen.getAllByText(/沒有存到/).length).toBeGreaterThan(0))
  const [failedBefore] = await env.client.db.failed.toArray()
  reject = false
  await user.click(screen.getByRole('button', { name: /重試豆漿/ }))
  expect(screen.getByRole('button', { name: '捨棄' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '重試' }))
  await settle(env)
  await waitFor(() => expect(env.server.db.all('logs').filter((l) => l.deleted_at === null)).toHaveLength(1))
  const failedAfter = await env.client.db.failed.toArray()
  expect(failedAfter.find((f) => f.mutationId === failedBefore!.mutationId)).toBeUndefined()
})

test('捨棄失敗刪除，不跳第二個 toast，重開不再出現', async () => {
  const server = (await openEnv()).server
  await seed(server, 'logs.add@1', {
    log: {
      id: 'l-synced', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: null, name: '已同步豆漿', src: '其他',
      qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 10, source: 'quick', store_id: null,
    },
  })
  const env = await openEnv({ server, synced: true })
  env.transport.rejectMutation = (m) => (m.name === 'logs.delete@1' ? { status: 400, message: '壞掉' } : null)
  const { user, unmount } = mountApp(env)
  await user.click(await screen.findByRole('button', { name: /已同步豆漿/ }))
  await user.click(screen.getByRole('button', { name: '刪除' }))
  await waitFor(() => expect(screen.getByText('刪除失敗，已還原 已同步豆漿')).toBeTruthy())
  expect(screen.getByRole('button', { name: '捨棄' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重試' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '捨棄' }))
  await waitFor(() => expect(screen.queryByText('刪除失敗，已還原 已同步豆漿')).toBeNull())
  expect(screen.getByRole('button', { name: /已同步豆漿/ })).toBeTruthy()
  expect(await env.client.db.failed.count()).toBe(0)
  unmount()
  mountApp(env)
  await waitFor(() => expect(screen.getByRole('button', { name: /已同步豆漿/ })).toBeTruthy())
  expect(screen.queryByText('刪除失敗，已還原 已同步豆漿')).toBeNull()
})

test('設定頁列出沒有存到的動作，可以重試或捨棄', async () => {
  const env = await openEnv({ synced: true })
  env.transport.rejectMutation = (m) => (m.name === 'config.set@1' || m.name === 'favorites.set@1' ? { status: 400, message: '拒絕' } : null)
  const { user } = mountApp(env, { hash: '/settings' })
  await user.click(await screen.findByRole('button', { name: /熱量/ }))
  const input = screen.getByLabelText(/熱量目標/)
  await user.clear(input)
  await user.type(input, '1800')
  await user.click(screen.getByRole('button', { name: '儲存' }))
  await waitFor(() => expect(screen.getByText('沒有存到 · 重試')).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '捨棄' }))
  await waitFor(() => expect(screen.queryByText('沒有存到 · 重試')).toBeNull())
})
