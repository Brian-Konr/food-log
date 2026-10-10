// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '@/App'
import { createMockAdapter } from '@/api/mock'
import { memoryKv } from '@/data/kv'
import { memoryStorage } from './helpers'
import type { CatalogItem } from '@/types'

afterEach(() => {
  cleanup()
  if (typeof location !== 'undefined') history.replaceState(null, '', location.pathname + location.search)
})

const NOW = Date.parse('2026-10-10T18:00:00+08:00')
const complete: CatalogItem = {
  id: 'fm:1032099', src: 'familymart', name: '法式香草嫩雞胸', cat: '小菜', serving: '1 份（100 g）',
  servingG: 100, perPack: 1, kcal: 106, protein: 20.8, fat: 1.5, carb: 2.3,
}
const onlyKcal: CatalogItem = {
  id: '711:89f35c5c37', src: '711', name: '晶英-麻辣奶油鮮蝦義大利麵', cat: '鮮食', serving: '1 份',
  servingG: null, perPack: 1, kcal: 586, protein: null, fat: null, carb: null,
}

function mount(offline = true) {
  const storage = memoryStorage()
  const kv = memoryKv()
  const adapter = createMockAdapter({ storage, now: () => NOW })
  if (offline) adapter.setOffline(true)
  const user = userEvent.setup()
  render(<App adapter={adapter} storage={storage} catalogItems={[complete, onlyKcal]} now={() => NOW} kv={kv} />)
  return { storage, adapter, user, kv }
}

test('完整品項不會先出補營養素步', async () => {
  const { user } = mount()
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.type(screen.getByRole('searchbox'), '雞胸')
  await user.click(screen.getByText('法式香草嫩雞胸'))
  expect(screen.queryByText('先補上營養素')).toBeNull()
  expect(screen.getByRole('button', { name: '記錄' })).toBeTruthy()
})

test('三欄未填「下一步」停用；填 0 可以', async () => {
  const { user } = mount()
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.type(screen.getByRole('searchbox'), '義大利')
  await user.click(screen.getByText('晶英-麻辣奶油鮮蝦義大利麵'))
  expect(screen.getByText('先補上營養素')).toBeTruthy()
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true)
  const inputs = screen.getAllByPlaceholderText('必填，可以填 0')
  await user.type(inputs[0], '0')
  await user.type(inputs[1], '0')
  await user.type(inputs[2], '0')
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false)
})

test('按取消或關閉後 outbox 長度仍是 0', async () => {
  const { user, kv } = mount()
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.type(screen.getByRole('searchbox'), '義大利')
  await user.click(screen.getByText('晶英-麻辣奶油鮮蝦義大利麵'))
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(JSON.parse(await kv.get('outbox') || '[]')).toHaveLength(0)
})

test('按記錄後 outbox 第一筆是 upsertItem（ov:）、第二筆是 append', async () => {
  const { user, kv } = mount(true)
  await user.click(screen.getByRole('button', { name: '搜尋店家、7-11、全家、我的品項' }))
  await user.type(screen.getByRole('searchbox'), '義大利')
  await user.click(screen.getByText('晶英-麻辣奶油鮮蝦義大利麵'))
  const inputs = screen.getAllByPlaceholderText('必填，可以填 0')
  await user.type(inputs[0], '0')
  await user.type(inputs[1], '0')
  await user.type(inputs[2], '0')
  await user.click(screen.getByRole('button', { name: '下一步' }))
  await user.click(screen.getByRole('button', { name: '記錄' }))
  await waitFor(async () => {
    const box = JSON.parse(await kv.get('outbox') || '[]') as { action: string; record?: { id?: string } }[]
    expect(box.length).toBeGreaterThanOrEqual(2)
    expect(box[0].action).toBe('upsertItem')
    expect(box[0].record?.id?.startsWith('ov:')).toBe(true)
    expect(box[1].action).toBe('append')
  })
})
