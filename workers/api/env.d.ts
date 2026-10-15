// Types for the test bindings (cloudflare:workers env) used by @cloudflare/vitest-plugin.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    EXPORTS: R2Bucket
    TEST_MIGRATIONS: import('@cloudflare/vitest-plugin').D1Migration[]
    BETTER_AUTH_SECRET: string
    ALLOWED_EMAILS: string
    MIN_CLIENT_VERSION?: string
    APP_ORIGIN?: string
  }
}

declare module '*?raw' {
  const text: string
  export default text
}
