import { z } from 'zod'

/** 來源店家。沿用 v1 的中文值，匯出的檔案人看得懂（PRD §6.1）。 */
export const SRC_VALUES = ['7-11', '全家', '其他'] as const
export const srcSchema = z.enum(SRC_VALUES)
export type Src = z.infer<typeof srcSchema>

/** 品項種類：自建（`u:`）或補填官方品項缺的營養素（`ov:`）。 */
export const KIND_VALUES = ['自建', '補填'] as const
export const kindSchema = z.enum(KIND_VALUES)
export type Kind = z.infer<typeof kindSchema>

/** 紀錄的寫入來源：App 一般記錄、快速記錄、Kyujin。 */
export const LOG_SOURCE_VALUES = ['app', 'quick', 'kyujin'] as const
export const logSourceSchema = z.enum(LOG_SOURCE_VALUES)
export type LogSource = z.infer<typeof logSourceSchema>

/** 品項、店家由誰建立（權限規則用）。 */
export const CREATED_BY_VALUES = ['app', 'kyujin'] as const
export const createdBySchema = z.enum(CREATED_BY_VALUES)
export type CreatedBy = z.infer<typeof createdBySchema>

export function isSrc(v: unknown): v is Src {
  return typeof v === 'string' && (SRC_VALUES as readonly string[]).includes(v)
}
