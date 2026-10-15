// Mutation 登錄表：`name@version` → { args（zod）, run }。
// 版本規則：每個名稱帶版本（logs.add@1）。要改參數格式就新增 @2，並保留前一版（舊 PWA 可能被 Service Worker 快取住，
// 還會送舊格式）；再前一版在 minClientVersion 之下的前端都更新後才移除。
import type { z } from 'zod'
import type { Ctx } from './actor'
import { MutationError } from './errors'
import {
  runConfigSet,
  runFavoritesSet,
  runItemsDelete,
  runItemsRestore,
  runItemsUpsert,
  runLogsAdd,
  runLogsDelete,
  runLogsRestore,
  runLogsUpdate,
  runStoresDelete,
  runStoresRestore,
  runStoresUpsert,
  runWeightsDelete,
  runWeightsRestore,
  runWeightsUpsert,
} from './mutators'
import { configSetArgs, favoritesSetArgs, idArgs, itemsUpsertArgs, logsAddArgs, logsUpdateArgs, storesUpsertArgs, weightsUpsertArgs } from './schema/args'
import type { Tx } from './tx'

export interface MutationDef<S extends z.ZodType = z.ZodType, R = unknown> {
  args: S
  run: (tx: Tx, ctx: Ctx, args: z.infer<S>) => Promise<R>
}

function def<S extends z.ZodType, R>(args: S, run: (tx: Tx, ctx: Ctx, a: z.infer<S>) => Promise<R>): MutationDef<S, R> {
  return { args, run }
}

export const mutations = {
  'logs.add@1': def(logsAddArgs, runLogsAdd),
  'logs.update@1': def(logsUpdateArgs, runLogsUpdate),
  'logs.delete@1': def(idArgs, runLogsDelete),
  'logs.restore@1': def(idArgs, runLogsRestore),
  'items.upsert@1': def(itemsUpsertArgs, runItemsUpsert),
  'items.delete@1': def(idArgs, runItemsDelete),
  'items.restore@1': def(idArgs, runItemsRestore),
  'stores.upsert@1': def(storesUpsertArgs, runStoresUpsert),
  'stores.delete@1': def(idArgs, runStoresDelete),
  'stores.restore@1': def(idArgs, runStoresRestore),
  'weights.upsert@1': def(weightsUpsertArgs, runWeightsUpsert),
  'weights.delete@1': def(idArgs, runWeightsDelete),
  'weights.restore@1': def(idArgs, runWeightsRestore),
  'favorites.set@1': def(favoritesSetArgs, runFavoritesSet),
  'config.set@1': def(configSetArgs, runConfigSet),
} as const

export type MutationName = keyof typeof mutations
export type MutationArgs<N extends MutationName> = z.input<(typeof mutations)[N]['args']>
export type MutationResult<N extends MutationName> = Awaited<ReturnType<(typeof mutations)[N]['run']>>

export const MUTATION_NAMES = Object.keys(mutations) as MutationName[]

/** /bot/v1/mutate 只允許的名稱（PRD §8）：其餘（刪除店家、設定、收藏…）Kyujin 沒有路徑可走。 */
export const BOT_MUTATION_NAMES = [
  'logs.add@1',
  'logs.update@1',
  'logs.delete@1',
  'logs.restore@1',
  'items.upsert@1',
  'stores.upsert@1',
  'weights.upsert@1',
] as const satisfies readonly MutationName[]

export function lookupMutation(name: string): MutationDef | undefined {
  return Object.prototype.hasOwnProperty.call(mutations, name) ? (mutations[name as MutationName] as unknown as MutationDef) : undefined
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')}：` : '') + i.message).join('；')
}

/**
 * 驗證參數後執行。找不到名稱或參數形狀不對都是 bad_record（業務錯誤，不重試）。
 * 前端（本機 Tx）和 Worker（D1 Tx）都走這個入口，所以兩邊的行為一致。
 */
export async function executeMutation(tx: Tx, ctx: Ctx, name: string, rawArgs: unknown): Promise<unknown> {
  const mutation = lookupMutation(name)
  if (!mutation) throw new MutationError('bad_record', `未知的 mutation：${name}`)
  const parsed = mutation.args.safeParse(rawArgs)
  if (!parsed.success) throw new MutationError('bad_record', `參數格式不對：${formatIssues(parsed.error)}`)
  return mutation.run(tx, ctx, parsed.data)
}
