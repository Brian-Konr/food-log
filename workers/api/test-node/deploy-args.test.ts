// Runs in plain Node (vitest.node.config.ts), not in the Workers pool: the deploy wrapper is a Node script.
import { describe, expect, it } from 'vitest'
import { parseDeployArgs } from '../scripts/deploy-args.ts'

describe('parseDeployArgs', () => {
  it('no arguments: a full deploy with no extra wrangler flags', () => {
    expect(parseDeployArgs([])).toEqual({ check: false, dryRun: false, skipChecks: false, wranglerFlags: [] })
  })

  it('reads the booleans', () => {
    expect(parseDeployArgs(['--check'])).toMatchObject({ check: true })
    expect(parseDeployArgs(['--dry-run', '--skip-checks'])).toMatchObject({ dryRun: true, skipChecks: true })
  })

  it('passes --var (both spellings, repeatable) and --message through to wrangler', () => {
    expect(parseDeployArgs(['--var', 'MIN_CLIENT_VERSION:9999', '--var=EXPORT_ROW_BUDGET:500', '--message', 'rollback: block push']).wranglerFlags).toEqual([
      '--var', 'MIN_CLIENT_VERSION:9999', '--var', 'EXPORT_ROW_BUDGET:500', '--message', 'rollback: block push',
    ])
  })

  it('refuses unknown flags and typos instead of deploying', () => {
    expect(() => parseDeployArgs(['--dryrun'])).toThrow(/dryrun/)
    expect(() => parseDeployArgs(['--force'])).toThrow()
    expect(() => parseDeployArgs(['deploy'])).toThrow()
  })

  it('refuses a malformed or empty --var', () => {
    expect(() => parseDeployArgs(['--var', 'MIN_CLIENT_VERSION:'])).toThrow(/empty value/)
    expect(() => parseDeployArgs(['--var', 'MIN_CLIENT_VERSION:  '])).toThrow(/empty value/)
    expect(() => parseDeployArgs(['--var', 'MIN_CLIENT_VERSION=9999'])).toThrow(/KEY:VALUE/)
    expect(() => parseDeployArgs(['--var', 'min_client_version:9999'])).toThrow(/KEY:VALUE/)
    expect(() => parseDeployArgs(['--var'])).toThrow()
  })

  it('refuses an empty --message', () => {
    expect(() => parseDeployArgs(['--message', ''])).toThrow(/empty/)
  })
})
