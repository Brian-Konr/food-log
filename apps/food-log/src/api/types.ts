import type { ItemRecord, LogRecord, Snapshot, StoreRecord, WeightRecord } from '@/types'

export type WriteTable = 'Logs' | 'Weights' | 'Items' | 'Stores'

export type Op =
  | { action: 'read'; since?: string }
  | { action: 'append'; table: 'Logs'; record: LogRecord }
  | { action: 'update'; table: 'Logs'; id: string; patch: Record<string, unknown> }
  | { action: 'softDelete'; table: WriteTable; id: string }
  | { action: 'restore'; table: WriteTable; id: string }
  | { action: 'upsertItem'; record: ItemRecord }
  | { action: 'upsertStore'; record: StoreRecord }
  | { action: 'upsertWeight'; record: Pick<WeightRecord, 'day' | 'kg' | 'id' | 'ts'> }
  | { action: 'setConfig'; key: string; value: string }
  | { action: 'history'; table: 'Logs' | 'Weights'; before: string; limit?: number }
  | { action: 'summary'; day: string }
  | { action: 'trends'; weekStart: string }

export type Fail = { ok: false; error: string; message?: string }
export type Ok<T = object> = { ok: true } & T
export type Response = Fail | Ok<Record<string, unknown>> | Snapshot

export interface Adapter {
  kind: 'mock' | 'gas' | string
  call(op: Op & { client?: string }): Promise<Response>
}

export type WriteOp = Exclude<Op, { action: 'read' } | { action: 'history' } | { action: 'summary' } | { action: 'trends' }>
