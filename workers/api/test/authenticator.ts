// A tiny software WebAuthn authenticator (ES256, attestation "none") so the Better Auth passkey
// endpoints can be exercised end to end in tests without a browser.
const enc = new TextEncoder()

export const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of u) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const unb64u = (s: string): Uint8Array => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0))
}
const cat = (...a: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of a) {
    out.set(x, o)
    o += x.length
  }
  return out
}
const sha256 = async (d: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', d as unknown as ArrayBuffer))

function cborBytesHeader(len: number): Uint8Array {
  if (len < 24) return Uint8Array.of(0x40 | len)
  if (len < 256) return Uint8Array.of(0x58, len)
  return Uint8Array.of(0x59, len >> 8, len & 0xff)
}
const cborText = (s: string): Uint8Array => cat(Uint8Array.of(0x60 | s.length), enc.encode(s))

/** raw r||s (WebCrypto) -> ASN.1 DER ECDSA signature */
function derSig(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array): Uint8Array => {
    let i = 0
    while (i < x.length - 1 && x[i] === 0) i++
    let v: Uint8Array = x.slice(i)
    if (v[0]! & 0x80) v = cat(Uint8Array.of(0), v)
    return cat(Uint8Array.of(0x02, v.length), v)
  }
  const r = int(raw.slice(0, 32))
  const s = int(raw.slice(32))
  return cat(Uint8Array.of(0x30, r.length + s.length), r, s)
}

export class VirtualAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16))
  private keys!: CryptoKeyPair
  private counter = 0

  constructor(private readonly rpId: string, private readonly origin: string) {}

  async init(): Promise<this> {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    return this
  }

  get id(): string {
    return b64u(this.credentialId)
  }

  private async clientData(type: string, challenge: string): Promise<Uint8Array> {
    return enc.encode(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  async register(challenge: string) {
    const raw = new Uint8Array((await crypto.subtle.exportKey('raw', this.keys.publicKey)) as ArrayBuffer)
    const x = raw.slice(1, 33)
    const y = raw.slice(33, 65)
    const cose = cat(Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20), x, Uint8Array.of(0x22, 0x58, 0x20), y)
    const rpHash = await sha256(enc.encode(this.rpId))
    const authData = cat(rpHash, Uint8Array.of(0x45), Uint8Array.of(0, 0, 0, this.counter), new Uint8Array(16), Uint8Array.of(0, this.credentialId.length), this.credentialId, cose)
    const attestationObject = cat(
      Uint8Array.of(0xa3),
      cborText('fmt'),
      cborText('none'),
      cborText('attStmt'),
      Uint8Array.of(0xa0),
      cborText('authData'),
      cborBytesHeader(authData.length),
      authData,
    )
    const clientDataJSON = await this.clientData('webauthn.create', challenge)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  async authenticate(challenge: string) {
    this.counter++
    const rpHash = await sha256(enc.encode(this.rpId))
    const authData = cat(rpHash, Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, this.counter))
    const clientDataJSON = await this.clientData('webauthn.get', challenge)
    const signed = cat(authData, await sha256(clientDataJSON))
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed))
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(derSig(sig)) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }
}
