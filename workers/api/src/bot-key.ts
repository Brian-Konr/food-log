// Kyujin API key helpers shared by scripts/bot-key.ts and the tests (WebCrypto only: Node and workerd).
// Better Auth's api-key plugin stores base64url(SHA-256(key)) without padding (its default hasher) in `apikey.key`,
// so a row inserted with the SQL below verifies through auth.api.verifyApiKey exactly like a key the plugin minted itself.
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const BOT_KEY_PREFIX = 'flk_'

/** Scopes of the Kyujin API key (PRD 7.2), stored as key permissions {"foodlog": ["read", "write.kyujin"]} (= foodlog:read, foodlog:write.kyujin). */
export const BOT_PERMISSIONS = { foodlog: ['read', 'write.kyujin'] } as const
/** The key's metadata decides which actor a bot request runs as. Only 'kyujin' exists. */
export const BOT_METADATA = { actor: 'kyujin' } as const

/** `flk_` + 48 random base62 characters (~286 bits). Rejection sampling keeps it uniform. */
export function generateBotKey(): string {
  const out: string[] = []
  const limit = 256 - (256 % B62.length)
  while (out.length < 48) {
    for (const b of crypto.getRandomValues(new Uint8Array(96))) {
      if (b < limit && out.length < 48) out.push(B62[b % B62.length]!)
    }
  }
  return BOT_KEY_PREFIX + out.join('')
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function hashApiKey(key: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))))
}

export type KeyInsertInput = {
  id: string
  key: string
  name: string
  permissions: Record<string, readonly string[]>
  metadata: Record<string, unknown>
  nowMs: number
} & ({ userId: string; email?: undefined } | { email: string; userId?: undefined })

const INSERT_COLUMNS =
  'id, config_id, name, start, reference_id, prefix, key, enabled, rate_limit_enabled, request_count, created_at, updated_at, permissions, metadata'

/**
 * INSERT for the `apikey` table (positional parameters). The owner is either a known user id, or looked up by email inside the
 * statement (scripts/bot-key.ts prints that form for `wrangler d1 execute --command`; it inserts 0 rows if the owner does not exist).
 */
export async function buildKeyInsert(i: KeyInsertInput): Promise<{ sql: string; params: Array<string | number | null> }> {
  const hash = await hashApiKey(i.key)
  const head: Array<string | number | null> = [i.id, i.name, i.key.slice(0, 6)]
  const tail: Array<string | number | null> = [BOT_KEY_PREFIX, hash, i.nowMs, i.nowMs, JSON.stringify(i.permissions), JSON.stringify(i.metadata)]
  if (i.email !== undefined) {
    return {
      sql: `INSERT INTO apikey (${INSERT_COLUMNS}) SELECT ?, 'default', ?, ?, id, ?, ?, 1, 0, 0, ?, ?, ?, ? FROM user WHERE email = ?`,
      params: [...head, ...tail, i.email.toLowerCase()],
    }
  }
  return {
    sql: `INSERT INTO apikey (${INSERT_COLUMNS}) VALUES (?, 'default', ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?)`,
    params: [...head, i.userId, ...tail],
  }
}

/** Inline the parameters as SQL literals (for `wrangler d1 execute --command`, which cannot bind). */
export function literalSql(sql: string, params: ReadonlyArray<string | number | null>): string {
  let i = 0
  return sql.replace(/\?/g, () => {
    const p = params[i++]
    if (p === null || p === undefined) return 'NULL'
    return typeof p === 'number' ? String(p) : `'${p.replaceAll("'", "''")}'`
  })
}
