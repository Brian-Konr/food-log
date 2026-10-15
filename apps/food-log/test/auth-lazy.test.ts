// 開機的 session 檢查（plain fetch，不載入 better-auth）：和 features/auth/auth-client 的 getSession 同一個合約。
import { expect, test } from 'vitest'
import { fetchSession } from '@/app/auth-lazy'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('有 session：{ userId, email }；請求帶 cookie（credentials: include）', async () => {
  let seen: { url: string; init?: RequestInit } | undefined
  const r = await fetchSession({
    baseUrl: 'https://api.example',
    fetch: async (url, init) => {
      seen = { url: String(url), init }
      return json({ session: {}, user: { id: 'u1', email: 'a@b.c' } })
    },
  })
  expect(r).toEqual({ userId: 'u1', email: 'a@b.c' })
  expect(seen?.url).toBe('https://api.example/api/auth/get-session')
  expect(seen?.init?.credentials).toBe('include')
})

test('沒登入（200 null、沒有 user、401）→ null', async () => {
  expect(await fetchSession({ fetch: async () => json(null) })).toBeNull()
  expect(await fetchSession({ fetch: async () => json({ session: null }) })).toBeNull()
  expect(await fetchSession({ fetch: async () => json({ error: 'unauthorized' }, 401) })).toBeNull()
})

test('連不上、5xx、回的不是 JSON → 丟例外（不是「沒登入」）', async () => {
  await expect(fetchSession({ fetch: async () => { throw new TypeError('Failed to fetch') } })).rejects.toThrow('network')
  await expect(fetchSession({ fetch: async () => json({}, 503) })).rejects.toThrow('API-503')
  await expect(fetchSession({ fetch: async () => json({}, 500) })).rejects.toThrow('API-500')
  await expect(fetchSession({ fetch: async () => new Response('<html></html>', { status: 200 }) })).rejects.toThrow()
})
