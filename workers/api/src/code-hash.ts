// Pure helpers shared by the Worker and the CLI scripts (WebCrypto only: works in Node and workerd).
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789' // 30 chars, no 0/O/1/I/L/U
export const CODE_TTL_MS = 15 * 60 * 1000

/** 12 chars, grouped XXXX-XXXX-XXXX, ~58.9 bits. Rejection sampling keeps it uniform. */
export function generateCode(): string {
  const out: string[] = []
  const limit = 256 - (256 % ALPHABET.length)
  while (out.length < 12) {
    const buf = crypto.getRandomValues(new Uint8Array(24))
    for (const b of buf) {
      if (b < limit && out.length < 12) out.push(ALPHABET[b % ALPHABET.length]!)
    }
  }
  const s = out.join('')
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
}

/** Case, dashes and whitespace are ignored when typing a code. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hashCode(code: string): Promise<string> {
  return sha256Hex(normalizeCode(code))
}
