import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getAuth } from '../src/auth.ts'
import { generateCode, hashCode, normalizeCode } from '../src/code-hash.ts'
import type { Env } from '../src/env.ts'
import { VirtualAuthenticator } from './authenticator.ts'
import { ORIGIN, call, issueCode, login, resetDb, seedUser } from './helpers.ts'

beforeEach(resetDb)

const cookiesOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
const redeem = (code: string) => call('/api/auth/login-code/redeem', { method: 'POST', json: { code } })

describe('one-time login code', () => {
  it('redeems into a session that unlocks /sync/*', async () => {
    const id = await seedUser()
    const code = await issueCode(id)
    const res = await redeem(code)
    expect(res.status).toBe(200)
    const cookie = cookiesOf(res)
    expect(cookie).toMatch(/session_token=/)
    expect((await call('/sync/pull?clientId=c', { cookie })).status).toBe(200)
  })

  it('is single use', async () => {
    const id = await seedUser()
    const code = await issueCode(id)
    expect((await redeem(code)).status).toBe(200)
    const again = await redeem(code)
    expect(again.status).toBe(401)
    expect(await again.json()).toMatchObject({ message: 'invalid_or_expired_code' })
  })

  it('two simultaneous redemptions: exactly one wins', async () => {
    const id = await seedUser()
    const code = await issueCode(id)
    const rs = await Promise.all([redeem(code), redeem(code), redeem(code)])
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401, 401])
  })

  it('expires after its TTL', async () => {
    const id = await seedUser()
    const code = await issueCode(id, { ttlMs: -1000 })
    expect((await redeem(code)).status).toBe(401)
    // and is not consumed by the failed attempt in a way that matters: still no session
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM session`).first<{ n: number }>())!.n).toBe(0)
  })

  it('a code that is still inside the 15 minute window works', async () => {
    const id = await seedUser()
    const code = await issueCode(id, { ttlMs: 14 * 60 * 1000 })
    expect((await redeem(code)).status).toBe(200)
  })

  it('unknown codes are rejected; case, dashes and spaces are ignored when typing', async () => {
    expect((await redeem('AAAA-BBBB-CCCC')).status).toBe(401)
    const id = await seedUser()
    const code = await issueCode(id)
    expect((await redeem(' ' + code.toLowerCase().replaceAll('-', ' ') + ' ')).status).toBe(200)
  })

  it('only the SHA-256 hash is stored, never the code', async () => {
    const id = await seedUser()
    const code = await issueCode(id)
    const row = await env.DB.prepare(`SELECT * FROM login_codes`).first<Record<string, unknown>>()
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row!.code_hash).toBe(await hashCode(code))
    expect(JSON.stringify(row)).not.toContain(normalizeCode(code))
  })

  it('a user whose email is not on ALLOWED_EMAILS cannot get a session, even with a valid code', async () => {
    const id = await seedUser('intruder@example.com')
    const code = await issueCode(id)
    const res = await redeem(code)
    expect(res.status).toBe(403)
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM session`).first<{ n: number }>())!.n).toBe(0)
  })

  it('the cookie is HttpOnly, Secure (https), SameSite=Lax and lasts 90 days', async () => {
    const id = await seedUser()
    const res = await redeem(await issueCode(id))
    const sc = res.headers.getSetCookie().find((c) => c.includes('session_token'))!
    expect(sc).toMatch(/HttpOnly/i)
    expect(sc).toMatch(/Secure/i)
    expect(sc).toMatch(/SameSite=Lax/i)
    expect(sc).toMatch(/Max-Age=7776000/)
  })

  it('generated codes look like XXXX-XXXX-XXXX and do not repeat', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = generateCode()
      expect(c).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/)
      seen.add(c)
    }
    expect(seen.size).toBe(200)
  })
})

describe('sign-up is closed', () => {
  it('sign-up outside AND inside the allow list is rejected over HTTP', async () => {
    for (const email of ['intruder@example.com', 'owner@example.com']) {
      const res = await call('/api/auth/sign-up/email', { method: 'POST', json: { email, password: 'correct horse battery', name: 'N' } })
      expect(res.status, email).toBeGreaterThanOrEqual(400)
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM user`).first<{ n: number }>())!.n).toBe(0)
  })

  it('defence in depth: the user-create hook refuses addresses that are not on ALLOWED_EMAILS even if a code path existed', async () => {
    const auth = getAuth(env as unknown as Env, ORIGIN)
    const ctx = await auth.$context
    const createUser = ctx.internalAdapter.createUser as unknown as (u: object) => Promise<unknown>
    const row = (email: string) => createUser({ email, name: 'x', emailVerified: true }).then(
      (u) => u,
      () => null,
    )
    expect(await row('intruder@example.com')).toBeFalsy()
    expect(await row('Second@Example.com')).toBeTruthy() // on the list (case-insensitive)
    expect((await env.DB.prepare(`SELECT email FROM user`).all<{ email: string }>()).results.map((r) => r.email)).toEqual(['second@example.com'])
  })

  it('POST /sign-up/email creates no user', async () => {
    const res = await call('/api/auth/sign-up/email', { method: 'POST', json: { email: 'new@example.com', password: 'correct horse battery', name: 'N' } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM user`).first<{ n: number }>())!.n).toBe(0)
  })
  it('passkey registration without a session is refused', async () => {
    const res = await call('/api/auth/passkey/generate-register-options')
    expect(res.status).toBe(401)
  })
})

