import { CLIENT_VERSION_HEADER, OWNER, isClientTooOld, parseClientVersionHeader, pull, processPush, pushRequestSchema } from '@food-log/core'
import { Hono } from 'hono'
import { z } from 'zod'
import { NO_ORIGIN } from '../app-env.ts'
import type { AppEnv } from '../app-env.ts'
import { authFor } from '../auth.ts'
import { D1Store } from '../db/d1-store.ts'
import { minClientVersion } from '../env.ts'

export const syncRoutes = new Hono<AppEnv>()

// every /sync/* request needs a session. With the cookie cache this is usually a signature check, not a D1 read;
// returnHeaders hands back the Set-Cookie that (re)fills / clears the cache cookie.
syncRoutes.use('*', async (c, next) => {
  const auth = authFor(c.env, c.req.url)
  if (!auth) return c.json(NO_ORIGIN, 500)
  const lookup = (disableCookieCache: boolean) => auth.api.getSession({ headers: c.req.raw.headers, query: { disableCookieCache }, returnHeaders: true })
  let result: Awaited<ReturnType<typeof lookup>>
  try {
    result = await lookup(false)
  } catch {
    // e.g. a malformed session_data cookie makes Better Auth throw: ignore the cache and ask D1 instead
    try {
      result = await lookup(true)
    } catch {
      return c.json({ error: 'unauthorized' }, 401)
    }
  }
  const { headers, response: session } = result
  for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true })
  if (!session) return c.json({ error: 'unauthorized' }, 401)
  c.set('userId', session.user.id)
  await next()
})

syncRoutes.post('/push', async (c) => {
  const min = minClientVersion(c.env)
  if (isClientTooOld(parseClientVersionHeader(c.req.header(CLIENT_VERSION_HEADER)), min)) {
    return c.json({ error: 'client_too_old', minClientVersion: min }, 409)
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_request', message: 'invalid JSON' }, 400)
  }
  const parsed = pushRequestSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'invalid push body' }, 400)
  const store = new D1Store(c.env.DB).forUser(c.get('userId'))
  const out = await processPush(store, { actor: OWNER, now: Date.now }, parsed.data)
  return c.json(out)
})

const pullQuery = z.object({
  cookie: z.string().max(128).optional(),
  clientId: z.string().min(1).max(128),
  afterMutationId: z.coerce.number().int().min(0).optional(),
})

syncRoutes.get('/pull', async (c) => {
  const q = pullQuery.safeParse(c.req.query())
  if (!q.success) return c.json({ error: 'bad_request', message: 'clientId required' }, 400)
  const store = new D1Store(c.env.DB).forUser(c.get('userId'))
  const out = await pull(
    store,
    { cookie: q.data.cookie ?? '', clientId: q.data.clientId, afterMutationId: q.data.afterMutationId ?? 0 },
    { minClientVersion: minClientVersion(c.env) },
  )
  return c.json(out)
})
