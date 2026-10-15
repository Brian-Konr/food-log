// /bot/v1/*: the Kyujin API (PRD 8, docs/kyujin-api-v2.md). Bearer API key (Better Auth api-key plugin), OpenAPI from zod.
//   GET  /read                    items / stores / config (all, incl. deleted), logs 35 days, weights 90 days
//   GET  /summary?day=            totals, targets, remaining (core summarizeDay: the same numbers the app shows)
//   GET  /trends?weekStart=       week summary (core weekSummary); weekStart must be a Monday
//   GET  /history?table&before&limit
//   POST /mutate {name, args}     only BOT_MUTATION_NAMES, through core processPush as actor kyujin
//   GET  /openapi.json
// Envelope: {ok:true, ...} or {ok:false, error, message, details?}. 401 unauthorized (bad / revoked key), 403 forbidden.
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import {
  BOT_MUTATION_NAMES,
  KYUJIN,
  addDays,
  defaultConfigRow,
  itemRowSchema,
  logRowSchema,
  processPush,
  configRowSchema,
  storeRowSchema,
  summarizeDay,
  taipeiIso,
  taipeiToday,
  weekSummary,
  weekStart as weekStartOf,
  weightRowSchema,
} from '@food-log/core'
import type { MutationOutcome, PushResult, RecordedError, ServerTx, UserStore } from '@food-log/core'
import { NO_ORIGIN } from '../app-env.ts'
import type { AppEnv } from '../app-env.ts'
import { authFor, bearerOf, verifyBotKey } from '../auth.ts'
import { D1Store } from '../db/d1-store.ts'

/** Same window as v1: Logs 35 days back (inclusive of today), Weights 90 days. */
export const BOT_LOG_DAYS = 35
export const BOT_WEIGHT_DAYS = 90
export const HISTORY_DEFAULT_LIMIT = 35
export const HISTORY_MAX_LIMIT = 90

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && addDays(d, 0) === d, 'must be a real YYYY-MM-DD date')

// ---- response schemas (core's row schemas minus the two internal columns) ----
const omitInternal = { user_id: true, version: true } as const
const storeOut = storeRowSchema.omit(omitInternal)
const itemOut = itemRowSchema.omit(omitInternal)
const logOut = logRowSchema.omit(omitInternal)
const weightOut = weightRowSchema.omit(omitInternal)
const configOut = configRowSchema.omit(omitInternal)

const macros = z.object({ kcal: z.number(), protein: z.number(), fat: z.number(), carb: z.number() })
const errorOut = z.object({ ok: z.literal(false), error: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() })

const errorResponses = {
  400: { content: { 'application/json': { schema: errorOut } }, description: 'bad_record: the request or the mutation arguments are invalid' },
  401: { content: { 'application/json': { schema: errorOut } }, description: 'unauthorized: missing, unknown, revoked or expired API key' },
  403: { content: { 'application/json': { schema: errorOut } }, description: 'forbidden: not allowed for this key or this mutation' },
} as const
const json = <S extends z.ZodType>(schema: S, description: string) => ({ content: { 'application/json': { schema } }, description })

const readRoute = createRoute({
  method: 'get',
  path: '/read',
  summary: `Items, stores, config (all, incl. deleted); logs ${BOT_LOG_DAYS} days; weights ${BOT_WEIGHT_DAYS} days`,
  security: [{ Bearer: [] }],
  responses: {
    200: json(
      z.object({
        ok: z.literal(true),
        serverTime: z.string().describe('Server time as Taipei ISO, YYYY-MM-DDTHH:MM:SS+08:00 (same as v1)'),
        config: configOut,
        items: z.array(itemOut),
        stores: z.array(storeOut),
        logs: z.array(logOut),
        weights: z.array(weightOut),
        logDays: z.literal(BOT_LOG_DAYS),
        weightDays: z.literal(BOT_WEIGHT_DAYS),
      }),
      'Everything Kyujin needs to answer questions about the current state',
    ),
    ...errorResponses,
  },
})

const summaryRoute = createRoute({
  method: 'get',
  path: '/summary',
  summary: 'How much is left today (or on `day`)',
  description: '`remaining = target - total` and can be negative (over the target). Totals use the numbers stored on each log.',
  security: [{ Bearer: [] }],
  request: { query: z.object({ day: dayString.optional().describe('YYYY-MM-DD (Taipei). Default: today.') }) },
  responses: {
    200: json(z.object({ ok: z.literal(true), day: z.string(), count: z.number(), totals: macros, targets: macros, remaining: macros }), 'Day summary'),
    ...errorResponses,
  },
})

