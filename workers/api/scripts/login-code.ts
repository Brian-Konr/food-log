// Mints a one-time login code (15 minutes, single use). Prints the code once and the command that
// stores its SHA-256 hash in D1. The code itself is never stored anywhere.
//
//   node scripts/login-code.ts --email you@example.com --local
//   node scripts/login-code.ts --email you@example.com --remote     # ⛔ Brian only
//
// The 15 minutes start when the printed command RUNS (expiry is computed in SQL), not when this script ran.
import { CODE_TTL_MS, generateCode, hashCode } from '../src/code-hash.ts'
import { loginCodeInsertSql } from '../src/ops-sql.ts'
import { DEFAULT_DB, assertEmail, parseArgs, target, wranglerCommand } from './_cli.ts'

const { flags, opts } = parseArgs(process.argv.slice(2))
const email = assertEmail(opts.email)
const db = opts.db ?? DEFAULT_DB
const code = generateCode()
const hash = await hashCode(code)

const sql = loginCodeInsertSql(hash, email)

console.log(`# login code (valid ${CODE_TTL_MS / 60000} minutes after the command below runs, single use):`)
console.log(`#   ${code}`)
console.log('# store its hash (inserts 0 rows if the owner does not exist yet: run bootstrap-owner first):')
console.log(wranglerCommand(db, target(flags), sql))
