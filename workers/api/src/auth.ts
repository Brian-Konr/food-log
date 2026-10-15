import { apiKey } from '@better-auth/api-key'
import { passkey } from '@better-auth/passkey'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { env as workerEnv } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import * as z from 'zod'
import { BOT_KEY_PREFIX, BOT_METADATA } from './bot-key.ts'
import { hashCode } from './code-hash.ts'
import * as schema from './db/schema.ts'
import { allowedEmails } from './env.ts'
import type { Env } from './env.ts'

export const SESSION_DAYS = 90
export const COOKIE_CACHE_SECONDS = 5 * 60

export { BOT_METADATA, BOT_PERMISSIONS } from './bot-key.ts'

/**
 * One-time login code (plan 0.3): the first login and the passkey-lost fallback.
 * POST /api/auth/login-code/redeem {code} -> session cookie.
 * Atomic single-use: UPDATE ... WHERE used_at IS NULL AND expires_at > now RETURNING user_id.
 */
function loginCode(env: Env) {
  return {
    id: 'login-code',
    endpoints: {
      redeemLoginCode: createAuthEndpoint(
        '/login-code/redeem',
        { method: 'POST', body: z.object({ code: z.string().min(4).max(64) }) },
        async (ctx) => {
          const now = Date.now()
          const hash = await hashCode(ctx.body.code)
          const row = await env.DB.prepare(
            `UPDATE login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id`,
          )
            .bind(now, hash, now)
            .first<{ user_id: string }>()
          if (!row) throw new APIError('UNAUTHORIZED', { message: 'invalid_or_expired_code', code: 'INVALID_OR_EXPIRED_CODE' })
          const user = await ctx.context.internalAdapter.findUserById(row.user_id)
          if (!user || !allowedEmails(env).has(user.email.toLowerCase())) {
            throw new APIError('FORBIDDEN', { message: 'not_allowed', code: 'NOT_ALLOWED' })
          }
          const session = await ctx.context.internalAdapter.createSession(user.id)
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'session_failed' })
          await setSessionCookie(ctx, { session, user })
          return ctx.json({ ok: true })
        },
      ),
    },
  }
}

/** How many times betterAuth() was constructed in this isolate (tests: it must not move per request). */
export const authStats = { created: 0 }

