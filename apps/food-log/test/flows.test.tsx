// @vitest-environment jsdom
// 使用者流程：整個 App 跑在 sync-client 上（fake-indexeddb + MemoryServer + MemoryTransport），不經過網路。
import { afterEach, expect, test } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { chicken, liveRows, mountApp, openEnv, seed, settle, TODAY } from './harness'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const SEARCH = '搜尋店家、7-11、全家、我的品項'
const logsOf = (env: Awaited<ReturnType<typeof openEnv>>) => liveRows(env.server.db.all('logs'))

async function seedStore(server: Parameters<typeof seed>[0], withLog = true) {
  await seed(server, 'stores.upsert@1', { id: 's:1', name: '阿財牛肉麵', ts: '2026-10-09T12:00:00+08:00' })
  await seed(server, 'items.upsert@1', {
    id: 'u:beef', kind: '自建', base_id: null, src: '其他', name: '牛肉麵', serving: '1 份', serving_g: null,
    kcal: 520, protein: 28, fat: 18, carb: 62, store_id: 's:1', ts: '2026-10-09T12:00:00+08:00',
  })
  if (withLog) {
    await seed(server, 'logs.add@1', {
      log: {
        id: 'prev-beef', ts: '2026-10-09T12:00:00+08:00', day: '2026-10-09', item_id: 'u:beef', name: '牛肉麵', src: '其他', qty: 1, grams: null,
        kcal: 520, protein: 28, fat: 18, carb: 62, source: 'app', store_id: 's:1',
      },
    })
  }
}

test('完整品項：搜尋框、結果、記錄，三下後今天出現該筆，伺服器剛好一筆', async () => {
  const env = await openEnv({ synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await user.click(screen.getByRole('button', { name: SEARCH }))
  await user.type(screen.getByRole('searchbox'), '雞胸')
  await user.click(screen.getByText('法式香草嫩雞胸'))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('法式香草嫩雞胸').length).toBeGreaterThan(0))
  await settle(env)
  expect(logsOf(env)).toHaveLength(1)
  expect(logsOf(env)[0]).toMatchObject({ item_id: chicken.id, day: TODAY, source: 'app', kcal: 106 })
})

test('常吃膠囊：點膠囊、份量已是上次的 qty、再點記錄，兩下完成', async () => {
  const server = (await openEnv()).server
  await seed(server, 'favorites.set@1', { item_id: 'fm:1032099', fav: true })
  await seed(server, 'logs.add@1', {
    log: {
      id: 'prev', ts: '2026-10-09T12:00:00+08:00', day: '2026-10-09', item_id: 'fm:1032099', name: '法式香草嫩雞胸', src: '全家', qty: 1.5,
      grams: null, kcal: 159, protein: 31.2, fat: 2.3, carb: 3.5, source: 'app', store_id: null,
    },
  })
  const env = await openEnv({ server, synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await waitFor(() => expect(screen.getByRole('button', { name: /法式香草嫩雞胸/ })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: /法式香草嫩雞胸/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: '1.5' }).className).toMatch(/bg-primary/))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('法式香草嫩雞胸').length).toBeGreaterThan(0))
})

