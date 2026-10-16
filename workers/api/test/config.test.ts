// wrangler.jsonc + the deploy scripts are the deploy contract: the config itself carries the PWA assets (so no deploy can
// drop the frontend), every scripted deploy goes through scripts/deploy-with-app.ts, plus the two export crons and the
// telemetry limiter.
import { describe, expect, it } from 'vitest'
import { EXPORT_CRON, EXPORT_RESUME_CRON } from '../src/cron/export.ts'
import { stripJsonc } from '../scripts/_jsonc.ts'
import raw from '../wrangler.jsonc?raw'
import pkg from '../package.json'
import rootPkg from '../../../package.json'

const cfg = JSON.parse(stripJsonc(raw)) as Record<string, any>

describe('wrangler.jsonc', () => {
  it('declares the PWA assets itself, so even a plain `wrangler deploy` ships (or refuses without) the frontend', () => {
    expect(cfg.assets).toEqual({
      directory: '../../apps/food-log/dist',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/sync/*', '/bot/*', '/api/*', '/telemetry/*'],
    })
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
  it('deploy and deploy:with-app both go through deploy-with-app.ts (guard, checks, fresh web build, migrations)', () => {
    const s = pkg.scripts as Record<string, string>
    expect(s.deploy).toBe('node scripts/deploy-with-app.ts')
    expect(s['deploy:with-app']).toBe('node scripts/deploy-with-app.ts')
    for (const [name, cmd] of Object.entries(s)) expect(cmd, name).not.toMatch(/wrangler (versions )?deploy/)
  })

  it('dev builds the web first (wrangler dev needs the assets directory)', () => {
    expect((pkg.scripts as Record<string, string>).dev).toBe('pnpm run build:web && wrangler dev --local')
  })

  it('the root deploy script delegates to the api package deploy', () => {
    expect((rootPkg.scripts as Record<string, string>).deploy).toBe('pnpm --filter @food-log/api run deploy')
  })
})
