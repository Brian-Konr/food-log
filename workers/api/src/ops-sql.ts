// SQL printed by the ops scripts (scripts/bootstrap-owner.ts, scripts/login-code.ts). Kept here (not inside the scripts)
// so the tests can run exactly the same text against the real schema.
import { CODE_TTL_MS } from './code-hash.ts'

/** SQL string literal. */
export const sqlStr = (s: string): string => `'${s.replaceAll("'", "''")}'`

/** The single owner user. Idempotent on the email. */
export function ownerInsertSql(o: { id: string; name: string; email: string; nowMs: number }): string {
  return `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
VALUES (${sqlStr(o.id)}, ${sqlStr(o.name)}, ${sqlStr(o.email.toLowerCase())}, 1, ${o.nowMs}, ${o.nowMs})
ON CONFLICT (email) DO NOTHING;`
}

/** One-time login code: stores the hash only; the 15 minutes start when the statement RUNS (expiry is computed in SQL). */
export function loginCodeInsertSql(codeHash: string, email: string): string {
  return `INSERT INTO login_codes (code_hash, user_id, expires_at, created_at)
SELECT ${sqlStr(codeHash)}, id, CAST(strftime('%s','now') AS INTEGER) * 1000 + ${CODE_TTL_MS}, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM user WHERE email = ${sqlStr(email.toLowerCase())};`
}
