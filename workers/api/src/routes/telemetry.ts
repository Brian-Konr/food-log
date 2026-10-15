// POST /telemetry/error: the app reports an error CODE and its version, nothing else (no food data, no messages).
// No session required (errors can happen before login). Body <= 1 KB, strict schema, written only to the Workers log.
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app-env.ts'

export const TELEMETRY_MAX_BYTES = 1024

export const telemetrySchema = z.strictObject({
  /** e.g. NET-0, API-500, unauthorized */
  code: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  /** app / build version */
  version: z.union([z.string().regex(/^[A-Za-z0-9_.+-]{1,32}$/), z.number().int().nonnegative()]),
})

export const telemetryRoutes = new Hono<AppEnv>()

telemetryRoutes.post('/error', async (c) => {
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
