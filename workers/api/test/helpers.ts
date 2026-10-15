import { env, exports } from 'cloudflare:workers'
import { BOT_METADATA, BOT_PERMISSIONS } from '../src/auth.ts'
import { generateCode, hashCode } from '../src/code-hash.ts'
import { buildKeyInsert, generateBotKey } from '../src/bot-key.ts'

export const ORIGIN = 'https://food-log.test'
export const OWNER_EMAIL = 'owner@example.com'
/** Fixed test "now": the Taipei day used for dates in tests (a Monday). */
export const TODAY = '2026-10-12'

const RESET_TABLES = [
  'stores',
  'items',
  'logs',
  'weights',
  'favorites',
  'config',
  'sync_clients',
  'mutation_outcomes',
  'login_codes',
  'cas_guard',
  'export_progress',
  'passkey',
  'apikey',
  'session',
  'account',
  'verification',
  'user',
]

export async function resetDb(): Promise<void> {
  const db = env.DB
  await db.batch([
    ...RESET_TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)),
    db.prepare(`UPDATE meta SET value = 0 WHERE key = 'version'`),
    db.prepare(`UPDATE meta SET value = 'e1' WHERE key = 'epoch'`),
  ])
}

export async function seedUser(email = OWNER_EMAIL, id = 'u-' + email.split('@')[0]): Promise<string> {
  const now = Date.now()
  await env.DB.prepare(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
    .bind(id, 'Owner', email, now, now)
    .run()
  return id
}

/** Insert a login code row exactly like scripts/login-code.ts would. Returns the plaintext code. */
export async function issueCode(userId: string, opts: { ttlMs?: number } = {}): Promise<string> {
  const code = generateCode()
  const now = Date.now()
  await env.DB.prepare(`INSERT INTO login_codes (code_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
    .bind(await hashCode(code), userId, now + (opts.ttlMs ?? 15 * 60 * 1000), now)
    .run()
  return code
}

type CallInit = RequestInit & { cookie?: string; json?: unknown; client?: string; bearer?: string }

export function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Origin', ORIGIN)
  if (init.cookie) headers.set('Cookie', init.cookie)
  if (init.client) headers.set('X-FoodLog-Client', init.client)
  if (init.bearer) headers.set('Authorization', 'Bearer ' + init.bearer)
  let body = init.body
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(init.json)
  }
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(ORIGIN + path, { ...init, headers, body }))
}

/** Redeem a fresh login code and return the session cookie header value. */
export async function login(email = OWNER_EMAIL): Promise<{ cookie: string; userId: string }> {
  const userId = await seedUser(email)
  const code = await issueCode(userId)
  const res = await call('/api/auth/login-code/redeem', { method: 'POST', json: { code } })
  if (res.status !== 200) throw new Error('login failed: ' + res.status + ' ' + (await res.text()))
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  return { cookie, userId }
}

/** Mint a Kyujin key for `userId` the way scripts/bot-key.ts does (SQL insert of the hash). Returns the plaintext key. */
export async function mintBotKey(
  userId: string,
  opts: { permissions?: Record<string, readonly string[]>; metadata?: Record<string, unknown>; enabled?: boolean; expiresAt?: number | null; id?: string } = {},
): Promise<{ key: string; id: string }> {
  const key = generateBotKey()
  const id = opts.id ?? crypto.randomUUID()
  const ins = await buildKeyInsert({
    id,
    key,
    userId,
    name: 'kyujin',
    permissions: opts.permissions ?? BOT_PERMISSIONS,
    metadata: opts.metadata ?? BOT_METADATA,
    nowMs: Date.now(),
  })
  await env.DB.prepare(ins.sql).bind(...ins.params).run()
  if (opts.enabled === false) await env.DB.prepare(`UPDATE apikey SET enabled = 0 WHERE id = ?`).bind(id).run()
  if (opts.expiresAt !== undefined) await env.DB.prepare(`UPDATE apikey SET expires_at = ? WHERE id = ?`).bind(opts.expiresAt, id).run()
  return { key, id }
}

// ---- mutation helpers (synthetic data only) ----

export const noon = (day: string, hm = '12:00') => `${day}T${hm}:00+08:00`
export const mut = (id: number, name: string, args: unknown) => ({ id, name, args, clientTs: 0 })

export const weightArgs = (id: string, kg: number, day: string, hm = '08:00') => ({ id, day, ts: noon(day, hm), kg })
export const upsertWeight = (id: number, wid: string, kg: number, day: string, hm = '08:00') => mut(id, 'weights.upsert@1', weightArgs(wid, kg, day, hm))

export const logArgs = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  ts: noon('2026-10-11'),
  day: '2026-10-11',
  item_id: 'fm:1',
  name: '雞胸',
  src: '全家',
  qty: 1,
  grams: null,
  kcal: 106,
  protein: 20.8,
  fat: 1.5,
  carb: 2.3,
  ...over,
})
export const quickLogArgs = (id: string, over: Record<string, unknown> = {}) =>
  logArgs(id, { item_id: '', name: '', src: '其他', qty: 1, grams: null, kcal: 300, protein: 10, fat: 10, carb: 40, source: 'quick', ...over })

export const itemArgs = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: '自建',
  base_id: null,
  src: '其他',
  name: '乳清',
  serving: '1 匙',
  serving_g: 30,
  kcal: 120,
  protein: 24,
  fat: 1,
  carb: 2,
  store_id: null,
  ts: noon('2026-10-11'),
  ...over,
})
export const storeArgs = (id: string, name: string) => ({ id, name, ts: noon('2026-10-11') })

/** POST /sync/push as the owner. */
export function push(cookie: string, clientId: string, ...mutations: unknown[]): Promise<Response> {
  return call('/sync/push', { method: 'POST', cookie, client: '1', json: { clientId, mutations } })
}

export async function pushOk(cookie: string, clientId: string, ...mutations: unknown[]) {
  const res = await push(cookie, clientId, ...mutations)
  if (res.status !== 200) throw new Error('push failed: ' + res.status + ' ' + (await res.text()))
  return (await res.json()) as { lastMutationId: number; results: Array<{ id: number; ok: boolean; result?: Record<string, unknown>; error?: string; message?: string; details?: Record<string, unknown> }> }
}

export async function version(): Promise<number> {
  return Number((await env.DB.prepare(`SELECT value FROM meta WHERE key = 'version'`).first<{ value: number }>())!.value)
}
