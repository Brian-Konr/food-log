import type { CreatedBy } from './schema/enums'

/** 誰在執行 mutation：owner 是 Brian 的 App（passkey 登入），bot 是 Kyujin（API key）。 */
export type Actor = { kind: 'owner'; name: 'app' } | { kind: 'bot'; name: 'kyujin' }

export const OWNER: Actor = { kind: 'owner', name: 'app' }
export const KYUJIN: Actor = { kind: 'bot', name: 'kyujin' }

export type Ctx = {
  actor: Actor
  /** 目前時間（epoch ms）。注入進來，mutator 不直接讀系統時鐘，測試才能固定時間。 */
  now: () => number
}

/** 新建的品項、店家記錄的 created_by。 */
export function createdByOf(actor: Actor): CreatedBy {
  return actor.name === 'kyujin' ? 'kyujin' : 'app'
}
