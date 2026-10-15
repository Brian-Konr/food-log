// wrangler.jsonc is the deploy contract: the default deploy ships the API only, with the two export crons and the telemetry limiter.
import { describe, expect, it } from 'vitest'
import { EXPORT_CRON, EXPORT_RESUME_CRON } from '../src/cron/export.ts'
import { stripJsonc } from '../scripts/_jsonc.ts'
import raw from '../wrangler.jsonc?raw'
import pkg from '../package.json'

const cfg = JSON.parse(stripJsonc(raw)) as Record<string, any>

describe('wrangler.jsonc', () => {
  it('has NO static assets: `pnpm run deploy` must not ship the still-v1 frontend', () => {
    expect(cfg).not.toHaveProperty('assets')
  })

  it('registers the export start cron and the 5-minute resume cron, within the free plan limit of 5', () => {
    expect(cfg.triggers.crons).toEqual([EXPORT_CRON, EXPORT_RESUME_CRON])
    expect(cfg.triggers.crons.length).toBeLessThanOrEqual(5)
    expect(EXPORT_RESUME_CRON).toBe('*/5 20 * * *')
  })

  it('declares the telemetry rate limiter binding and the bindings the Worker needs', () => {
    expect(cfg.ratelimits).toEqual([expect.objectContaining({ name: 'TELEMETRY_LIMITER', simple: expect.objectContaining({ limit: expect.any(Number), period: expect.any(Number) }) })])
    expect(cfg.d1_databases[0].binding).toBe('DB')
    expect(cfg.r2_buckets[0].binding).toBe('EXPORTS')
  })
})

describe('deploy scripts', () => {
  it('deploy is API only (no web build, no assets); deploy:with-app goes through the guard script', () => {
    const s = pkg.scripts as Record<string, string>
    expect(s.deploy).not.toMatch(/build:web|assets/)
    expect(s.deploy).toMatch(/wrangler deploy$/)
    expect(s['deploy:with-app']).toBe('node scripts/deploy-with-app.ts')
  })
})
