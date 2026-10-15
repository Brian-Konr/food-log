import type { Env } from './env.ts'

export type BotContext = { keyId: string; actor: 'kyujin' }

/** Hono generics shared by every route module. */
export type AppEnv = {
  Bindings: Env
  Variables: { userId: string; bot: BotContext }
}

export const NO_ORIGIN = { error: 'APP_ORIGIN not configured' } as const