const trendsRoute = createRoute({
  method: 'get',
  path: '/trends',
  summary: 'Week summary (average kcal, deficit, protein hit days, incomplete days)',
  security: [{ Bearer: [] }],
  request: { query: z.object({ weekStart: dayString.describe('The Monday of the week, YYYY-MM-DD.') }) },
  responses: {
    200: json(
      z.object({
        ok: z.literal(true),
        weekStart: z.string(),
        weekEnd: z.string(),
        avgKcal: z.number().nullable(),
        avgDeficit: z.number().nullable(),
        proteinHit: z.number(),
        proteinDenom: z.number(),
        incompleteDays: z.number(),
      }),
      'Week summary',
    ),
    ...errorResponses,
  },
})

const historyRoute = createRoute({
  method: 'get',
  path: '/history',
  summary: 'Page back through logs or weights older than the read window',
  description: `Rows with day < before, newest first (deleted rows included), at most limit (default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}). hasMore tells whether to ask again with before = the oldest day returned.`,
  security: [{ Bearer: [] }],
  request: {
    query: z.object({
      table: z.enum(['logs', 'weights']),
      before: dayString,
      limit: z.coerce.number().int().min(1).optional(),
    }),
  },
  responses: {
    200: json(z.object({ ok: z.literal(true), table: z.enum(['logs', 'weights']), records: z.array(z.union([logOut, weightOut])), hasMore: z.boolean() }), 'A page of history'),
    ...errorResponses,
  },
})

const mutateRoute = createRoute({
  method: 'post',
  path: '/mutate',
  summary: 'Run one mutation as Kyujin',
  description:
    `\`name\` is one of ${BOT_MUTATION_NAMES.map((n) => '`' + n + '`').join(', ')} (the version suffix is required); \`args\` is that mutation's argument object ` +
    '(see docs/kyujin-api-v2.md). Anything else is `forbidden`. Business errors keep their code (bad_record, forbidden, duplicate_name, not_found) and are not retried: ' +
    'the same request would fail the same way. Resending a successful request is safe: records are keyed by id.',
  security: [{ Bearer: [] }],
  request: { body: { required: true, content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(64), args: z.unknown() }) } } } },
  responses: {
    200: json(z.object({ ok: z.literal(true), result: z.unknown() }), 'The mutation result (e.g. {rowId}, {duplicate:true}, {ignored:"deleted"}, {rowId, overwritten, prevKg})'),
    ...errorResponses,
    404: { content: { 'application/json': { schema: errorOut } }, description: 'not_found' },
    409: { content: { 'application/json': { schema: errorOut } }, description: 'duplicate_name (details.existingId / existingName)' },
    503: { content: { 'application/json': { schema: errorOut } }, description: 'unavailable: transient, retry later' },
  },
})

const STATUS: Record<string, 400 | 403 | 404 | 409> = { bad_record: 400, forbidden: 403, not_found: 404, duplicate_name: 409 }

class CursorMoved extends Error {}

/**
 * Bot mutations carry no client-side counter: the server picks cursor + 1 for the key's own clientId.
 * Two concurrent requests could pick the same id, and the second would then see the first one's outcome as a "replay".
 * This wrapper aborts when begin() sees a cursor other than the one the id was derived from, so the route re-derives it.
 */
function expectingCursor(inner: UserStore, expected: number): UserStore {
  return {
    userId: inner.userId,
    begin: async (clientId: string): Promise<ServerTx> => {
      const tx = await inner.begin(clientId)
      if (tx.lastMutationId !== expected) throw new CursorMoved()
      return tx
    },
    readMeta: () => inner.readMeta(),
    rowsAfter: (a, l) => inner.rowsAfter(a, l),
    rowsAtVersion: (v) => inner.rowsAtVersion(v),
    getLastMutationId: (c) => inner.getLastMutationId(c),
    getMutationOutcome: (c, m): Promise<MutationOutcome | undefined> => inner.getMutationOutcome(c, m),
    listErrors: (c, a): Promise<RecordedError[]> => inner.listErrors(c, a),
  }
}

export const botRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      const message = result.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; ')
      return c.json({ ok: false as const, error: 'bad_record', message }, 400)
    }
    return undefined
  },
})

botRoutes.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', { type: 'http', scheme: 'bearer', description: 'Kyujin API key (scopes foodlog:read, foodlog:write.kyujin)' })

// Authentication runs before validation and before every handler (openapi.json included).
botRoutes.use('*', async (c, next) => {
  const auth = authFor(c.env, c.req.url)
  if (!auth) return c.json({ ok: false, error: 'misconfigured', message: NO_ORIGIN.error }, 500)
  const need = c.req.method === 'POST' ? 'write' : 'read'
  const check = await verifyBotKey(auth, c.env, bearerOf(c.req.header('Authorization')), need)
  if (!check.ok) {
    const message = check.error === 'unauthorized' ? 'missing, unknown, revoked or expired API key' : 'this key may not do that'
    return c.json({ ok: false, error: check.error, message }, check.status)
  }
  c.set('userId', check.userId)
  c.set('bot', { keyId: check.keyId, actor: check.actor })
  await next()
})

