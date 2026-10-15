// Mints / lists / revokes the Kyujin API key (PRD 7.2). Better Auth stores only base64url(SHA-256(key)); this script
//   * generates the key,
//   * writes it (and the base URL) to ~/.config/studio/bots/kyujin.env with mode 600 (directory 700),
//   * PRINTS the wrangler command that inserts the hash. It never prints the key and never talks to Cloudflare.
// Brian runs the printed command himself. ⛔ Never run against --remote from an agent.
//
//   node scripts/bot-key.ts --email you@example.com --origin https://food-log.<subdomain>.workers.dev --remote   # ⛔ Brian
//   node scripts/bot-key.ts --list --remote
//   node scripts/bot-key.ts --revoke <key id> --remote
//
// Options:
//   --key-file <path>   where to write the key (default ~/.config/studio/bots/kyujin.env); refuses to overwrite without --force
//   --dry-run           print the commands but write no file (the key is not recoverable afterwards)
//   --db <name>         D1 database name (default food-log)
// Rotation: run this again with a different --key-file, switch Kyujin to the new key, then --revoke the old key id.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BOT_METADATA, BOT_PERMISSIONS, buildKeyInsert, generateBotKey, literalSql } from '../src/bot-key.ts'
import { DEFAULT_DB, assertEmail, parseArgs, sqlStr, target, wranglerCommand } from './_cli.ts'

const { flags, opts } = parseArgs(process.argv.slice(2))
const where = target(flags)
const db = opts.db ?? DEFAULT_DB

if (flags.has('list')) {
  console.log('# keys (hashes are never shown; `start` is the first 6 characters of the key):')
  console.log(wranglerCommand(db, where, `SELECT id, name, start, enabled, datetime(created_at / 1000, 'unixepoch') AS created, datetime(last_request / 1000, 'unixepoch') AS last_used FROM apikey ORDER BY created_at`))
  process.exit(0)
}

if (opts.revoke) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(opts.revoke)) {
    console.error('error: --revoke needs a key id (see --list)')
    process.exit(2)
  }
  console.log('# revoke: the very next request with this key is a 401 (no cache)')
  console.log(wranglerCommand(db, where, `DELETE FROM apikey WHERE id = ${sqlStr(opts.revoke)};`))
  process.exit(0)
}

const email = assertEmail(opts.email)
const origin = (opts.origin ?? 'https://<your-worker-origin>').replace(/\/+$/, '')
const envFile = opts['key-file'] ?? join(homedir(), '.config', 'studio', 'bots', 'kyujin.env')

const key = generateBotKey()
const id = crypto.randomUUID()
const { sql, params } = await buildKeyInsert({ id, key, email, name: 'kyujin', permissions: BOT_PERMISSIONS, metadata: BOT_METADATA, nowMs: Date.now() })

if (!flags.has('dry-run')) {
  if (existsSync(envFile) && !flags.has('force')) {
    console.error(`error: ${envFile} already exists. Rotating? write the new key elsewhere (--key-file <path>), or pass --force to overwrite.`)
    process.exit(2)
  }
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 })
  writeFileSync(envFile, `FOODLOG_API_BASE=${origin}/bot/v1\nFOODLOG_API_KEY=${key}\n`, { mode: 0o600 })
  chmodSync(envFile, 0o600) // writeFileSync's mode is ignored when the file already exists
  console.log(`# key written to ${envFile} (mode 600). It is not shown here and cannot be recovered from the database.`)
} else {
  console.log('# --dry-run: no file written; this key is discarded')
}
console.log(`# key id (for --revoke): ${id}`)
console.log('# insert the key hash (inserts 0 rows if the owner does not exist yet: run bootstrap-owner first):')
console.log(wranglerCommand(db, where, literalSql(sql, params)))
