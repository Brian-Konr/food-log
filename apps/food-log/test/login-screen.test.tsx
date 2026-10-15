// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({ signInWithPasskey: vi.fn(), signInWithCode: vi.fn() }))

vi.mock('@/features/auth/auth-client', async () => {
  const actual = await vi.importActual<typeof import('@/features/auth/auth-client')>('@/features/auth/auth-client')
  return { ...actual, authClient: { ...actual.authClient, signInWithPasskey: m.signInWithPasskey, signInWithCode: m.signInWithCode } }
})

import { AuthError } from '@/features/auth/auth-client'
import { AUTH_ERROR_COPY, CANCELLED_HINT, LoginScreen } from '@/features/auth/LoginScreen'

beforeEach(() => {
  vi.resetAllMocks()
})
afterEach(cleanup)

const passkeyBtn = () => screen.getByRole('button', { name: '用 passkey 登入' })

test('passkey 成功 → onSignedIn', async () => {
  m.signInWithPasskey.mockResolvedValue(undefined)
  const onSignedIn = vi.fn()
  render(<LoginScreen onSignedIn={onSignedIn} />)
  fireEvent.click(passkeyBtn())
  await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('alert')).toBeNull()
})

test('登入中顯示忙碌狀態並鎖住按鈕，避免重複觸發', async () => {
  let resolve!: () => void
  m.signInWithPasskey.mockReturnValue(new Promise<void>((r) => (resolve = r)))
  render(<LoginScreen onSignedIn={() => {}} />)
  fireEvent.click(passkeyBtn())
  const busy = await screen.findByRole('button', { name: '登入中…' })
  expect((busy as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(busy)
  expect(m.signInWithPasskey).toHaveBeenCalledTimes(1)
  resolve()
  await waitFor(() => expect((passkeyBtn() as HTMLButtonElement).disabled).toBe(false))
})

test('取消 Face ID：沒有錯誤橫幅，只有溫和提示，並自動展開登入碼；可再按一次', async () => {
  m.signInWithPasskey.mockRejectedValue(new AuthError('cancelled'))
  const onSignedIn = vi.fn()
  render(<LoginScreen onSignedIn={onSignedIn} />)
  expect(screen.queryByLabelText('登入碼')).toBeNull()
  fireEvent.click(passkeyBtn())
  await waitFor(() => expect((passkeyBtn() as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe(CANCELLED_HINT)
  expect(screen.getByLabelText('登入碼')).toBeTruthy()
  expect(onSignedIn).not.toHaveBeenCalled()
  fireEvent.click(passkeyBtn())
  await waitFor(() => expect(m.signInWithPasskey).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('alert')).toBeNull()
})

test('unsupported：顯示不支援的文案並展開登入碼', async () => {
  m.signInWithPasskey.mockRejectedValue(new AuthError('unsupported'))
  render(<LoginScreen onSignedIn={() => {}} />)
  fireEvent.click(passkeyBtn())
  expect((await screen.findByRole('alert')).textContent).toBe('這個瀏覽器不支援 passkey，請改用登入碼')
  expect(screen.getByLabelText('登入碼')).toBeTruthy()
})

test.each(['not_allowed', 'network', 'unknown'] as const)('passkey 失敗 %s → 對應繁中文案', async (c) => {
  m.signInWithPasskey.mockRejectedValue(new AuthError(c))
  render(<LoginScreen onSignedIn={() => {}} />)
  fireEvent.click(passkeyBtn())
  expect((await screen.findByRole('alert')).textContent).toBe(AUTH_ERROR_COPY[c])
})

test('登入碼區塊預設收合，展開後有欄位與 Brian 的產生碼提示', () => {
  render(<LoginScreen onSignedIn={() => {}} />)
  expect(screen.queryByLabelText('登入碼')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '用登入碼' }))
  expect(screen.getByLabelText('登入碼')).toBeTruthy()
  expect(screen.queryByLabelText(/Email/)).toBeNull()
  expect(document.body.textContent).toContain('node scripts/login-code.ts --email')
  expect(document.body.textContent).not.toContain('--filter')
})

test('登入碼流程成功 → 以 code 呼叫、onSignedIn', async () => {
  m.signInWithCode.mockResolvedValue(undefined)
  const onSignedIn = vi.fn()
  render(<LoginScreen onSignedIn={onSignedIn} />)
  fireEvent.click(screen.getByRole('button', { name: '用登入碼' }))
  fireEvent.change(screen.getByLabelText('登入碼'), { target: { value: 'ABCD-EFGH-JKMN' } })
  fireEvent.click(screen.getByRole('button', { name: '用登入碼登入' }))
  await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
  expect(m.signInWithCode).toHaveBeenCalledWith('ABCD-EFGH-JKMN')
})

test('登入碼錯誤 → 顯示無效或過期的文案，不呼叫 onSignedIn', async () => {
  m.signInWithCode.mockRejectedValue(new AuthError('invalid_code'))
  const onSignedIn = vi.fn()
  render(<LoginScreen onSignedIn={onSignedIn} />)
  fireEvent.click(screen.getByRole('button', { name: '用登入碼' }))
  fireEvent.change(screen.getByLabelText('登入碼'), { target: { value: 'WRONG' } })
  fireEvent.click(screen.getByRole('button', { name: '用登入碼登入' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe(AUTH_ERROR_COPY.invalid_code)
  expect(alert.textContent).toContain('登入碼')
  expect(onSignedIn).not.toHaveBeenCalled()
})

test('沒填登入碼就送出：直接提示，不打 API', async () => {
  render(<LoginScreen onSignedIn={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '用登入碼' }))
  fireEvent.click(screen.getByRole('button', { name: '用登入碼登入' }))
  expect((await screen.findByRole('alert')).textContent).toBe(AUTH_ERROR_COPY.invalid_code)
  expect(m.signInWithCode).not.toHaveBeenCalled()
})
