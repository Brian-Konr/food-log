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
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
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
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.type(screen.getByRole('searchbox'), '義大利')
  expect(screen.getByText(/要補營養素/)).toBeTruthy()
})

const STORE_SEED = {
  config: { ...DEFAULT_CONFIG },
  items: [{
    id: 'u:beef', ts: '2026-10-09T12:00:00+08:00', deleted: false, updated_at: '', kind: '自建', base_id: '', src: '其他',
    name: '牛肉麵', serving: '1 份', serving_g: null, kcal: 520, protein: 28, fat: 18, carb: 62, fav: false, created_by: 'app', store: 's:1',
  }],
  stores: [{
    id: 's:1', ts: '2026-10-09T12:00:00+08:00', deleted: false, updated_at: '', name: '阿財牛肉麵', last_eaten_at: '2026-10-09T12:00:00+08:00', created_by: 'app',
  }],
  logs: [{
    id: 'prev-beef', ts: '2026-10-09T12:00:00+08:00', deleted: false, updated_at: '', day: '2026-10-09',
    item_id: 'u:beef', name: '牛肉麵', src: '其他', qty: 1, grams: null, kcal: 520, protein: 28, fat: 18, carb: 62, source: 'app', store: 's:1',
  }],
  weights: [],
}

test('已有店家品項：店家膠囊、品項、記錄，三次 click 今天多一筆', async () => {
  const storage = memoryStorage()
  storage.setItem('foodlog.mockdb', JSON.stringify(STORE_SEED))
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '店家 阿財牛肉麵' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '店家 阿財牛肉麵' }))
  await user.click(screen.getByText('牛肉麵'))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('牛肉麵').length).toBeGreaterThan(0))
  const db = JSON.parse(storage.getItem('foodlog.mockdb') || '{}') as { logs: { day: string }[] }
  expect(db.logs.filter((l) => l.day === '2026-10-10')).toHaveLength(1)
})

test('搜尋到記錄：搜尋框、結果、記錄，三次 click', async () => {
  const storage = memoryStorage()
  storage.setItem('foodlog.mockdb', JSON.stringify(STORE_SEED))
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} />)
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.type(screen.getByRole('searchbox'), '牛肉')
  await user.click(screen.getByRole('button', { name: /店家品項/ }))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText('牛肉麵').length).toBeGreaterThan(0))
})

test('快速記錄：搜尋框、不指定店家、記錄，三次 click；品名空、不建 Items', async () => {
  const storage = memoryStorage()
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} />)
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.click(screen.getByRole('button', { name: '不指定店家' }))
  const inputs = screen.getAllByPlaceholderText('必填，可以填 0')
  await user.type(inputs[0], '300')
  await user.type(inputs[1], '20')
  await user.type(inputs[2], '30')
  await user.type(inputs[3], '10')
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getByText('快速記錄')).toBeTruthy())
  const db = JSON.parse(storage.getItem('foodlog.mockdb') || '{}') as { items: unknown[]; logs: { source: string; item_id: string; qty: number }[] }
  expect(db.items).toHaveLength(0)
  expect(db.logs.some((l) => l.source === 'quick' && l.item_id === '' && l.qty === 1)).toBe(true)
})

test('新增店家與品項再記錄', async () => {
  const storage = memoryStorage()
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} />)
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
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
  const db = JSON.parse(storage.getItem('foodlog.mockdb') || '{}') as { stores: unknown[]; items: unknown[]; logs: unknown[] }
  expect(db.stores.length).toBeGreaterThan(0)
  expect(db.items.length).toBeGreaterThan(0)
  expect(db.logs.length).toBeGreaterThan(0)
  await user.click(screen.getByRole('button', { name: '店家 測試麵店' }))
  const dlg = screen.getByRole('dialog')
  expect(dlg.textContent).toContain('陽春麵')
  expect(dlg.textContent).not.toContain('還沒吃過')
  expect(dlg.textContent).not.toContain('這家店還沒有品項')
})

test('請 Kyujin 估算不打 API；離線時按鈕是需要網路', async () => {
  const storage = memoryStorage()
  storage.setItem('foodlog.mockdb', JSON.stringify({ ...STORE_SEED, logs: [], items: STORE_SEED.items }))
  const adapter = createMockAdapter({ storage, now: () => NOW })
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '店家 阿財牛肉麵' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '店家 阿財牛肉麵' }))
  await user.click(screen.getByRole('button', { name: '＋ 新增品項' }))
  const n = adapter.calls.length
  await user.click(screen.getByRole('button', { name: '請 Kyujin 估算' }))
  expect(screen.getByText(/傳照片或品名給 Kyujin/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '好' }))
  expect(adapter.calls.length).toBe(n)
  await waitFor(() => expect(screen.getByRole('button', { name: '店家 阿財牛肉麵' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '店家 阿財牛肉麵' }))
  await user.click(screen.getByRole('button', { name: '＋ 新增品項' }))
  adapter.setOffline(true)
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
  window.dispatchEvent(new Event('offline'))
  await waitFor(() => expect((screen.getByRole('button', { name: '需要網路' }) as HTMLButtonElement).disabled).toBe(true))
})