export function createAuth(env: Env, origin: string) {
  authStats.created++
  const allowed = allowedEmails(env)
  const url = new URL(origin)
  return betterAuth({
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB), { provider: 'sqlite', schema }),
    // No sign-up path exists: no email/password, no social providers. The only way a user row
    // appears is scripts/bootstrap-owner.ts. The hooks below are defense in depth.
    emailAndPassword: { enabled: false, disableSignUp: true },
    session: {
      expiresIn: SESSION_DAYS * 86400,
      updateAge: 86400,
      // Signed session_data cookie: /sync/* validates the session from the cookie for COOKIE_CACHE_SECONDS
      // instead of hitting D1 on every request. Price: a revoked session (or a removed ALLOWED_EMAILS entry)
      // stays valid for at most that long. Expired sessions / bad signatures fall through to D1 -> 401.
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_SECONDS },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (u) => (allowed.has(String(u.email).toLowerCase()) ? { data: u } : false),
        },
      },
      session: {
        create: {
          before: async (s) => {
            const u = await env.DB.prepare(`SELECT email FROM user WHERE id = ?`).bind(s.userId).first<{ email: string }>()
            return u && allowed.has(u.email.toLowerCase()) ? { data: s } : false
          },
        },
      },
    },
    plugins: [
      // RP ID = the full worker hostname (workers.dev is on the Public Suffix List, plan 0.6)
      passkey({ rpID: url.hostname, rpName: 'food-log', origin }),
      loginCode(env),
      // Kyujin's key (PRD 7.2): hashed in D1, scoped through `permissions`, actor through `metadata`.
      // Keys are minted by scripts/bot-key.ts (SQL), never through a public endpoint; rate limiting is off
      // (the plugin's default is 10 requests per day).
      apiKey({ enableMetadata: true, rateLimit: { enabled: false }, defaultPrefix: BOT_KEY_PREFIX }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The public origin (= passkey origin, RP ID = its hostname). Fail closed: outside local dev it MUST come from
 * APP_ORIGIN. Deriving it from the request Host would let anyone who can reach the worker under another
 * hostname mint a differently scoped passkey / auth instance. Returns null when it cannot be determined.
 */
export function resolveOrigin(env: Pick<Env, 'APP_ORIGIN'>, reqUrl: string): string | null {
  try {
    if (env.APP_ORIGIN) return new URL(env.APP_ORIGIN).origin
    const u = new URL(reqUrl)
    return LOCAL_HOSTS.has(u.hostname) ? u.origin : null
  } catch {
    return null
  }
}

// cyrb53: small sync string hash, only used so the cache key never holds the secret itself.
function hash53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// betterAuth() construction is expensive: measured on the deployed spike it costs 18-33 ms CPU on a fresh isolate, over the
// free plan's 10 ms per-request limit. Work done at module (global) scope counts as Worker startup, not as request CPU, so the
// production instance is built right below at import time (`prewarm`) from `cloudflare:workers`' env, and requests only look it up.
// ONE slot keyed on the full config, so the cache can never grow with attacker-chosen input (Host header etc.). In production the
// request env always has the same values as the startup env, so every request is a hit; a different config (tests that override
// env, or localhost dev without APP_ORIGIN, where the origin is only known from the request) rebuilds the slot lazily.
let cached: { key: string; auth: Auth } | undefined

function configKey(env: Env, origin: string): string {
  return [origin, env.APP_ORIGIN ?? '', env.ALLOWED_EMAILS ?? '', hash53(env.BETTER_AUTH_SECRET ?? '')].join('|')
}

export function getAuth(env: Env, origin: string): Auth {
  const key = configKey(env, origin)
  if (!cached || cached.key !== key) cached = { key, auth: createAuth(env, origin) }
  return cached.auth
}

/**
 * Build the auth instance at module load. Fail closed and never throw: without APP_ORIGIN (local dev, derived per request) or
 * without the secret there is nothing to build yet, and a construction error must not take /api/health down with it; the
 * request path then builds lazily exactly as before.
 */
function prewarm(): void {
  try {
    const e = workerEnv as unknown as Env
    if (!e.APP_ORIGIN || !e.BETTER_AUTH_SECRET || !e.DB) return
    const origin = resolveOrigin(e, e.APP_ORIGIN)
    if (origin) getAuth(e, origin)
  } catch (err) {
    console.error(JSON.stringify({ type: 'auth_prewarm_failed', message: err instanceof Error ? err.message.slice(0, 300) : '' }))
  }
}
prewarm()

/** Auth instance for this request, or null when APP_ORIGIN is not configured outside local dev (fail closed). */
export function authFor(env: Env, reqUrl: string): Auth | null {
  const origin = resolveOrigin(env, reqUrl)
  return origin ? getAuth(env, origin) : null
}

export type BotKeyCheck =
  | { ok: true; keyId: string; userId: string; actor: 'kyujin'; scopes: { read: boolean; write: boolean } }
  | { ok: false; status: 401 | 403; error: 'unauthorized' | 'forbidden' }

/**
 * Verify a Kyujin Bearer key. Missing / unknown / revoked / disabled / expired -> 401 unauthorized.
 * A valid key whose metadata.actor is not kyujin, or that lacks the needed scope, -> 403 forbidden.
 * The key owner's email is re-checked against ALLOWED_EMAILS on every request (one indexed D1 read, nothing cached across
 * requests): removing an address from the secret locks its keys out immediately, and a key row inserted for a stranger is useless.
 */
export async function verifyBotKey(auth: Auth, env: Pick<Env, 'DB' | 'ALLOWED_EMAILS'>, key: string | null, need: 'read' | 'write'): Promise<BotKeyCheck> {
  const unauthorized = { ok: false, status: 401, error: 'unauthorized' } as const
  if (!key) return unauthorized
  let res: Awaited<ReturnType<Auth['api']['verifyApiKey']>>
  try {
    res = await auth.api.verifyApiKey({ body: { key } })
  } catch {
    return unauthorized
  }
  if (!res.valid || !res.key) return unauthorized
  const owner = await env.DB.prepare(`SELECT email FROM user WHERE id = ?`).bind(res.key.referenceId).first<{ email: string }>()
  if (!owner || !allowedEmails(env).has(owner.email.toLowerCase())) return unauthorized
  const meta = res.key.metadata as { actor?: unknown } | null
  if (!meta || meta.actor !== BOT_METADATA.actor) return { ok: false, status: 403, error: 'forbidden' }
  const granted = (res.key.permissions as Record<string, string[]> | null)?.foodlog ?? []
  const scopes = { read: granted.includes('read'), write: granted.includes('write.kyujin') }
  if (!scopes[need]) return { ok: false, status: 403, error: 'forbidden' }
  return { ok: true, keyId: res.key.id, userId: res.key.referenceId, actor: 'kyujin', scopes }
}

/** `Authorization: Bearer <key>` -> key, else null. */
export function bearerOf(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return m ? m[1]! : null
}
