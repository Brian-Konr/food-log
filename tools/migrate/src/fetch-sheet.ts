// fetch-sheet: read the whole Sheet through the Apps Script API (read-only actions only: `read`, `history`).
//
//   GAS_URL=... GAS_SECRET=... npx -y pnpm@10 --filter @food-log/migrate fetch-sheet [--out <dir>]      ⛔ Brian (real data)
//
// `read` returns Items, Stores and Config in full but only the last 35 days of Logs and 90 days of Weights. `history` then pages
// Logs and Weights backwards (before = <day>, limit = 90, newest first) until hasMore is false. Output:
// tools/migrate/out/sheet-<UTC stamp>.json (gitignored; private data; written 0600).
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { addDays } from '@food-log/core'
import { fileStamp, isMain, parseArgs, die } from './cli-util.ts'
import { GasError, callOk, gasClientFromEnv } from './gas-client.ts'
import type { GasClient } from './gas-client.ts'
import { SNAPSHOT_FORMAT } from './types.ts'
import type { SheetRecord, SheetSnapshot } from './types.ts'

export const HISTORY_LIMIT = 90
/** safety net against a server that never reports hasMore:false */
const MAX_PAGES = 5000

export const DEFAULT_OUT_DIR = path.resolve(import.meta.dirname, '..', 'out')

const dayOf = (r: SheetRecord): string => String(r.day ?? '').slice(0, 10)
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

type HistoryTable = 'Logs' | 'Weights'
const keyOf = (table: HistoryTable, r: SheetRecord): string => {
  const id = r.id === undefined || r.id === null ? '' : String(r.id)
  if (id !== '') return `id:${id}`
  // old Weights rows have no id: identify an overlapping copy by its whole content (two different rows of one day stay two rows)
  return `row:${table}:${JSON.stringify([r.day, r.ts, r.kg, r.updated_at, r.deleted])}`
}

async function pageHistory(
  client: GasClient,
  table: HistoryTable,
  have: SheetRecord[],
  start: string,
  warnings: string[],
): Promise<{ records: SheetRecord[]; pages: number }> {
  const seen = new Set(have.map((r) => keyOf(table, r)))
  const out = [...have]
  let before = start
  let pages = 0
  for (;;) {
    const res = await callOk(client, { action: 'history', table, before, limit: HISTORY_LIMIT })
    const records = Array.isArray(res.records) ? (res.records as SheetRecord[]) : []
    pages++
    for (const r of records) {
      const k = keyOf(table, r)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(r)
    }
    if (res.hasMore !== true) break
    if (records.length === 0) {
      warnings.push(`${table}: history said hasMore with an empty page before ${before}; stopped`)
      break
    }
    if (pages >= MAX_PAGES) {
      warnings.push(`${table}: stopped after ${MAX_PAGES} history pages`)
      break
    }
    // The server cuts a page at `limit` rows inside a day. `before` is exclusive, so asking for "before <oldest day>" would
    // lose the rest of that day: step one day back over the oldest day (the overlap is removed by the id de-duplication).
    const oldest = records.map(dayOf).filter(isDay).sort()[0]
    if (!oldest) {
      warnings.push(`${table}: history page without valid days before ${before}; stopped`)
      break
    }
    let next = addDays(oldest, 1)
    if (next >= before) {
      // a whole page of one single day: cannot overlap, rows of that day beyond the page are unreachable through this API
      warnings.push(`${table}: more than ${HISTORY_LIMIT} rows on ${oldest}; the rows beyond the first ${HISTORY_LIMIT} of that day may be missing`)
      next = oldest
    }
    before = next
  }
  return { records: out, pages }
}

export async function fetchSheet(client: GasClient, opts: { now?: () => Date } = {}): Promise<SheetSnapshot> {
  const now = opts.now ?? (() => new Date())
  const read = await callOk(client, { action: 'read' })
  const arr = (v: unknown): SheetRecord[] => (Array.isArray(v) ? (v as SheetRecord[]) : [])
  const warnings: string[] = []
  const serverTime = String(read.serverTime ?? '')
  const serverDay = serverTime.slice(0, 10)
  const readLogs = arr(read.logs)
  const readWeights = arr(read.weights)

  const startFor = (rows: SheetRecord[]): string => {
    const days = rows.map(dayOf).filter(isDay).sort()
    if (days[0]) return addDays(days[0], 1) // overlap one day with `read`
    if (isDay(serverDay)) return addDays(serverDay, 1)
    throw new GasError('read returned no serverTime and no dated rows; cannot page history', 'bad_response')
  }

  const logs = await pageHistory(client, 'Logs', readLogs, startFor(readLogs), warnings)
  const weights = await pageHistory(client, 'Weights', readWeights, startFor(readWeights), warnings)

  const config: Record<string, string> = {}
  for (const [k, v] of Object.entries((read.config as Record<string, unknown> | undefined) ?? {})) config[k] = v === null || v === undefined ? '' : String(v)

  return {
    format: SNAPSHOT_FORMAT,
    fetchedAt: now().toISOString(),
    serverTime,
    apiVersion: Number(read.version ?? 0),
    config,
    items: arr(read.items),
    stores: arr(read.stores),
    logs: logs.records,
    weights: weights.records,
    warnings,
    pages: { Logs: logs.pages, Weights: weights.pages },
  }
}

export function writeSnapshot(snapshot: SheetSnapshot, outDir: string = DEFAULT_OUT_DIR, now: Date = new Date()): string {
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const file = path.join(outDir, `sheet-${fileStamp(now)}.json`)
  writeFileSync(file, JSON.stringify(snapshot, null, 1) + '\n', { mode: 0o600 })
  return file
}

async function main(): Promise<void> {
  const { opts } = parseArgs(process.argv.slice(2))
  let client: GasClient
  try {
    client = gasClientFromEnv()
  } catch (e) {
    return die((e as Error).message)
  }
  const snapshot = await fetchSheet(client)
  const file = writeSnapshot(snapshot, opts.out ? path.resolve(opts.out) : DEFAULT_OUT_DIR)
  console.log(
    `fetched: items ${snapshot.items.length}, stores ${snapshot.stores.length}, logs ${snapshot.logs.length} (${snapshot.pages.Logs} history pages), ` +
      `weights ${snapshot.weights.length} (${snapshot.pages.Weights} history pages), config keys ${Object.keys(snapshot.config).length}`,
  )
  for (const w of snapshot.warnings) console.warn(`warning: ${w}`)
  console.log(`wrote ${file}`)
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  })
}
