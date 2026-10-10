// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '@/App'
import { createMockAdapter } from '@/api/mock'
import { memoryStorage } from './helpers'
import { DEFAULT_CONFIG } from '@/data/defaults'
import type { CatalogItem } from '@/types'

afterEach(() => {
  cleanup()
  if (typeof location !== 'undefined') history.replaceState(null, '', location.pathname + location.search)
})

const NOW = Date.parse('2026-10-10T18:00:00+08:00')
const chicken: CatalogItem = {
  id: 'fm:1032099', src: 'familymart', name: '法式香草嫩雞胸', cat: '小菜', serving: '1 份（100 g）',
  servingG: 100, perPack: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}
const pasta: CatalogItem = {
  id: '711:89f35c5c37', src: '711', name: '晶英-麻辣奶油鮮蝦義大利麵', cat: '鮮食', serving: '1 份',
  servingG: null, perPack: 1, kcal: 586, protein: null, fat: null, carb: null,
}

test('完整品項：搜尋框、結果、記錄，三下後今天出現該筆', async () => {
  const storage = memoryStorage()
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken, pasta]} now={() => NOW} />)
  await user.click(screen.getByRole('button', { name: '搜尋 7-11、全家、我的品項' }))
  await user.type(screen.getByRole('searchbox'), '雞胸')
  await user.click(screen.getByText('法式香草嫩雞胸'))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('法式香草嫩雞胸').length).toBeGreaterThan(0))
})

test('常吃膠囊：點膠囊、份量已是上次的 qty、再點記錄，兩下完成', async () => {
  const storage = memoryStorage()
  storage.setItem('foodlog.mockdb', JSON.stringify({
    config: { ...DEFAULT_CONFIG, fav_ids: 'fm:1032099' },
    items: [],
    logs: [{
      id: 'prev', ts: '2026-10-09T12:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-09',
      item_id: 'fm:1032099', name: '法式香草嫩雞胸', src: '全家', qty: 1.5, grams: null, kcal: 159, protein: 31.2, fat: 2.3, carb: 3.5,
    }],
    weights: [],
  }))
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken, pasta]} now={() => NOW} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /法式香草嫩雞胸/ })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: /法式香草嫩雞胸/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: '1.5' }).className).toMatch(/bg-primary/))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('法式香草嫩雞胸').length).toBeGreaterThan(0))
})

test('右上記體重沒有數字；點它再點記錄送出一筆體重', async () => {
  const storage = memoryStorage()
  storage.setItem('foodlog.mockdb', JSON.stringify({
    config: { ...DEFAULT_CONFIG },
    items: [],
    logs: [],
    weights: [{
      day: '2026-10-09', ts: '2026-10-09T08:00:00+08:00', deleted: false,
      updated_at: '2026-10-09T08:00:00+08:00', kg: 72.6, id: 'w-prev',
    }],
  }))
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} />)
  const btn = screen.getByRole('button', { name: '記體重' })
  expect(btn.textContent).not.toMatch(/\d/)
  await user.click(btn)
  await waitFor(() => expect(screen.getAllByText(/72\.6/).length).toBeGreaterThan(0))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(adapter.calls.some((c) => c.action === 'upsertWeight')).toBe(true))
})

test('initialHash #weight 時 Sheet 一開始就開著', () => {
  const storage = memoryStorage()
  const adapter = createMockAdapter({ storage, now: () => NOW })
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} initialHash="#weight" />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText('記體重')).toBeTruthy()
})

test('只有熱量的結果列文字含要補營養素', async () => {
  const storage = memoryStorage()
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken, pasta]} now={() => NOW} />)
  await user.click(screen.getByRole('button', { name: '搜尋 7-11、全家、我的品項' }))
  await user.type(screen.getByRole('searchbox'), '義大利')
  expect(screen.getByText(/要補營養素/)).toBeTruthy()
})
