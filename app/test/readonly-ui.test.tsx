// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '@/App'
import { createMockAdapter } from '@/api/mock'
import { memoryKv } from '@/data/kv'
import { memoryStorage } from './helpers'
import { DEFAULT_CONFIG } from '@/data/defaults'
import type { CatalogItem } from '@/types'
import type { Op } from '@/api/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (typeof location !== 'undefined') history.replaceState(null, '', location.pathname + location.search)
})

const NOW = Date.parse('2026-10-10T18:00:00+08:00')
const MSG = 'food-log 已搬到新網址，這裡只能讀'
const chicken: CatalogItem = {
  id: 'fm:1032099', src: 'familymart', name: '法式香草嫩雞胸', cat: '小菜', serving: '1 份（100 g）',
  servingG: 100, perPack: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}

function readOnlyAdapter(storage: ReturnType<typeof memoryStorage>, failing: Op['action']) {
  const inner = createMockAdapter({ storage, now: () => NOW })
  return {
    kind: inner.kind,
    call: (op: Op) => {
      if (op.action === failing) return Promise.resolve({ ok: false as const, error: 'read_only', message: MSG })
      return inner.call(op)
    },
  }
}

test('read_only：刪除失敗的 toast 顯示伺服器訊息，只留捨棄，不給重試', async () => {
  const storage = memoryStorage()
  storage.setItem('foodlog.mockdb', JSON.stringify({
    config: { ...DEFAULT_CONFIG }, items: [], stores: [], weights: [],
    logs: [{
      id: 'l-synced', ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '',
      day: '2026-10-10', item_id: '', name: '已同步豆漿', src: '其他',
      qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 10, source: 'quick', store: '',
    }],
  }))
  const user = userEvent.setup()
  render(<App adapter={readOnlyAdapter(storage, 'softDelete')} storage={storage} catalogItems={[chicken]} now={() => NOW} kv={memoryKv()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /已同步豆漿/ })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: /已同步豆漿/ }))
  await user.click(screen.getByRole('button', { name: '刪除' }))
  await waitFor(() => expect(screen.getByText(MSG)).toBeTruthy())
  expect(screen.getByRole('button', { name: '捨棄' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重試' })).toBeNull()
})

test('read_only：失敗的新增打開編輯面板，只有捨棄，沒有重試', async () => {
  const storage = memoryStorage()
  const user = userEvent.setup()
  render(<App adapter={readOnlyAdapter(storage, 'append')} storage={storage} catalogItems={[chicken]} now={() => NOW} kv={memoryKv()} />)
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.click(screen.getByRole('button', { name: '不指定店家' }))
  await user.type(screen.getByLabelText('品名'), '唯讀豆漿')
  await user.type(screen.getByLabelText('熱量'), '100')
  await user.type(screen.getByLabelText('蛋白質'), '10')
  await user.type(screen.getByLabelText('碳水'), '10')
  await user.type(screen.getByLabelText('脂肪'), '1')
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText(/沒有存到/).length).toBeGreaterThan(0))
  await user.click(screen.getByRole('button', { name: /唯讀豆漿/ }))
  await waitFor(() => expect(screen.getByText(MSG)).toBeTruthy())
  expect(screen.getByRole('button', { name: '捨棄' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重試' })).toBeNull()
})
