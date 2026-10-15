// @vitest-environment jsdom
// 啟動流程（Root）：試用 / 登入 / 離線打開 / 401 重新登入 / 登出 / 409 更新提示。
// authClient 與 LoginScreen 用替身（真的在 features/auth，有自己的測試）；SyncClient 是 sync-client + MemoryServer。
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory } from '@tanstack/history'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { SyncClient } from '@food-log/sync-client'
import { MemoryTransport } from '@food-log/sync-client/testing'
import App from '@/app/Root'
import type { AppProps } from '@/app/Root'
import { trackTooOld, setMinClientVersion } from '@/app/update-info'
import { KEYS, LEGACY_KEYS, cleanupLegacyKeys } from '@/lib/local-storage'
import { NOW, USER, chicken, newServer, openEnv, pasta } from './harness'

afterEach(() => {
  cleanup()
  localStorage.clear()
  setMinClientVersion(null)
  vi.restoreAllMocks()
})

function Login(props: { onSignedIn(): void }) {
  return (
    <div>
      <p>登入畫面（替身）</p>
      <button type="button" onClick={props.onSignedIn}>替身登入</button>
    </div>
  )
}

function boot(env: Awaited<ReturnType<typeof openEnv>> | null, session: () => Promise<{ userId: string; email: string } | null>, extra: Partial<AppProps> = {}) {
  const opened: (string | null)[] = []
  const signOut = vi.fn(async () => undefined)
  const openClient = async (userId: string | null) => {
    opened.push(userId)
    return userId === null ? (await openEnv({ trial: true })).client : env!.client
  }
  const getSession = vi.fn(session)
  const view = render(
    <App
      openClient={openClient}
      authClient={{ getSession, signOut }}
      LoginScreen={Login}
      catalogItems={[chicken, pasta]}
      now={() => NOW}
      history={createMemoryHistory({ initialEntries: ['/today'] })}
      {...extra}
    />,
  )
  return { opened, getSession, signOut, ...view }
}

test('有 session：開帳號模式的資料庫，記下 userId', async () => {
  const env = await openEnv({ synced: true })
  const b = boot(env, async () => ({ userId: USER, email: 'a@b.c' }))
  await screen.findByRole('button', { name: '搜尋店家、7-11、全家、我的品項' })
  expect(b.opened).toEqual([USER])
  expect(localStorage.getItem(KEYS.userId)).toBe(USER)
  expect(screen.queryByText('本機試用，不會同步到伺服器')).toBeNull()
})

test('沒登入（getSession 回 null）：登入畫面，不會用本機資料庫打開，即使以前登入過', async () => {
  localStorage.setItem(KEYS.userId, USER)
  const b = boot(null, async () => null)
  await screen.findByText('登入畫面（替身）')
  expect(b.opened).toEqual([])
})

test('登入畫面可以改選「先在這支手機試用」：開本機試用模式，記住選擇，下次不問 session', async () => {
  const b = boot(null, async () => null)
  const user = userEvent.setup()
  const trial = await screen.findByRole('button', { name: '先在這支手機試用' })
  // 在正常流程裡（LoginScreen 下面），不是 fixed：登入碼表單展開時不會蓋住它的送出鍵
  expect(trial.closest('.fixed')).toBeNull()
  expect(document.body.innerHTML.indexOf('登入畫面（替身）')).toBeLessThan(document.body.innerHTML.indexOf('先在這支手機試用'))
  await user.click(trial)
  expect(await screen.findByText('本機試用，不會同步到伺服器')).toBeTruthy()
  expect(b.opened).toEqual([null])
  expect(localStorage.getItem(KEYS.mode)).toBe('trial')
  cleanup()
  const again = boot(null, async () => null)
  expect(await screen.findByText('本機試用，不會同步到伺服器')).toBeTruthy()
  expect(again.getSession).not.toHaveBeenCalled()
})

test('離線打開（getSession 丟例外）：有登入過的 userId 就用本機資料庫；沒有就登入畫面', async () => {
  const env = await openEnv({ synced: true })
  localStorage.setItem(KEYS.userId, USER)
  const b = boot(env, async () => {
    throw new Error('network')
  })
  await screen.findByRole('button', { name: '搜尋店家、7-11、全家、我的品項' })
  expect(b.opened).toEqual([USER])
  cleanup()
  localStorage.clear()
  const c = boot(env, async () => {
    throw new Error('network')
  })
  await screen.findByText('登入畫面（替身）')
  expect(c.opened).toEqual([])
})

test('啟動時清掉 v1 的 localStorage 鍵（gasUrl、secret、mock…），主題等偏好不動', async () => {
  for (const k of LEGACY_KEYS) localStorage.setItem(k, 'x')
  localStorage.setItem(KEYS.theme, 'light')
  boot(null, async () => null)
  await screen.findByText('登入畫面（替身）')
  for (const k of LEGACY_KEYS) expect(localStorage.getItem(k)).toBeNull()
  expect(localStorage.getItem(KEYS.theme)).toBe('light')
  expect(cleanupLegacyKeys()).toEqual([]) // 第二次沒有東西可清
})

