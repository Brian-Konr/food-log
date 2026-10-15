// POST /telemetry/error: the app reports an error CODE and its version, nothing else (no food data, no messages).
// No session required (errors can happen before login). Body <= 1 KB, strict schema, written only to the Workers log.
import { Hono } from 'hono'
import { z } from 'zod'
import { NO_ORIGIN } from '../app-env.ts'
import type { AppEnv } from '../app-env.ts'
import { resolveOrigin } from '../auth.ts'

export const TELEMETRY_MAX_BYTES = 1024

export const telemetrySchema = z.strictObject({
  /** e.g. NET-0, API-500, unauthorized */
  code: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  /** app / build version */
  version: z.union([z.string().regex(/^[A-Za-z0-9_.+-]{1,32}$/), z.number().int().nonnegative()]),
})

// ---- abuse guards: the endpoint is public (errors can happen before login) and writes to the Workers log ----

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const hostnameOf = (u: string): string | null => {
  try {
    return new URL(u).hostname
  } catch {
    return null
  }
}

/** Origin header must be the app's own origin (APP_ORIGIN); localhost origins are accepted only when the request itself is to localhost (dev). */
export function originAllowed(env: Pick<AppEnv['Bindings'], 'APP_ORIGIN'>, reqUrl: string, origin: string | undefined): boolean {
  if (!origin) return false
  const expected = resolveOrigin(env, reqUrl)
  if (expected && origin === expected) return true
  const reqHost = hostnameOf(reqUrl)
  const originHost = hostnameOf(origin)
  return !!reqHost && !!originHost && LOCAL_HOSTNAMES.has(reqHost) && LOCAL_HOSTNAMES.has(originHost)
}

/** Fallback limiter when the Rate Limiting binding is absent: per-isolate token bucket per IP (capacity 10, refill 10 per minute). */
export const BUCKET_CAPACITY = 10
export const BUCKET_REFILL_PER_MS = 10 / 60_000
const BUCKET_MAX_KEYS = 2000
const buckets = new Map<string, { tokens: number; at: number }>()

export function takeToken(key: string, now: number): boolean {
  const b = buckets.get(key) ?? { tokens: BUCKET_CAPACITY, at: now }
  b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + Math.max(0, now - b.at) * BUCKET_REFILL_PER_MS)
  b.at = now
  const ok = b.tokens >= 1
  if (ok) b.tokens -= 1
  buckets.delete(key) // re-insert = most recently used last
  buckets.set(key, b)
  if (buckets.size > BUCKET_MAX_KEYS) buckets.delete(buckets.keys().next().value!) // bounded memory: drop the least recently used
  return ok
}

export function resetTelemetryBuckets(): void {
  buckets.clear()
}

export const telemetryRoutes = new Hono<AppEnv>()

telemetryRoutes.post('/error', async (c) => {
  if (!resolveOrigin(c.env, c.req.url)) return c.json({ ok: false, error: 'misconfigured', message: NO_ORIGIN.error }, 500)
  if (!originAllowed(c.env, c.req.url, c.req.header('Origin'))) return c.json({ ok: false, error: 'forbidden_origin' }, 403)
  const ip = c.req.header('CF-Connecting-IP')
  const allowed = c.env.TELEMETRY_LIMITER
    ? (await c.env.TELEMETRY_LIMITER.limit({ key: ip ?? 'no-ip' })).success
    : // no IP header = not behind the Cloudflare edge (local dev): nothing to key a bucket on
      !ip || takeToken(ip, Date.now())
  if (!allowed) return c.json({ ok: false, error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } })
  const declared = Number(c.req.header('content-length') ?? '0')
  if (declared > TELEMETRY_MAX_BYTES) return c.json({ ok: false, error: 'too_large' }, 413)
  const text = await c.req.text()
  if (new TextEncoder().encode(text).length > TELEMETRY_MAX_BYTES) return c.json({ ok: false, error: 'too_large' }, 413)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400)
  }
  const parsed = telemetrySchema.safeParse(body)
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request' }, 400)
  console.log(JSON.stringify({ type: 'client_error', code: parsed.data.code, version: parsed.data.version }))
  return c.json({ ok: true })
})