describe('passkey (Better Auth + D1, virtual authenticator)', () => {
  it('register while logged in with a code, then sign in with the passkey and reach /sync/*', async () => {
    const { cookie, userId } = await login()
    const rpId = new URL(ORIGIN).hostname
    const authn = await new VirtualAuthenticator(rpId, ORIGIN).init()

    // registration (requires the session from the login code)
    const optRes = await call('/api/auth/passkey/generate-register-options', { cookie })
    expect(optRes.status).toBe(200)
    const opts = (await optRes.json()) as { challenge: string; rp: { id: string; name: string } }
    expect(opts.rp.id).toBe(rpId) // RP ID is the full worker hostname
    const challengeCookie = optRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const reg = await call('/api/auth/passkey/verify-registration', {
      method: 'POST',
      cookie: cookie + '; ' + challengeCookie,
      json: { response: await authn.register(opts.challenge), name: 'test key' },
    })
    expect(reg.status, await reg.clone().text()).toBe(200)
    const row = await env.DB.prepare(`SELECT user_id, credential_id, counter, device_type FROM passkey`).first<Record<string, unknown>>()
    expect(row).toMatchObject({ user_id: userId, credential_id: authn.id })

    // logged out: authenticate with the passkey
    const aoRes = await call('/api/auth/passkey/generate-authenticate-options')
    expect(aoRes.status).toBe(200)
    const ao = (await aoRes.json()) as { challenge: string; rpId: string }
    expect(ao.rpId).toBe(rpId)
    const authCookie = cookiesOf(aoRes)
    const v = await call('/api/auth/passkey/verify-authentication', {
      method: 'POST',
      cookie: authCookie,
      json: { response: await authn.authenticate(ao.challenge) },
    })
    expect(v.status, await v.clone().text()).toBe(200)
    const sessionCookie = cookiesOf(v)
    expect(sessionCookie).toMatch(/session_token=/)
    expect((await call('/sync/pull?clientId=c', { cookie: sessionCookie })).status).toBe(200)
    // counter advanced
    expect((await env.DB.prepare(`SELECT counter FROM passkey`).first<{ counter: number }>())!.counter).toBe(1)
  })

  it('a wrong signature is rejected', async () => {
    const { cookie } = await login()
    const rpId = new URL(ORIGIN).hostname
    const authn = await new VirtualAuthenticator(rpId, ORIGIN).init()
    const optRes = await call('/api/auth/passkey/generate-register-options', { cookie })
    const opts = (await optRes.json()) as { challenge: string }
    await call('/api/auth/passkey/verify-registration', {
      method: 'POST',
      cookie: cookie + '; ' + cookiesOf(optRes),
      json: { response: await authn.register(opts.challenge) },
    })
    const imposter = await new VirtualAuthenticator(rpId, ORIGIN).init()
    const aoRes = await call('/api/auth/passkey/generate-authenticate-options')
    const ao = (await aoRes.json()) as { challenge: string }
    const assertion = await imposter.authenticate(ao.challenge)
    assertion.id = authn.id // pretends to be the registered credential
    assertion.rawId = authn.id
    const v = await call('/api/auth/passkey/verify-authentication', { method: 'POST', cookie: cookiesOf(aoRes), json: { response: assertion } })
    expect(v.status).toBeGreaterThanOrEqual(400)
  })

  it('a passkey of a user who is no longer on ALLOWED_EMAILS cannot sign in (session hook)', async () => {
    const { cookie, userId } = await login()
    const rpId = new URL(ORIGIN).hostname
    const authn = await new VirtualAuthenticator(rpId, ORIGIN).init()
    const optRes = await call('/api/auth/passkey/generate-register-options', { cookie })
    const opts = (await optRes.json()) as { challenge: string }
    await call('/api/auth/passkey/verify-registration', { method: 'POST', cookie: cookie + '; ' + cookiesOf(optRes), json: { response: await authn.register(opts.challenge) } })
    await env.DB.prepare(`UPDATE user SET email = 'removed@example.com' WHERE id = ?`).bind(userId).run()
    const aoRes = await call('/api/auth/passkey/generate-authenticate-options')
    const ao = (await aoRes.json()) as { challenge: string }
    const v = await call('/api/auth/passkey/verify-authentication', { method: 'POST', cookie: cookiesOf(aoRes), json: { response: await authn.authenticate(ao.challenge) } })
    expect(v.status).toBeGreaterThanOrEqual(400)
  })
})
