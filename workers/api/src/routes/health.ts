import { CLIENT_VERSION } from '@food-log/core'
import { Hono } from 'hono'
import type { AppEnv } from '../app-env.ts'

export const healthRoutes = new Hono<AppEnv>()

healthRoutes.get('/api/health', (c) => c.json({ ok: true, clientVersion: CLIENT_VERSION }))
