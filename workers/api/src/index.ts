import { TransientError } from '@food-log/core'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { NO_ORIGIN } from './app-env.ts'
import type { AppEnv } from './app-env.ts'
import { authFor } from './auth.ts'
import { scheduledExport } from './cron/export.ts'
import type { Env } from './env.ts'
import { botRoutes } from './routes/bot.ts'
import { healthRoutes } from './routes/health.ts'
import { syncRoutes } from './routes/sync.ts'
import { telemetryRoutes } from './routes/telemetry.ts'

export const app = new Hono<AppEnv>()

app.route('/', healthRoutes)

// Better Auth (passkey + login-code + api-key plugins): /api/auth/*
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const auth = authFor(c.env, c.req.url)
  if (!auth) return c.json(NO_ORIGIN, 500)
  return auth.handler(c.req.raw)
})

app.route('/sync', syncRoutes)
app.route('/bot/v1', botRoutes)
app.route('/telemetry', telemetryRoutes)

app.notFound((c) => (c.req.path.startsWith('/bot/') ? c.json({ ok: false, error: 'not_found', message: 'no such endpoint' }, 404) : c.json({ error: 'not_found' }, 404)))

// TransientError (CAS retries exhausted) and storage failures are transient: the client backs off 2/5/15 s and resends,
// and already committed mutations are recognised by the cursor.
app.onError((e, c) => {
  if (e instanceof HTTPException) {
    // e.g. a request body that is not valid JSON (thrown by the validator): a client error, not a server failure
    if (c.req.path.startsWith('/bot/')) return c.json({ ok: false, error: e.status === 400 ? 'bad_record' : 'error', message: e.message }, e.status)
    return e.getResponse()
  }
  console.error(JSON.stringify({ type: 'server_error', name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message.slice(0, 300) : '', transient: e instanceof TransientError }))
  return c.req.path.startsWith('/bot/') ? c.json({ ok: false, error: 'unavailable', message: 'temporary error, retry later' }, 503) : c.json({ error: 'unavailable' }, 503)
})

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await scheduledExport(event, env)
  },
} satisfies ExportedHandler<Env>
