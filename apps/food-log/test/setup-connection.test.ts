import { expect, test } from 'vitest'
import { checkConnection } from '@/screens/SetupScreen'

const URL = 'https://script.google.com/macros/s/AKfycbTEST_123/exec'
const fake = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

test('連線檢查：成功回 null', async () => {
  expect(await checkConnection(URL, 's', fake({ ok: true, config: {} }))).toBeNull()
})
test('連線檢查：密鑰錯、網址格式錯、空白密鑰、連不上，都不會被存下來', async () => {
  expect(await checkConnection(URL, 'bad', fake({ ok: false, error: 'unauthorized' }))).toBe('共享密鑰不正確')
  expect(await checkConnection('https://example.com', 's', fake({ ok: true }))).toMatch(/網址格式不對/)
  expect(await checkConnection(URL, '', fake({ ok: true }))).toBe('請填共享密鑰')
  const boom = (async () => { throw new TypeError('x') }) as unknown as typeof fetch
  expect(await checkConnection(URL, 's', boom)).toMatch(/連不上/)
})
