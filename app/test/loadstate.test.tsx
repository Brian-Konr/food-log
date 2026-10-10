// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { TodayScreen } from '@/screens/TodayScreen'
import { deriveLoadState, type LoadState } from '@/data/loadstate'
import type { LogRecord, MergedItem } from '@/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const TODAY = '2026-10-10'
const log: LogRecord = {
  id: 'l1', ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '', day: TODAY,
  item_id: 'fm:1', name: '雞胸', src: '全家', qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 2, source: 'app', store: '',
}
const remain = { kcal: 1700, protein: 140, fat: 59, carb: 198 }
const eaten = { kcal: 100, protein: 10, fat: 1, carb: 2 }
const targets = { kcal: 1800, protein: 150, fat: 60, carb: 200 }
const itemsById = new Map<string, MergedItem>()

function renderToday(loadState: LoadState, extra: Partial<Parameters<typeof TodayScreen>[0]> = {}) {
  return render(
    <TodayScreen
      today={TODAY}
      remain={remain}
      eaten={eaten}
      targets={targets}
      logs={[log]}
      itemsById={itemsById}
      stores={[]}
      onWeight={() => {}}
      onOpenLog={() => {}}
      loadState={loadState}
      staleToday={false}
      onRetry={() => {}}
      pending={0}
      online
      {...extra}
    />,
  )
}

function banned(text: string) {
  expect(text).not.toContain('2000')
  expect(text).not.toContain('2,000')
  expect(text).not.toContain('0 筆')
  expect(text).not.toContain('今天還沒有紀錄')
}

test('deriveLoadState 五態', () => {
  const cache = { savedAt: '', serverTime: '', day: TODAY, config: {}, items: [], stores: [], logs: [], weights: [] }
  expect(deriveLoadState({ booting: true, cache: null, fresh: false, error: null })).toBe('skeleton')
  expect(deriveLoadState({ booting: false, cache, fresh: false, error: null })).toBe('cached-syncing')
  expect(deriveLoadState({ booting: false, cache, fresh: true, error: null })).toBe('fresh')
  expect(deriveLoadState({ booting: false, cache, fresh: false, error: { kind: 'offline', code: 'NET-0' } })).toBe('error-cached')
  expect(deriveLoadState({ booting: false, cache: null, fresh: false, error: { kind: 'offline', code: 'NET-0' } })).toBe('error-empty')
})

test('skeleton 沒有假數字、沒有 1800 英雄數字', () => {
  const { container } = renderToday('skeleton')
  banned(container.textContent || '')
  expect(container.textContent).not.toMatch(/1800|1,800/)
  expect(container.textContent).toContain('今天還剩')
})

test('skeleton 剩餘卡與真資料同一套字級槽', () => {
  const { container } = renderToday('skeleton')
  const card = container.querySelector('[data-remain-card]')
  expect(card?.querySelector('.h-14')).toBeTruthy()
  expect(card?.querySelector('.h-9')).toBeTruthy()
  expect(card?.textContent).toContain('kcal')
  expect(card?.textContent).toContain('g 蛋白質')
})

test('fresh 與 cached-syncing 熱量 text-hero、蛋白質 text-2xl', () => {
  for (const st of ['fresh', 'cached-syncing'] as const) {
    const { container, unmount } = renderToday(st)
    const card = container.querySelector('[data-remain-card]')
    expect(card?.querySelector('.text-hero')).toBeTruthy()
    expect(card?.querySelector('.text-2xl')).toBeTruthy()
    unmount()
  }
})

test('error-empty 有讀不到和重試，沒有假數字', () => {
  const { container } = renderToday('error-empty', { errorReason: '沒有網路連線', errorCodeLine: '錯誤代碼 NET-0' })
  banned(container.textContent || '')
  expect(container.textContent).not.toMatch(/1800|1,800/)
  expect(container.textContent).toContain('讀不到今天的資料')
  expect(container.textContent).toContain('重試')
})

test('cached-syncing 看得到快取數字；300ms 後同步中', () => {
  vi.useFakeTimers()
  const { container } = renderToday('cached-syncing')
  banned(container.textContent || '')
  expect(container.textContent).toContain('1,700')
  act(() => { vi.advanceTimersByTime(300) })
  expect(container.textContent).toContain('同步中')
})

test('error-cached 沒有假 2000', () => {
  const { container } = renderToday('error-cached')
  banned(container.textContent || '')
})

test('fresh 看得到伺服器數字', () => {
  const { container } = renderToday('fresh')
  banned(container.textContent || '')
  expect(container.textContent).toContain('1,700')
  expect(container.textContent).toContain('雞胸')
})
