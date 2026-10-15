// Prints the command that creates the single owner user. Run it ONCE per database.
//
//   node scripts/bootstrap-owner.ts --email you@example.com --name Brian --local
//   node scripts/bootstrap-owner.ts --email you@example.com --name Brian --remote   # ⛔ Brian only
//
// The email is never stored in git: it is a CLI argument and ends up only in the D1 `user` row and in the
// ALLOWED_EMAILS secret (`wrangler secret put ALLOWED_EMAILS`). Sign-up is otherwise closed, so this is
// the only way a user row appears.
import { ownerInsertSql } from '../src/ops-sql.ts'
import { DEFAULT_DB, assertEmail, parseArgs, target, wranglerCommand } from './_cli.ts'

const { flags, opts } = parseArgs(process.argv.slice(2))
const email = assertEmail(opts.email)
const name = (opts.name ?? 'Owner').replace(/[\r\n]/g, ' ').slice(0, 60)
const db = opts.db ?? DEFAULT_DB
const sql = ownerInsertSql({ id: crypto.randomUUID(), name, email, nowMs: Date.now() })

console.log('# 1. make sure the address is on the allow list (secret, not in git):')
console.log('#    npx -y pnpm@10 --filter @food-log/api exec wrangler secret put ALLOWED_EMAILS   # value: comma separated emails')
console.log('# 2. create the owner row:')
console.log(wranglerCommand(db, target(flags), sql))
console.log('# 3. then mint a one-time login code:')
console.log(`#    node workers/api/scripts/login-code.ts --email <same address> ${target(flags)}`)
