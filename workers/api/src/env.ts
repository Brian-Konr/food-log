export interface Env {
  DB: D1Database
  /** R2 bucket for the daily export (exports/YYYY-MM-DD/…). */
  EXPORTS: R2Bucket
  /** Static assets (apps/food-log/dist). Only bound by `deploy:with-app`; absent in the default API-only deploy and in tests. */
  ASSETS?: Fetcher
  /** secret: `wrangler secret put BETTER_AUTH_SECRET` */
  BETTER_AUTH_SECRET: string
  /** secret: comma separated allow list. `wrangler secret put ALLOWED_EMAILS`. Never in git. */
  ALLOWED_EMAILS: string
  /** var: reject clients older than this with 409 client_too_old */
  MIN_CLIENT_VERSION?: string
  /**
   * var, REQUIRED outside local dev: the public origin, e.g. https://food-log.<subdomain>.workers.dev
   * (passkey origin; the RP ID is its hostname). Only requests to localhost / 127.0.0.1 / [::1] may leave it
   * unset (origin derived from the request); anywhere else /api/auth/*, /sync/* and /bot/* answer 500
   * 'APP_ORIGIN not configured' (fail closed).
   */
  APP_ORIGIN?: string
  /** var: rows one export cron invocation may process before it leaves the rest to the next resume tick (default 3000) */
  EXPORT_ROW_BUDGET?: string
  /**
   * Workers Rate Limiting binding (wrangler.jsonc `ratelimits`) for POST /telemetry/error, keyed on the client IP.
   * Optional: when it is absent (tests, older config) the Worker falls back to a per-isolate token bucket.
   */
  TELEMETRY_LIMITER?: RateLimit
}

export function allowedEmails(env: Pick<Env, 'ALLOWED_EMAILS'>): Set<string> {
  return new Set(
    (env.ALLOWED_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** MIN_CLIENT_VERSION as an integer (>= 1). */
export function minClientVersion(env: Pick<Env, 'MIN_CLIENT_VERSION'>): number {
  const n = Number(env.MIN_CLIENT_VERSION ?? '1')
  return Number.isInteger(n) && n >= 1 ? n : 1
}
