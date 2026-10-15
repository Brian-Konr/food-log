import { expect } from 'vitest'
import { MemoryServer } from '../src/testing'
import type { PushResult } from '../src/protocol/push'
import type { Row, Table } from '../src/schema/rows'

export function expectOk(res: PushResult): Record<string, unknown> {
  expect(res.ok, JSON.stringify(res)).toBe(true)
  return ((res as { result?: unknown }).result ?? {}) as Record<string, unknown>
}

export function expectErr(res: PushResult, code: string): void {
  expect(res.ok, JSON.stringify(res)).toBe(false)
  expect((res as { error: string }).error).toBe(code)
}

export function errorOf(res: PushResult): { error: string; message: string; details?: Record<string, unknown> } {
  expect(res.ok).toBe(false)
  return res as never
}

export const newServer = () => new MemoryServer()

export function live<T extends Table>(s: MemoryServer, t: T): Row<T>[] {
  return s.db.all(t).filter((r) => r.deleted_at === null)
}

export function row<T extends Table>(s: MemoryServer, t: T, id: string): Row<T> {
  const r = (s.db.tables[t] as Map<string, Row<T>>).get(id)
  expect(r, `${t} ${id} 不存在`).toBeDefined()
  return r as Row<T>
}
