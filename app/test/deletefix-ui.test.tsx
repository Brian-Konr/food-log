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
const chicken: CatalogItem = {
  id: 'fm:1032099', src: 'familymart', name: '法式香草嫩雞胸', cat: '小菜', serving: '1 份（100 g）',
  servingG: 100, perPack: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}

const ghostLog = {
  id: 'l:ghost-delete', ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '',
  day: '2026-10-10', item_id: '', name: '幽靈豆漿', src: '其他', qty: 1, grams: null,
  kcal: 100, protein: 10, fat: 1, carb: 10, source: 'app' as const, store: '',
}

test('刪掉失敗的新增，復原回失敗清單，不打 softDelete', async () => {
  const storage = memoryStorage()
  const kv = memoryKv()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const calls: Op[] = []
  const adapter = {
    kind: 'test',
    call: (op: Op) => {
      calls.push(op)
      if (op.action === 'append') return Promise.resolve({ ok: false as const, error: 'bad_record', message: '壞' })
      return inner.call(op)
    },
  }
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} kv={kv} />)
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.click(screen.getByRole('button', { name: '不指定店家' }))
  await user.type(screen.getByLabelText('品名'), '刪除修復豆漿')
  await user.type(screen.getByLabelText('熱量'), '100')
  await user.type(screen.getByLabelText('蛋白質'), '10')
  await user.type(screen.getByLabelText('碳水'), '10')
  await user.type(screen.getByLabelText('脂肪'), '1')
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(() => expect(screen.getAllByText(/沒有存到/).length).toBeGreaterThan(0))
  await user.click(screen.getByRole('button', { name: /刪除修復豆漿/ }))
  await user.click(screen.getByRole('button', { name: '刪除' }))
  await waitFor(() => expect(screen.getByText('已刪除 刪除修復豆漿')).toBeTruthy())
  expect(screen.getByRole('button', { name: '復原' })).toBeTruthy()
  expect(screen.queryByText('刪除失敗')).toBeNull()
  expect(calls.some((c) => c.action === 'softDelete')).toBe(false)
  expect(screen.queryByRole('button', { name: /刪除修復豆漿/ })).toBeNull()
  await user.click(screen.getByRole('button', { name: '復原' }))
  await waitFor(() => expect(screen.getAllByText(/沒有存到/).length).toBeGreaterThan(0))
  expect(screen.getByRole('button', { name: /刪除修復豆漿/ })).toBeTruthy()
  expect(calls.some((c) => c.action === 'softDelete')).toBe(false)
})

test('捨棄失敗刪除，不跳第二個 toast，重開不再出現', async () => {
  const storage = memoryStorage()
  storage.setItem('foodlog.mockdb', JSON.stringify({
    config: { ...DEFAULT_CONFIG },
    items: [],
    stores: [],
    logs: [{
      id: 'l-synced', ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '',
      day: '2026-10-10', item_id: '', name: '已同步豆漿', src: '其他',
      qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 10, source: 'quick', store: '',
    }],
    weights: [],
  }))
  const kv = memoryKv()
  const inner = createMockAdapter({ storage, now: () => NOW })
  const adapter = {
    kind: inner.kind,
    call: (op: Op) => {
      if (op.action === 'softDelete') return Promise.resolve({ ok: false as const, error: 'bad_record', message: '壞掉' })
      return inner.call(op)
    },
  }
  const user = userEvent.setup()
  const first = render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} kv={kv} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /已同步豆漿/ })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: /已同步豆漿/ }))
  await user.click(screen.getByRole('button', { name: '刪除' }))
  await waitFor(() => expect(screen.getByText('刪除失敗，已還原 已同步豆漿')).toBeTruthy())
  expect(screen.getByRole('button', { name: '捨棄' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '重試' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '捨棄' }))
  await waitFor(() => expect(screen.queryByText('刪除失敗，已還原 已同步豆漿')).toBeNull())
  expect(screen.getByRole('button', { name: /已同步豆漿/ })).toBeTruthy()
  expect(screen.queryByText('刪除失敗')).toBeNull()
  first.unmount()
  render(<App adapter={adapter} storage={storage} catalogItems={[chicken]} now={() => NOW} kv={kv} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /已同步豆漿/ })).toBeTruthy())
  expect(screen.queryByText('刪除失敗')).toBeNull()
})

test('打開時 heal，不 toast', async () => {
  const info = vi.spyOn(console, 'info')
  const storage = memoryStorage()
  const kv = memoryKv({
    failed: JSON.stringify([
      {
        qid: 'q-app', error: 'bad_record', message: '壞', queuedAt: ghostLog.ts,
        op: { action: 'append', table: 'Logs', record: ghostLog },
      },
      {
        qid: 'q-del', error: 'not_found', message: '找不到', queuedAt: ghostLog.ts,
        op: { action: 'softDelete', table: 'Logs', id: 'l:ghost-delete' },
      },
    ]),
  })
  render(<App adapter={createMockAdapter({ storage, now: () => NOW })} storage={storage} catalogItems={[chicken]} now={() => NOW} kv={kv} />)
  await waitFor(() => expect(info.mock.calls.some((c) => c[0] === 'food-log auto-heal 2')).toBe(true))
  expect(screen.queryByText('幽靈豆漿')).toBeNull()
  expect(screen.queryByText('刪除失敗')).toBeNull()
})
