// Argument parsing for scripts/deploy-with-app.ts, kept free of side effects so it can be unit tested (test-node/).
// Strict on purpose: every deploy goes through that script, so a typo (`--dryrun`, `--var=` with an empty value) must stop
// it instead of turning into a real production deploy.
import { parseArgs } from 'node:util'

export const DEPLOY_USAGE = `usage: node scripts/deploy-with-app.ts [--check] [--dry-run] [--skip-checks] [--var KEY:VALUE ...] [--message <text>]
  --check          only run the guard (apps/food-log must not contain the v1 Apps Script client)
  --dry-run        build everything, skip the remote migration, run \`wrangler deploy --dry-run\`
  --skip-checks    skip the workspace typecheck and tests (emergencies only; the app is still built and shipped)
  --var KEY:VALUE  passed to \`wrangler deploy --var\`; repeatable, e.g. --var MIN_CLIENT_VERSION:9999
  --message <text> passed to \`wrangler deploy --message\` (shows in \`wrangler deployments list\`)`

export type DeployArgs = {
  check: boolean
  dryRun: boolean
  skipChecks: boolean
  /** extra `wrangler deploy` arguments built from --var / --message */
  wranglerFlags: string[]
}

const VAR_RE = /^([A-Z_][A-Z0-9_]*):(.*)$/

/** Parses argv (without node and the script path). Throws an Error with a user-facing message on anything unexpected. */
export function parseDeployArgs(argv: string[]): DeployArgs {
  let values: { check?: boolean; 'dry-run'?: boolean; 'skip-checks'?: boolean; var?: string[]; message?: string }
  try {
    values = parseArgs({
      args: argv,
      options: {
        check: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'skip-checks': { type: 'boolean' },
        var: { type: 'string', multiple: true },
        message: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }).values
  } catch (e) {
    throw new Error(`${(e as Error).message}\n${DEPLOY_USAGE}`)
  }
  const wranglerFlags: string[] = []
  for (const v of values.var ?? []) {
    const m = VAR_RE.exec(v)
    if (!m) throw new Error(`--var must look like KEY:VALUE (upper-case KEY), got ${JSON.stringify(v)}`)
    if (m[2]!.trim() === '') throw new Error(`--var ${m[1]} has an empty value`)
    wranglerFlags.push('--var', v)
  }
  if (values.message !== undefined) {
    if (values.message.trim() === '') throw new Error('--message is empty')
    wranglerFlags.push('--message', values.message)
  }
  return { check: values.check === true, dryRun: values['dry-run'] === true, skipChecks: values['skip-checks'] === true, wranglerFlags }
}
