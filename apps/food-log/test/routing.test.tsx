// @vitest-environment jsdom
// hash 路由（TanStack Router）與各頁從 sync-client 讀資料：#today #trends #items #settings #weight 深連結照舊。
import { afterEach, expect, test } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { createAppHashHistory } from '@/app/history'
import { addDays } from '@/lib/day'
import { TODAY, mountApp, openEnv, seed } from './harness'

afterEach(() => {
  cleanup()
  localStorage.clear()
  history.replaceState(null, '', location.pathname + location.search)
})

test('createAppHashHistory：#weight ⇄ /weight，寫回去也是 #today 這種不帶斜線的樣子', () => {
  location.hash = '#weight'
  const h = createAppHashHistory()
  expect(h.location.pathname).toBe('/weight')
  h.replace('/trends')
  h.flush()
  expect(location.hash).toBe('#trends')
  expect(h.location.pathname).toBe('/trends')
  location.hash = '#/items' // 兩種寫法都認得
  history.replaceState(null, '', location.href)
  expect(createAppHashHistory().location.pathname).toBe('/items')
  location.hash = ''
  expect(createAppHashHistory().location.pathname).toBe('/')
  h.destroy()
})

test('四個分頁：點分頁列換頁；#weight 在今天頁上開記體重 Sheet；未知的 hash 回今天', async () => {
  const env = await openEnv({ synced: true })
  const { user, history: h } = mountApp(env, { hash: '/nonsense' })
  await screen.findByText('今天的紀錄')
  expect(h.location.pathname).toBe('/today')
  await user.click(screen.getByRole('button', { name: '趨勢' }))
  await screen.findByRole('heading', { name: '趨勢' })
  expect(h.location.pathname).toBe('/trends')
  await user.click(screen.getByRole('button', { name: '品項' }))
  await screen.findByRole('heading', { name: '品項' })
  await user.click(screen.getByRole('button', { name: '設定' }))
  await screen.findByRole('heading', { name: '設定' })
  expect(h.location.pathname).toBe('/settings')
  await user.click(screen.getByRole('button', { name: '今天' }))
  await screen.findByText('今天的紀錄')
  await user.click(screen.getByRole('button', { name: '記體重' }))
  await waitFor(() => expect(h.location.pathname).toBe('/weight'))
  expect(await screen.findByRole('dialog')).toBeTruthy()
})

test('趨勢頁：資料來自伺服器 → 本機 Dexie，數字由 core 算（本週平均攝取、體重卡）', async () => {
  const server = (await openEnv()).server
  await seed(server, 'config.set@1', { key: 'target_kcal', value: '2000' })
  await seed(server, 'config.set@1', { key: 'tdee', value: '2650' })
  // 4 週前起連續記 3 天：滿 3 天才有熱量趨勢
  // 一天要有 2 筆以上才算完整（只有 1 筆算記錄不完整）
  for (let i = 1; i <= 4; i++) {
    const day = addDays(TODAY, -i)
    for (const [n, hhmm] of [['a', '08:00'], ['b', '18:00']] as const) {
      await seed(server, 'logs.add@1', {
        log: { id: `l${i}${n}`, ts: `${day}T${hhmm}:00+08:00`, day, item_id: null, name: `餐${i}${n}`, src: '其他', qty: 1, grams: null, kcal: 900, protein: 75, fat: 25, carb: 100, source: 'quick', store_id: null },
      })
    }
  }
  await seed(server, 'weights.upsert@1', { id: 'w1', day: TODAY, ts: `${TODAY}T08:00:00+08:00`, kg: 72.4 })
  const env = await openEnv({ server, synced: true })
  mountApp(env, { hash: '/trends' })
  await screen.findByText('每日熱量・近 4 週')
  expect(screen.getByText('平均攝取').parentElement?.textContent).toContain('1,800')
  expect(screen.getByRole('heading', { name: '體重（kg）' })).toBeTruthy()
})

test('品項頁：收藏來自 favorites 表（官方品項、自建品項都一樣），取消收藏有復原', async () => {
  const server = (await openEnv()).server
  await seed(server, 'favorites.set@1', { item_id: 'fm:1032099', fav: true })
  const env = await openEnv({ server, synced: true })
  const { user } = mountApp(env, { hash: '/items' })
  await user.click(await screen.findByRole('button', { name: '取消收藏 法式香草嫩雞胸' }))
  await screen.findByText('已取消收藏 法式香草嫩雞胸')
  await user.click(screen.getByRole('button', { name: '復原' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '取消收藏 法式香草嫩雞胸' })).toBeTruthy())
})

test('設定頁：改目標 → config.set，數字立刻更新；RP ID 說明、新增 passkey、立即同步都在', async () => {
  const env = await openEnv({ synced: true })
  const { user } = mountApp(env, { hash: '/settings' })
  await user.click(await screen.findByRole('button', { name: /熱量/ }))
  const input = screen.getByLabelText(/熱量目標/)
  await user.clear(input)
  await user.type(input, '1800')
  await user.click(screen.getByRole('button', { name: '儲存' }))
  await waitFor(() => expect(screen.getByText(/1,800 kcal/)).toBeTruthy())
  expect(screen.getByRole('button', { name: /新增 passkey/ })).toBeTruthy()
  expect(screen.getByText(/RP ID/)).toBeTruthy()
  await env.client.syncNow()
  expect(env.server.db.all('config')[0]).toMatchObject({ target_kcal: 1800 })
})
