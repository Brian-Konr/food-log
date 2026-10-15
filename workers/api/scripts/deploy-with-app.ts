// `pnpm run deploy:with-app`: deploy the Worker TOGETHER with the PWA (apps/food-log/dist as static assets).
// RESERVED for after Phase 2 rewires the app to /sync: it refuses while apps/food-log still contains src/api/gas.ts
// (the v1 Apps Script client), so the v1 frontend can never be published from this Worker by accident.
//
//   node scripts/deploy-with-app.ts            checks, then typecheck + test + build + migrate + deploy
//   node scripts/deploy-with-app.ts --check    only run the guard
//   node scripts/deploy-with-app.ts --dry-run  everything except the remote migration, and `wrangler deploy --dry-run`
//   --var KEY:VALUE      passed to `wrangler deploy --var` (one), e.g. --var MIN_CLIENT_VERSION:9999 to block pushes on rollback
//                        without dropping the static assets (a plain `wrangler deploy` from wrangler.jsonc would remove them)
//   --message <text>     passed to `wrangler deploy --message` (shows in `wrangler deployments list`)
//
// The assets config is generated from wrangler.jsonc (one source of truth for D1 / R2 / cron / vars); the generated
// file is git-ignored and removed afterwards.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stripJsonc } from './_jsonc.ts'
import { parseArgs } from './_cli.ts'

const API_DIR = path.join(import.meta.dirname, '..')
const REPO = path.join(API_DIR, '..', '..')
export const V1_CLIENT = path.join('apps', 'food-log', 'src', 'api', 'gas.ts')

/** null when the app may ship, else the reason it may not. */
export function guard(repoRoot: string): string | null {
  if (existsSync(path.join(repoRoot, V1_CLIENT))) {
    return `refusing: ${V1_CLIENT} still exists, so apps/food-log is the v1 frontend (Apps Script client). Phase 2 must rewire the app to /sync and delete that file before the app can be deployed with the Worker. Use \`pnpm run deploy\` for the API only.`
  }
  return null
}

export function withAssets(configText: string): Record<string, unknown> {
  const cfg = JSON.parse(stripJsonc(configText)) as Record<string, unknown>
  return {
    ...cfg,
    assets: {
      directory: '../../apps/food-log/dist',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/sync/*', '/bot/*', '/api/*', '/telemetry/*'],
    },
  }
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd: API_DIR, stdio: 'inherit' })
}

/** Extra `wrangler deploy` flags from --var / --message. */
export function deployFlags(opts: Record<string, string>): string[] {
  const out: string[] = []
  if (opts.var !== undefined) {
    if (!/^[A-Z_][A-Z0-9_]*:.*$/.test(opts.var)) throw new Error('--var must look like KEY:VALUE, e.g. MIN_CLIENT_VERSION:9999')
    out.push('--var', opts.var)
  }
  if (opts.message !== undefined) out.push('--message', opts.message)
  return out
}

function main(): void {
  const { flags, opts } = parseArgs(process.argv.slice(2))
  let extra: string[]
  try {
    extra = deployFlags(opts)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(2)
  }
  const refusal = guard(REPO)
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  if (flags.has('check')) return
  const generated = path.join(API_DIR, 'wrangler.with-app.generated.json')
  writeFileSync(generated, JSON.stringify(withAssets(readFileSync(path.join(API_DIR, 'wrangler.jsonc'), 'utf8')), null, 2) + '\n')
  try {
    const pnpm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['pnpm']
    const [bin, ...pre] = pnpm as [string, ...string[]]
    run(bin, [...pre, '-r', 'typecheck'])
    run(bin, [...pre, '-r', 'test'])
    run(bin, [...pre, 'run', 'build:web'])
    if (flags.has('dry-run')) run(bin, [...pre, 'exec', 'wrangler', 'deploy', '--dry-run', '--config', generated, ...extra])
    else {
      run(bin, [...pre, 'exec', 'wrangler', 'd1', 'migrations', 'apply', 'food-log', '--remote'])
      run(bin, [...pre, 'exec', 'wrangler', 'deploy', '--config', generated, ...extra])
    }
  } finally {
    rmSync(generated, { force: true })
  }
}

if (import.meta.main) main()
