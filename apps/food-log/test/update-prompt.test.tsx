// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RELOAD_GRACE_MS, UpdatePrompt } from '@/features/update/UpdatePrompt'

const reload = vi.fn()
const realLocation = window.location

beforeEach(() => {
  reload.mockReset()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

function stubSW(getRegistration: () => Promise<unknown>) {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration } })
}

test('open=false 什麼都不畫', () => {
  const { container } = render(<UpdatePrompt open={false} />)
  expect(container.innerHTML).toBe('')
})

test('retired：顯示暫停使用文案，沒有重新載入按鈕', () => {
  render(<UpdatePrompt open retired />)
  expect(screen.getByRole('alert').textContent).toContain('這個版本已暫停使用，請改用舊版 App')
  expect(screen.queryByRole('button')).toBeNull()
})

test('open=true：顯示文案與按鈕，沒有關閉鈕', () => {
  render(<UpdatePrompt open />)
  expect(screen.getByRole('alert').textContent).toContain('有新版本，請重新載入')
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '重新載入' })).toBeTruthy()
})

test('有 waiting worker：update() → SKIP_WAITING → 等啟用 → reload', async () => {
  const postMessage = vi.fn()
  const listeners: Array<() => void> = []
  const waiting = {
    state: 'installed',
    postMessage,
    addEventListener: (_: string, l: () => void) => listeners.push(l),
    removeEventListener: () => {},
  }
  const update = vi.fn(async () => {})
  stubSW(async () => ({ update, waiting, installing: null }))
  render(<UpdatePrompt open />)
  fireEvent.click(screen.getByRole('button', { name: '重新載入' }))
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }))
  expect(update).toHaveBeenCalledTimes(1)
  expect(reload).not.toHaveBeenCalled() // 還在等新 worker 啟用
  waiting.state = 'activated'
  listeners.forEach((l) => l())
  // 啟用後先等 registerSW 自己的 reload；它沒動才由我們 reload（一次）
  await new Promise((r) => setTimeout(r, 100))
  expect(reload).not.toHaveBeenCalled()
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: RELOAD_GRACE_MS + 1500 })
})

test('沒有新 worker（已自動更新）：update() 後直接 reload', async () => {
  const update = vi.fn(async () => {})
  stubSW(async () => ({ update, waiting: null, installing: null }))
  render(<UpdatePrompt open />)
  fireEvent.click(screen.getByRole('button', { name: '重新載入' }))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  expect(update).toHaveBeenCalledTimes(1)
})

test('沒有 service worker（API 不存在或沒註冊）→ 直接 reload', async () => {
  render(<UpdatePrompt open />)
  fireEvent.click(screen.getByRole('button', { name: '重新載入' }))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
})

test('getRegistration 回 undefined（尚未註冊）→ 直接 reload', async () => {
  stubSW(async () => undefined)
  render(<UpdatePrompt open />)
  fireEvent.click(screen.getByRole('button', { name: '重新載入' }))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
})

test('update() 丟錯也要 reload', async () => {
  stubSW(async () => ({
    update: async () => {
      throw new Error('offline')
    },
    waiting: null,
    installing: null,
  }))
  render(<UpdatePrompt open />)
  fireEvent.click(screen.getByRole('button', { name: '重新載入' }))
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
})