const userStore = (c: { env: AppEnv['Bindings']; get: (k: 'userId') => string }) => new D1Store(c.env.DB).forUser(c.get('userId'))

botRoutes.openapi(readRoute, async (c) => {
  const store = userStore(c)
  const today = taipeiToday(Date.now())
  const [items, stores, config, logs, weights] = await Promise.all([
    store.allRows('items'),
    store.allRows('stores'),
    store.configRow(),
    store.rowsInDays('logs', addDays(today, -(BOT_LOG_DAYS - 1))),
    store.rowsInDays('weights', addDays(today, -(BOT_WEIGHT_DAYS - 1))),
  ])
  const strip = <T extends { user_id: string; version: number }>(r: T): Omit<T, 'user_id' | 'version'> => {
    const { user_id: _u, version: _v, ...rest } = r
    return rest
  }
  return c.json(
    {
      ok: true as const,
      serverTime: taipeiIso(Date.now()),
      config: strip(config ?? defaultConfigRow(c.get('userId'))),
      items: items.map(strip),
      stores: stores.map(strip),
      logs: logs.map(strip),
      weights: weights.map(strip),
      logDays: BOT_LOG_DAYS as 35,
      weightDays: BOT_WEIGHT_DAYS as 90,
    },
    200,
  )
})

botRoutes.openapi(summaryRoute, async (c) => {
  const day = c.req.valid('query').day ?? taipeiToday(Date.now())
  const store = userStore(c)
  const [logs, config] = await Promise.all([store.rowsInDays('logs', day, day), store.configRow()])
  return c.json({ ok: true as const, ...summarizeDay(logs, config ?? defaultConfigRow(c.get('userId')), day) }, 200)
})

botRoutes.openapi(trendsRoute, async (c) => {
  const ws = c.req.valid('query').weekStart
  if (weekStartOf(ws) !== ws) return c.json({ ok: false as const, error: 'bad_record', message: 'weekStart 必須是週一' }, 400) as never
  const store = userStore(c)
  const [logs, config] = await Promise.all([store.rowsInDays('logs', ws, addDays(ws, 6)), store.configRow()])
  const today = taipeiToday(Date.now())
  return c.json({ ok: true as const, ...weekSummary(logs, config ?? defaultConfigRow(c.get('userId')), today, ws) }, 200)
})

botRoutes.openapi(historyRoute, async (c) => {
  const q = c.req.valid('query')
  const limit = Math.min(q.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT)
  const store = userStore(c)
  const page = q.table === 'logs' ? await store.historyBefore('logs', q.before, limit) : await store.historyBefore('weights', q.before, limit)
  const strip = (r: { user_id: string; version: number }) => {
    const { user_id: _u, version: _v, ...rest } = r
    return rest
  }
  return c.json({ ok: true as const, table: q.table, records: page.records.map(strip), hasMore: page.hasMore }, 200) as never
})

botRoutes.openapi(mutateRoute, async (c) => {
  const { name, args } = c.req.valid('json')
  const base = userStore(c)
  const clientId = `bot:${c.get('bot').keyId}`
  const now = Date.now()
  for (let attempt = 0; attempt < 5; attempt++) {
    const cursor = await base.getLastMutationId(clientId)
    let res: PushResult | undefined
    try {
      const out = await processPush(
        expectingCursor(base, cursor),
        { actor: KYUJIN, now: Date.now },
        { clientId, mutations: [{ id: cursor + 1, name, args, clientTs: now }] },
        { allow: BOT_MUTATION_NAMES },
      )
      res = out.results[0]
    } catch (e) {
      if (e instanceof CursorMoved) continue
      throw e
    }
    if (!res) break
    if (res.ok) return c.json({ ok: true as const, result: res.result ?? null }, 200)
    const status = STATUS[res.error] ?? 400
    const body = { ok: false as const, error: res.error, message: res.message, ...(res.details ? { details: res.details } : {}) }
    return c.json(body, status) as never
  }
  return c.json({ ok: false as const, error: 'unavailable', message: 'too many concurrent writes, retry' }, 503) as never
})

botRoutes.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'food-log Kyujin API',
    version: '1',
    description: 'Bearer API key with scopes foodlog:read and foodlog:write.kyujin. Paths are relative to the worker origin + /bot/v1.',
  },
  servers: [{ url: '/bot/v1' }],
  security: [{ Bearer: [] }],
})
