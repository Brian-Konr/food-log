// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TrendsScreen } from '@/screens/TrendsScreen'
import { addDays, weekStart } from '@/lib/day'
import { formatKg } from '@/lib/format'
import type { LogRecord, WeightRecord } from '@/types'
import type { WeightRange } from '@/lib/trends'

afterEach(() => cleanup())

const TODAY = '2026-10-10'
const CFG = { target_kcal: '2000', target_protein: '150', target_fat: '60', target_carb: '200', tdee: '2650' }

function L(day: string, kcal: number, extra: Partial<LogRecord> = {}): LogRecord {
  return {
    id: extra.id ?? `${day}-${kcal}-${Math.random()}`, ts: `${day}T12:00:00+08:00`, deleted: false, updated_at: `${day}T12:00:00+08:00`,
    day, item_id: 'x', name: 'x', src: '全家', qty: 1, grams: null, kcal, protein: 0, fat: 0, carb: 0, source: 'app', store: '', ...extra,
  }
}
function W(day: string, kg: number, extra: Partial<WeightRecord> = {}): WeightRecord {
  return { id: extra.id ?? `w-${day}`, day, ts: `${day}T08:00:00+08:00`, deleted: false, updated_at: `${day}T08:00:00+08:00`, kg, ...extra }
}

function renderTrends(extra: Partial<Parameters<typeof TrendsScreen>[0]> = {}) {
  const onRange = extra.onRange ?? vi.fn()
  return {
    onRange,
    ...render(
      <TrendsScreen
        today={TODAY}
        logs={extra.logs ?? []}
        weights={extra.weights ?? []}
        config={CFG}
        loadState="fresh"
        pending={0}
        online
        onRetry={() => {}}
        onWeight={() => {}}
        range="1M"
        onRange={onRange}
        {...extra}
      />,
    ),
  }
}

test('兩天紀錄顯示記錄不足，體重卡仍在', () => {
  renderTrends({
    logs: [L(TODAY, 100), L(addDays(TODAY, -1), 100)],
    weights: [W(TODAY, 72.4)],
  })
  expect(screen.getByText('飲食記錄滿 3 天就會出現熱量趨勢（目前 2 天）')).toBeTruthy()
  expect(screen.queryByText('每日熱量・近 4 週')).toBeNull()
  expect(screen.getByRole('heading', { name: '體重（kg）' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '＋ 記體重' })).toBeTruthy()
})

test('五筆不完整 Kyujin 沒有不足提示，本週平均是 —', () => {
  const start = addDays(weekStart(TODAY), -21)
  const logs = Array.from({ length: 5 }, (_, i) => L(addDays(start, i), 3000, { source: 'kyujin' }))
  renderTrends({ logs, weights: [] })
  expect(screen.queryByText(/飲食記錄滿/)).toBeNull()
  expect(screen.getByText('每日熱量・近 4 週')).toBeTruthy()
  expect(screen.getByText('本週還沒有完整記錄的日子')).toBeTruthy()
  expect(screen.getByText('平均攝取').parentElement?.textContent).toMatch(/—/)
})

test('區間 radio 與點 3 個月', async () => {
  const user = userEvent.setup()
  const { onRange } = renderTrends({ weights: [W(TODAY, 72.4)], range: '1M' })
  expect(screen.getByRole('radiogroup', { name: '體重區間' })).toBeTruthy()
  expect(screen.getByRole('radio', { name: '1 個月' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('radio', { name: '1 週' }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('radio', { name: '3 個月' }).getAttribute('aria-checked')).toBe('false')
  await user.click(screen.getByRole('radio', { name: '3 個月' }))
  expect(onRange).toHaveBeenCalledWith('3M')
})

test('區間外體重顯示空狀態，換到 3 個月後消失', () => {
  const w = [W(addDays(TODAY, -40), 70)]
  const { rerender, onRange } = renderTrends({ weights: w, range: '1M' })
  expect(screen.getByText('這段期間沒有體重紀錄')).toBeTruthy()
  rerender(
    <TrendsScreen
      today={TODAY}
      logs={[]}
      weights={w}
      config={CFG}
      loadState="fresh"
      pending={0}
      online
      onRetry={() => {}}
      onWeight={() => {}}
      range={'3M' as WeightRange}
      onRange={onRange}
    />,
  )
  expect(screen.queryByText('這段期間沒有體重紀錄')).toBeNull()
})

test('窗口內正好 1 筆：沒有 path，有公斤文字', () => {
  const { container } = renderTrends({ weights: [W(TODAY, 72.4)], range: '1M' })
  expect(container.querySelector('svg path')).toBeNull()
  expect(screen.getByText(formatKg(72.4))).toBeTruthy()
})

test('3 個月 cached-syncing 且沒有 weightDays 時圖區是骨架', () => {
  const weights = [W(TODAY, 72.4)]
  const { rerender, onRange, container } = renderTrends({
    weights,
    range: '3M',
    loadState: 'cached-syncing',
  })
  expect(container.querySelector('.skeleton-shimmer') || container.querySelector('[aria-busy="true"]')).toBeTruthy()
  expect(screen.queryByText('這段期間沒有體重紀錄')).toBeNull()
  expect(container.querySelector('path[stroke="var(--chart-expected)"]')).toBeNull()
  rerender(
    <TrendsScreen
      today={TODAY}
      logs={[]}
      weights={weights}
      config={CFG}
      loadState="fresh"
      pending={0}
      online
      onRetry={() => {}}
      onWeight={() => {}}
      range="3M"
      onRange={onRange}
    />,
  )
  expect(container.querySelector('.skeleton-shimmer')).toBeNull()
})
