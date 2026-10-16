// `pnpm run deploy` (= `pnpm run deploy:with-app`): THE way to deploy. Builds the PWA and ships it with the Worker.
// The assets (apps/food-log/dist) are declared in wrangler.jsonc itself, so even a plain `wrangler deploy` cannot drop the
// frontend: without a built dist it refuses ("assets.directory ... does not exist"). This script adds what a plain deploy
// lacks: the guard below, typecheck + tests, a fresh web build (a plain deploy would ship whatever stale dist is there) and
// the remote D1 migrations, in that order.
// The guard refuses if apps/food-log ever contains src/api/gas.ts again (the v1 Apps Script client), so the v1 frontend
// can never be published from this Worker by accident.
//
//   node scripts/deploy-with-app.ts            guard, typecheck + test + build + migrate + deploy
//   node scripts/deploy-with-app.ts --check    only run the guard
//   node scripts/deploy-with-app.ts --dry-run  everything except the remote migration, and `wrangler deploy --dry-run`
//   --skip-checks / --var KEY:VALUE / --message <text>: see DEPLOY_USAGE in deploy-args.ts. Unknown flags are an error.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseDeployArgs } from './deploy-args.ts'

const API_DIR = path.join(import.meta.dirname, '..')
const REPO = path.join(API_DIR, '..', '..')
export const V1_CLIENT = path.join('apps', 'food-log', 'src', 'api', 'gas.ts')
const DIST_INDEX = path.join(REPO, 'apps', 'food-log', 'dist', 'index.html')

/** null when the app may ship, else the reason it may not. */
export function guard(repoRoot: string): string | null {
  if (existsSync(path.join(repoRoot, V1_CLIENT))) {
    return `refusing: ${V1_CLIENT} still exists, so apps/food-log is the v1 frontend (Apps Script client). The app must talk to /sync and that file must be gone before anything is deployed.`
  }
  return null
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { cwd: API_DIR, stdio: 'inherit' })
}

function main(): void {
  let args: ReturnType<typeof parseDeployArgs>
  try {
    args = parseDeployArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(2)
  }
  const refusal = guard(REPO)
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  if (args.check) return
  const pnpm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['pnpm']
  const [bin, ...pre] = pnpm as [string, ...string[]]
  if (args.skipChecks) console.warn('warning: --skip-checks: no typecheck, no tests')
  else {
    run(bin, [...pre, '-r', 'typecheck'])
    run(bin, [...pre, '-r', 'test'])
  }
  run(bin, [...pre, 'run', 'build:web'])
  if (!existsSync(DIST_INDEX)) {
    console.error(`error: the web build did not produce ${path.relative(REPO, DIST_INDEX)}`)
    process.exit(1)
  }
  if (args.dryRun) run(bin, [...pre, 'exec', 'wrangler', 'deploy', '--dry-run', ...args.wranglerFlags])
  else {
    run(bin, [...pre, 'exec', 'wrangler', 'd1', 'migrations', 'apply', 'food-log', '--remote'])
    run(bin, [...pre, 'exec', 'wrangler', 'deploy', ...args.wranglerFlags])
  }
}

if (import.meta.main) main()
