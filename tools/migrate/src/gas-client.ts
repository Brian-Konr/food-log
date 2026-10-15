// Client for the v1 Apps Script Web App (/exec). Same wire format as the v1 front end:
// POST, Content-Type text/plain (no CORS preflight), body JSON { secret, action, ... }.
//
// GAS_URL and GAS_SECRET come from the environment ONLY (never argv, never a file in the repo). The secret is sent in the
// request body and is never logged: error messages and the thrown objects are scrubbed of it.
// ⛔ Only Brian runs this against the real /exec (docs/runbooks/v2-cutover.md); tests use a fake fetch / the in-memory GAS.

export interface GasResponse {
  ok?: boolean
  error?: string
  message?: string
  [k: string]: unknown
}

/** What fetch-sheet and reverse-export need. `call` returns the parsed JSON body (ok:false included). */
export interface GasClient {
  call(body: Record<string, unknown>): Promise<GasResponse>
}

export class GasError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'GasError'
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'follow' }) => Promise<{ status: number; text(): Promise<string> }>

export interface GasClientOptions {
  url: string
  secret: string
  fetch?: FetchLike
  /** attempts for network errors / `busy` (default 3) */
  retries?: number
  sleep?: (ms: number) => Promise<void>
}

/** Replace every occurrence of the secret (and its URL-encoded form) in a string. */
export function redact(text: string, secret: string): string {
  if (!secret) return text
  let out = text.split(secret).join('[secret]')
  const enc = encodeURIComponent(secret)
  if (enc !== secret) out = out.split(enc).join('[secret]')
  return out
}

export function createGasClient(opts: GasClientOptions): GasClient {
  const { url, secret } = opts
  if (!/^https:\/\//.test(url)) throw new GasError('GAS_URL must be an https:// URL', 'bad_config')
  if (!secret) throw new GasError('GAS_SECRET is empty', 'bad_config')
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init))
  const retries = opts.retries ?? 3
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  return {
    async call(body) {
      let lastErr: GasError | undefined
      for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
        let res: { status: number; text(): Promise<string> }
        try {
          res = await doFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ secret, ...body }),
            redirect: 'follow',
          })
        } catch (e) {
          lastErr = new GasError(`network error: ${redact(String((e as Error)?.message ?? e), secret)}`, 'network')
          continue
        }
        const text = await res.text()
        let json: GasResponse
        try {
          json = JSON.parse(text) as GasResponse
        } catch {
          // an HTML error page from Google, not our JSON: never echo more than a short, scrubbed excerpt
          throw new GasError(`HTTP ${res.status}: response is not JSON (${redact(text.slice(0, 80).replace(/\s+/g, ' '), secret)})`, 'bad_response')
        }
        if (json.ok === false && json.error === 'busy') {
          lastErr = new GasError('busy', 'busy')
          continue
        }
        return json
      }
      throw lastErr ?? new GasError('no response', 'network')
    },
  }
}

/** Reads GAS_URL / GAS_SECRET from `env`. Throws GasError('bad_config') without revealing values. */
export function gasClientFromEnv(env: Record<string, string | undefined> = process.env, extra: Partial<GasClientOptions> = {}): GasClient {
  const url = env.GAS_URL?.trim()
  const secret = env.GAS_SECRET
  if (!url) throw new GasError('GAS_URL is not set (the Apps Script /exec URL)', 'bad_config')
  if (!secret) throw new GasError('GAS_SECRET is not set (the v1 shared secret)', 'bad_config')
  return createGasClient({ url, secret, ...extra })
}

/** `call`, but a response with ok:false throws (message from the server, scrubbed). */
export async function callOk(client: GasClient, body: Record<string, unknown>): Promise<GasResponse> {
  const res = await client.call(body)
  if (res.ok === false) throw new GasError(`${String(body.action)}: ${res.error ?? 'error'}${res.message ? ` (${res.message})` : ''}`, String(res.error ?? 'error'))
  return res
}