test('右上記體重沒有數字；點它再點記錄送出一筆體重', async () => {
  const server = (await openEnv()).server
  await seed(server, 'weights.upsert@1', { id: 'w-prev', day: '2026-10-09', ts: '2026-10-09T08:00:00+08:00', kg: 72.6 })
  const env = await openEnv({ server, synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await waitFor(() => expect(document.querySelector('[data-load-state="fresh"]')).toBeTruthy())
  const btn = screen.getByRole('button', { name: '記體重' })
  expect(btn.textContent).not.toMatch(/\d/)
  await user.click(btn)
  await waitFor(() => expect((screen.getByLabelText('體重（kg）') as HTMLInputElement).value).toBe('72.6'))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await settle(env)
  await waitFor(() => expect(liveRows(env.server.db.all('weights'))).toHaveLength(2))
  expect(liveRows(env.server.db.all('weights')).find((w) => w.day === TODAY)?.kg).toBe(72.6)
})

test('#weight 深連結：Sheet 一開始就開著；關掉回 #today', async () => {
  const env = await openEnv({ synced: true })
  const { user, history } = mountApp(env, { hash: '/weight' })
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
  expect(screen.getByText('記體重')).toBeTruthy()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(history.location.pathname).toBe('/today'))
})

test('只有熱量的結果列文字含要補營養素', async () => {
  const env = await openEnv({ synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await user.click(screen.getByRole('button', { name: SEARCH }))
  await user.type(screen.getByRole('searchbox'), '義大利')
  expect(screen.getByText(/要補營養素/)).toBeTruthy()
})

test('已有店家品項：店家膠囊、品項、記錄，三次 click 今天多一筆', async () => {
  const server = (await openEnv()).server
  await seedStore(server)
  const env = await openEnv({ server, synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await waitFor(() => expect(screen.getByRole('button', { name: '店家 阿財牛肉麵' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '店家 阿財牛肉麵' }))
  await user.click(screen.getByText('牛肉麵'))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('牛肉麵').length).toBeGreaterThan(0))
  await settle(env)
  expect(logsOf(env).filter((l) => l.day === TODAY)).toHaveLength(1)
  // last_eaten_at 由 logs.add 往後更新
  expect(env.server.db.all('stores').find((s) => s.id === 's:1')?.last_eaten_at?.slice(0, 10)).toBe(TODAY)
})

test('搜尋到記錄：搜尋框、結果、記錄，三次 click', async () => {
  const server = (await openEnv()).server
  await seedStore(server, false)
  const env = await openEnv({ server, synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await user.click(screen.getByRole('button', { name: SEARCH }))
  await user.type(screen.getByRole('searchbox'), '牛肉')
  await user.click(screen.getByRole('button', { name: /店家品項/ }))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('牛肉麵').length).toBeGreaterThan(0))
})

test('快速記錄：搜尋框、不指定店家、記錄，三次 click；品名空、不建 Items', async () => {
  const env = await openEnv({ synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await user.click(screen.getByRole('button', { name: SEARCH }))
  await user.click(screen.getByRole('button', { name: '不指定店家' }))
  const inputs = screen.getAllByPlaceholderText('必填，可以填 0')
  await user.type(inputs[0], '300')
  await user.type(inputs[1], '20')
  await user.type(inputs[2], '30')
  await user.type(inputs[3], '10')
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getByText('快速記錄')).toBeTruthy())
  await settle(env)
  expect(env.server.db.all('items')).toHaveLength(0)
  expect(logsOf(env).some((l) => l.source === 'quick' && l.item_id === null && l.qty === 1)).toBe(true)
})

test('新增店家與品項再記錄', async () => {
  const env = await openEnv({ synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await user.click(screen.getByRole('button', { name: SEARCH }))
  await user.click(screen.getByRole('button', { name: '＋ 新增店家' }))
  await user.type(screen.getByLabelText('店名'), '測試麵店')
  await user.click(screen.getByRole('button', { name: '建立' }))
  await waitFor(() => expect(screen.getByText('這家店還沒有品項')).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '＋ 新增品項' }))
  await user.type(screen.getByLabelText('品名'), '陽春麵')
  const inputs = screen.getAllByPlaceholderText('必填，可以填 0')
  await user.type(inputs[0], '400')
  await user.type(inputs[1], '12')
  await user.type(inputs[2], '70')
  await user.type(inputs[3], '8')
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getByText('份量')).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('陽春麵').length).toBeGreaterThan(0))
  await settle(env)
  expect(liveRows(env.server.db.all('stores')).length).toBeGreaterThan(0)
  expect(liveRows(env.server.db.all('items')).length).toBeGreaterThan(0)
  expect(logsOf(env).length).toBeGreaterThan(0)
  await user.click(screen.getByRole('button', { name: '店家 測試麵店' }))
  const dlg = screen.getByRole('dialog')
  expect(dlg.textContent).toContain('陽春麵')
  expect(dlg.textContent).not.toContain('還沒吃過')
  expect(dlg.textContent).not.toContain('這家店還沒有品項')
})

test('店名重複：不建立、顯示已有同名店家（本機驗證，不打伺服器）', async () => {
  const server = (await openEnv()).server
  await seedStore(server, false)
  const env = await openEnv({ server, synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await user.click(screen.getByRole('button', { name: SEARCH }))
  await user.click(screen.getByRole('button', { name: '＋ 新增店家' }))
  await user.type(screen.getByLabelText('店名'), '阿財牛肉麵')
  await user.click(screen.getByRole('button', { name: '建立' }))
  await waitFor(() => expect(screen.getAllByText(/阿財牛肉麵/).length).toBeGreaterThan(0))
  expect(await env.client.db.pending.count()).toBe(0)
})

test('請 Kyujin 估算不寫任何東西；離線時按鈕是需要網路', async () => {
  const server = (await openEnv()).server
  await seedStore(server)
  const env = await openEnv({ server, synced: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  await waitFor(() => expect(screen.getByRole('button', { name: '店家 阿財牛肉麵' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '店家 阿財牛肉麵' }))
  await user.click(screen.getByRole('button', { name: '＋ 新增品項' }))
  await user.click(screen.getByRole('button', { name: '請 Kyujin 估算' }))
  expect(screen.getByText(/傳照片或品名給 Kyujin/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '好' }))
  expect(await env.client.db.pending.count()).toBe(0)
  await waitFor(() => expect(screen.getByRole('button', { name: '店家 阿財牛肉麵' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '店家 阿財牛肉麵' }))
  await user.click(screen.getByRole('button', { name: '＋ 新增品項' }))
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
  window.dispatchEvent(new Event('offline'))
  await waitFor(() => expect((screen.getByRole('button', { name: '需要網路' }) as HTMLButtonElement).disabled).toBe(true))
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
})

test('試用模式：沒有 transport，資料只在本機，橫幅標本機試用', async () => {
  const env = await openEnv({ trial: true })
  const { user } = mountApp(env)
  await screen.findByRole('button', { name: SEARCH })
  expect(await screen.findByText('本機試用，不會同步到伺服器')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: SEARCH }))
  await user.type(screen.getByRole('searchbox'), '雞胸')
  await user.click(screen.getByText('法式香草嫩雞胸'))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('法式香草嫩雞胸').length).toBeGreaterThan(0))
  expect(env.transport.pushCalls).toBe(0)
  expect(await env.client.db.pending.count()).toBe(0)
  expect(env.server.db.all('logs')).toHaveLength(0)
})
