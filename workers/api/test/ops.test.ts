// The SQL that scripts/bootstrap-owner.ts, login-code.ts and bot-key.ts print, executed against the real schema:
// proves the printed commands work end to end (owner row -> login code -> session; key hash -> bearer works).
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { BOT_METADATA, BOT_PERMISSIONS, buildKeyInsert, generateBotKey, hashApiKey, literalSql } from '../src/bot-key.ts'
import { generateCode, hashCode } from '../src/code-hash.ts'
import { loginCodeInsertSql, ownerInsertSql, sqlStr } from '../src/ops-sql.ts'
import { call, resetDb } from './helpers.ts'

beforeEach(resetDb)

const run = (sql: string) => env.DB.prepare(sql).run()

describe('bootstrap-owner + login-code SQL', () => {
  it('creates the owner (idempotent), mints a code whose hash redeems into a session, 15 minutes from execution', async () => {
    const owner = { id: 'owner-1', name: "Br'ian", email: 'Owner@Example.com', nowMs: Date.now() }
    await run(ownerInsertSql(owner))
    await run(ownerInsertSql({ ...owner, id: 'owner-2' })) // second run: ON CONFLICT DO NOTHING
    expect((await env.DB.prepare(`SELECT id, name, email FROM user`).all()).results).toEqual([{ id: 'owner-1', name: "Br'ian", email: 'owner@example.com' }])

    const code = generateCode()
    await run(loginCodeInsertSql(await hashCode(code), 'OWNER@example.com'))
    const row = (await env.DB.prepare(`SELECT user_id, expires_at, created_at FROM login_codes`).first<{ user_id: string; expires_at: number; created_at: number }>())!
    expect(row.user_id).toBe('owner-1')
    expect(row.expires_at - row.created_at).toBe(15 * 60 * 1000)
    expect(Math.abs(row.created_at - Date.now())).toBeLessThan(5000)

    const res = await call('/api/auth/login-code/redeem', { method: 'POST', json: { code } })
    expect(res.status).toBe(200)
    expect((await call('/api/auth/login-code/redeem', { method: 'POST', json: { code } })).status).toBe(401)
  })

  it('a login code for an unknown owner inserts nothing', async () => {
    await run(loginCodeInsertSql(await hashCode('AAAA-BBBB-CCCC'), 'nobody@example.com'))
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM login_codes`).first<{ n: number }>())!.n).toBe(0)
  })

  it('sqlStr doubles quotes', () => {
    expect(sqlStr("a'b")).toBe("'a''b'")
  })
})

describe('bot-key SQL', () => {
  it('the email form (what the script prints) inserts one row owned by that user, and the key then authenticates', async () => {
    await run(ownerInsertSql({ id: 'owner-1', name: 'Owner', email: 'owner@example.com', nowMs: Date.now() }))
    const key = generateBotKey()
    const { sql, params } = await buildKeyInsert({ id: 'key-1', key, email: 'Owner@Example.com', name: 'kyujin', permissions: BOT_PERMISSIONS, metadata: BOT_METADATA, nowMs: Date.now() })
    await run(literalSql(sql, params))
    const row = (await env.DB.prepare(`SELECT * FROM apikey`).first<Record<string, unknown>>())!
    expect(row).toMatchObject({ id: 'key-1', reference_id: 'owner-1', enabled: 1, name: 'kyujin', prefix: 'flk_', start: key.slice(0, 6) })
    expect(row.key).toBe(await hashApiKey(key))
    expect(JSON.stringify(row)).not.toContain(key)
    const res = await call('/bot/v1/read', { bearer: key })
    expect(res.status).toBe(200)
  })

  it('an unknown owner email inserts 0 rows', async () => {
    const { sql, params } = await buildKeyInsert({ id: 'k', key: generateBotKey(), email: 'nobody@example.com', name: 'kyujin', permissions: BOT_PERMISSIONS, metadata: BOT_METADATA, nowMs: 1 })
    await run(literalSql(sql, params))
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM apikey`).first<{ n: number }>())!.n).toBe(0)
  })

  it('the revoke / list statements printed by the script work', async () => {
    await run(ownerInsertSql({ id: 'owner-1', name: 'Owner', email: 'owner@example.com', nowMs: Date.now() }))
    const key = generateBotKey()
    const { sql, params } = await buildKeyInsert({ id: 'key-9', key, userId: 'owner-1', name: 'kyujin', permissions: BOT_PERMISSIONS, metadata: BOT_METADATA, nowMs: Date.now() })
    await run(literalSql(sql, params))
    expect((await env.DB.prepare(`SELECT id, name, start, enabled, datetime(created_at / 1000, 'unixepoch') AS created, datetime(last_request / 1000, 'unixepoch') AS last_used FROM apikey ORDER BY created_at`).all()).results).toHaveLength(1)
    await run(`DELETE FROM apikey WHERE id = ${sqlStr('key-9')};`)
    expect((await call('/bot/v1/read', { bearer: key })).status).toBe(401)
  })

  it('keys look like flk_ + 48 base62 characters and never repeat', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const k = generateBotKey()
      expect(k).toMatch(/^flk_[A-Za-z0-9]{48}$/)
      seen.add(k)
    }
    expect(seen.size).toBe(200)
  })

  it('literalSql escapes quotes and NULLs', () => {
    expect(literalSql('SELECT ?, ?, ?', ["a'b", null, 5])).toBe("SELECT 'a''b', NULL, 5")
  })
})
