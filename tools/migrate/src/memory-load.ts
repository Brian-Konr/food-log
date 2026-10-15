// Load a transform result into core's MemoryServer exactly as emit-sql would load it into D1 (same chunks, same version stamps),
// and read a MemoryServer back as a D1Dump. For tests and local rehearsals; nothing here talks to a real service.
import { TABLES } from '@food-log/core'
import type { Table } from '@food-log/core'
import type { MemoryServer } from '@food-log/core/testing'
import { chunkRows } from './emit-sql.ts'
import type { TransformResult } from './transform.ts'
import type { D1Dump, DumpRow } from './types.ts'

/** Same effect as `emitSql(result, { reset: true })` on an empty D1. Returns the version after the import (= V_cut). */
export function loadIntoMemory(server: MemoryServer, result: TransformResult, epoch = 'm-test'): number {
  const db = server.dbOf(result.userId)
  for (const t of TABLES) db.tables[t].clear()
  db.epoch = epoch
  for (const chunk of chunkRows(result)) {
    db.version = db.version + 1
    for (const row of chunk.rows) db.seed(chunk.table, { ...(row as object), version: db.version } as never)
  }
  return db.version
}

export function memoryDump(server: MemoryServer, userId: string = server.defaultUserId): D1Dump {
  const db = server.dbOf(userId)
  const tables = {} as Record<Table, DumpRow[]>
  for (const t of TABLES) tables[t] = db.all(t).map((r) => structuredClone(r) as unknown as DumpRow)
  return { meta: { version: db.version, epoch: db.epoch }, tables }
}

