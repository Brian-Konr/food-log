/** 業務錯誤碼（和 docs/kyujin-api.md 一致）。伺服器記錄這些錯誤並推進 lastMutationId，不重試。 */
export type MutationErrorCode = 'bad_record' | 'forbidden' | 'duplicate_name' | 'not_found'

export class MutationError extends Error {
  readonly code: MutationErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: MutationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'MutationError'
    this.code = code
    this.details = details
  }
}

export function isMutationError(e: unknown): e is MutationError {
  return e instanceof MutationError
}

export const badRecord = (message: string, details?: Record<string, unknown>) => new MutationError('bad_record', message, details)
export const forbidden = (message: string, details?: Record<string, unknown>) => new MutationError('forbidden', message, details)
export const notFound = (message: string, details?: Record<string, unknown>) => new MutationError('not_found', message, details)
export const duplicateName = (message: string, details: { existingId: string; existingName: string }) =>
  new MutationError('duplicate_name', message, details)

/** 暫時性錯誤（CAS 重試用盡、儲存層失敗）。push 整批中止回 503，前端退避重試。不是業務錯誤。 */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TransientError'
  }
}