test('同步中收到 401：蓋一層登入畫面，待送資料保留；重新登入後繼續同步', async () => {
  const env = await openEnv({ synced: true })
  await env.client.mutate('favorites.set@1', { item_id: 'fm:1', fav: true })
  env.transport.signedIn = false
  boot(null, async () => ({ userId: USER, email: 'a@b.c' }), { client: env.client })
  await screen.findByText('登入畫面（替身）')
  expect(env.client.getStatus().phase).toBe('auth')
  expect(await env.client.db.pending.count()).toBe(1)
  env.transport.signedIn = true
  fireEvent.click(screen.getByRole('button', { name: '替身登入' }))
  await waitFor(() => expect(screen.queryByText('登入畫面（替身）')).toBeNull())
  await env.client.whenIdle()
  await waitFor(async () => expect(await env.client.db.pending.count()).toBe(0))
  expect(env.server.db.all('favorites').filter((f) => f.deleted_at === null)).toHaveLength(1)
})

async function openSettings(env: Awaited<ReturnType<typeof openEnv>>) {
  const b = boot(env, async () => ({ userId: USER, email: 'a@b.c' }), { history: createMemoryHistory({ initialEntries: ['/settings'] }) })
  const user = userEvent.setup()
  await screen.findByText('帳號')
  return { ...b, user }
}

test('登出：沒有待送資料就直接登出（通知伺服器、刪本機資料庫、回登入畫面）', async () => {
  const env = await openEnv({ synced: true })
  const b = await openSettings(env)
  await b.user.click(screen.getByRole('button', { name: '登出' }))
  await screen.findByText('登入畫面（替身）')
  expect(b.signOut).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(KEYS.userId)).toBeNull()
  await waitFor(async () => expect((await env.factory.databases()).map((d) => d.name)).not.toContain(`food-log-${USER}`))
})

test('登出：有待送資料先確認；取消什麼都不動，確認才登出', async () => {
  const env = await openEnv({ synced: true })
  env.transport.online = false
  await env.client.mutate('favorites.set@1', { item_id: 'fm:1', fav: true })
  const b = await openSettings(env)
  await b.user.click(screen.getByRole('button', { name: '登出' }))
  expect(await screen.findByText('還有 1 筆沒有上傳')).toBeTruthy()
  expect(b.signOut).not.toHaveBeenCalled()
  await b.user.click(screen.getByRole('button', { name: '取消' }))
  expect(b.signOut).not.toHaveBeenCalled()
  expect(await env.client.db.pending.count()).toBe(1)
  await b.user.click(screen.getByRole('button', { name: '登出' }))
  await b.user.click(await screen.findByRole('button', { name: '仍要登出' }))
  await screen.findByText('登入畫面（替身）')
  expect(b.signOut).toHaveBeenCalledTimes(1)
})

test('登出時連不到伺服器：不登出（cookie 還在），顯示原因，本機資料保留', async () => {
  const env = await openEnv({ synced: true })
  const b = await openSettings(env)
  b.signOut.mockRejectedValueOnce(new Error('network'))
  await b.user.click(screen.getByRole('button', { name: '登出' }))
  expect(await screen.findByText('連不到伺服器，無法登出')).toBeTruthy()
  expect(screen.queryByText('登入畫面（替身）')).toBeNull()
})

test('設定頁：試用模式沒有登出，有「登入」；點了回登入畫面（試用資料留在這支手機）', async () => {
  localStorage.setItem(KEYS.mode, 'trial')
  const b = boot(null, async () => null, { history: createMemoryHistory({ initialEntries: ['/settings'] }) })
  const user = userEvent.setup()
  await screen.findByText(/本機試用：資料只存在這支手機/)
  expect(screen.queryByRole('button', { name: '登出' })).toBeNull()
  await user.click(screen.getByRole('button', { name: /^登入/ }))
  await screen.findByText('登入畫面（替身）')
  expect(localStorage.getItem(KEYS.mode)).toBeNull()
  expect(b.getSession).toHaveBeenCalled()
})

test('409 client_too_old：顯示「有新版本」；minClientVersion >= 9999 是已暫停使用（沒有重新載入按鈕）', async () => {
  const server = newServer()
  const transport = new MemoryTransport({ server, userId: USER })
  transport.clientVersion = 0
  server.minClientVersion = 2
  const client = await SyncClient.open({
    userId: USER, transport: trackTooOld(transport), now: () => NOW, dexie: { indexedDB: new IDBFactory(), IDBKeyRange }, newId: () => 'c-old',
  })
  boot(null, async () => null, { client })
  expect(await screen.findByText('有新版本，請重新載入')).toBeTruthy()
  expect(screen.getByRole('button', { name: '重新載入' })).toBeTruthy()
  expect(client.getStatus().phase).toBe('too_old')
  cleanup()

  const server2 = newServer()
  const t2 = new MemoryTransport({ server: server2, userId: USER })
  t2.clientVersion = 0
  server2.minClientVersion = 9999
  const client2 = await SyncClient.open({
    userId: USER, transport: trackTooOld(t2), now: () => NOW, dexie: { indexedDB: new IDBFactory(), IDBKeyRange }, newId: () => 'c-old2',
  })
  boot(null, async () => null, { client: client2 })
  expect(await screen.findByText('這個版本已暫停使用，請改用舊版 App')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重新載入' })).toBeNull()
})
