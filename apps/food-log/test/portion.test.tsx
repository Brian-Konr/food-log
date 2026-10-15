// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { mountApp, openEnv } from './harness'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const SEARCH = '搜尋店家、7-11、全家、我的品項'

// 離線（transport 掉線）：寫入留在 pending，不會送出，看得到每個 mutation 的名稱和參數
async function offlineEnv() {
  const env = await openEnv({ synced: true })
  env.transport.online = false
  return env
}

async function openPasta(user: ReturnType<typeof mountApp>['user']) {
  await user.click(await screen.findByRole('button', { name: SEARCH }))
  await user.type(screen.getByRole('searchbox'), '義大利')
  await user.click(screen.getByText('晶英-麻辣奶油鮮蝦義大利麵'))
}

test('完整品項不會先出補營養素步', async () => {
  const env = await offlineEnv()
  const { user } = mountApp(env)
  await user.click(await screen.findByRole('button', { name: SEARCH }))
  await user.type(screen.getByRole('searchbox'), '雞胸')
  await user.click(screen.getByText('法式香草嫩雞胸'))
  expect(screen.queryByText('先補上營養素')).toBeNull()
  expect(screen.getByRole('button', { name: '記錄' })).toBeTruthy()
})

test('三欄未填「下一步」停用；填 0 可以', async () => {
  const env = await offlineEnv()
  const { user } = mountApp(env)
  await openPasta(user)
  expect(screen.getByText('先補上營養素')).toBeTruthy()
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true)
  const inputs = screen.getAllByPlaceholderText('必填，可以填 0')
  await user.type(inputs[0], '0')
  await user.type(inputs[1], '0')
  await user.type(inputs[2], '0')
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false)
})

test('按取消或關閉後待送佇列仍是 0', async () => {
  const env = await offlineEnv()
  const { user } = mountApp(env)
  await openPasta(user)
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(await env.client.db.pending.count()).toBe(0)
})

test('按記錄後只有一個 mutation：logs.add 帶 ov: 補填品項（補填取代 groupId，同一個交易）', async () => {
  const env = await offlineEnv()
  const { user } = mountApp(env)
  await openPasta(user)
  const inputs = screen.getAllByPlaceholderText('必填，可以填 0')
  await user.type(inputs[0], '0')
  await user.type(inputs[1], '0')
  await user.type(inputs[2], '0')
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(async () => expect(await env.client.db.pending.count()).toBe(1))
  const [p] = await env.client.db.pending.toArray()
  expect(p!.name).toBe('logs.add@1')
  const args = p!.args as { log: { item_id: string }; item?: { id: string; kind: string; base_id: string } }
  expect(args.item).toMatchObject({ id: 'ov:711:89f35c5c37', kind: '補填', base_id: '711:89f35c5c37' })
  expect(args.log.item_id).toBe('711:89f35c5c37')
})
