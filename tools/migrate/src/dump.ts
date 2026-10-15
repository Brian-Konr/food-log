// D1 dumps: the input of verify and reverse-export (and of the restore drill's own checks).
//
// Three accepted shapes (parseDumpText detects them):
//   1. the normalised form   { meta: { version, epoch }, tables: { stores: [...], items: [...], ... } }
//   2. `wrangler d1 execute <db> --json --command "<dumpQueries()>"` output: an array of { results: [...] }, one per statement;
//      every row carries `_t` (the table name, 'meta' for the meta rows) because an empty result set has no other name
//   3. the SQL text of `wrangler d1 export <db> --remote --output dump.sql` (CREATE TABLE + INSERT INTO ... VALUES ...).
//      Unit-tested on hand-written dumps only (d1 export has no --local mode); shape 2 is the one run against a real local D1.
//
//   npx -y pnpm@10 --filter @food-log/migrate d1-dump-command [--db food-log] [--local]     prints the command (⛔ remote: Brian)
import { readFileSync } from 'node:fs'
import { TABLES } from '@food-log/core'
import type { Table } from '@food-log/core'
import { isMain, parseArgs, shQuote } from './cli-util.ts'
import type { D1Dump, DumpRow } from './types.ts'

export function emptyDump(): D1Dump {
  return { meta: { version: 0, epoch: '' }, tables: { stores: [], items: [], logs: [], weights: [], favorites: [], config: [] } }
}

/** The seven statements whose result sets make a dump (shape 2). No Better Auth / login / session table is read. */
export function dumpQueries(): string[] {
  return [`SELECT 'meta' AS _t, key, value FROM meta`, ...TABLES.map((t) => `SELECT '${t}' AS _t, * FROM ${t}`)]
}

export function dumpCommand(opts: { db: string; local: boolean }): string {
  const sql = dumpQueries().join('; ')
  return `npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute ${opts.db} ${opts.local ? '--local' : '--remote'} --json --command ${shQuote(sql)} > tools/migrate/out/d1-dump.json`
}

const isTable = (t: unknown): t is Table => typeof t === 'string' && (TABLES as readonly string[]).includes(t)

/** config.remind_meal_times is JSON text in D1 and an array in core's rows: dumps carry the array. */
function normalizeRow(table: Table, row: DumpRow): DumpRow {
  if (table === 'config' && typeof row.remind_meal_times === 'string') {
    try {
      return { ...row, remind_meal_times: JSON.parse(row.remind_meal_times) as unknown }
    } catch {
      return row
    }
  }
  return row
}

function setMeta(dump: D1Dump, key: unknown, value: unknown): void {
  if (key === 'version') dump.meta.version = Number(value)
  else if (key === 'epoch') dump.meta.epoch = String(value)
}

export function fromJson(j: unknown): D1Dump {
  const dump = emptyDump()
  if (j && typeof j === 'object' && !Array.isArray(j) && 'tables' in j) {
    const o = j as { meta?: { version?: unknown; epoch?: unknown }; tables: Record<string, unknown> }
    dump.meta.version = Number(o.meta?.version ?? 0)
    dump.meta.epoch = String(o.meta?.epoch ?? '')
    for (const t of TABLES) dump.tables[t] = (Array.isArray(o.tables[t]) ? (o.tables[t] as DumpRow[]) : []).map((r) => normalizeRow(t, r))
    return dump
  }
  const sets = Array.isArray(j) ? j : j && typeof j === 'object' && 'results' in j ? [j] : null
  if (!sets) throw new Error('unrecognised D1 dump JSON (expected {meta,tables} or the array printed by `wrangler d1 execute --json`)')
  for (const set of sets as { results?: DumpRow[]; success?: boolean }[]) {
    if (set.success === false) throw new Error('the dump contains a failed statement')
    for (const row of set.results ?? []) {
      const { _t, ...rest } = row
      if (_t === 'meta') setMeta(dump, rest.key, rest.value)
      else if (isTable(_t)) dump.tables[_t].push(normalizeRow(_t, rest))
      else throw new Error('dump row without a known _t (table) tag; run the queries from `d1-dump-command`')
    }
  }
  return dump
}

// ------------------------------------------------------------------ SQL text (wrangler d1 export)

/** Split SQL text into statements at top-level semicolons (quotes respected). */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (quote) {
      cur += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) cur += sql[++i]!
        else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const unquoteIdent = (s: string): string => s.trim().replace(/^["`[]|["`\]]$/g, '')

function topLevelSplit(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (quote) {
      cur += ch
      if (ch === quote) {
        if (s[i + 1] === quote) cur += s[++i]!
        else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      cur += ch
    } else if (ch === '(') {
      depth++
      cur += ch
    } else if (ch === ')') {
      depth--
      cur += ch
    } else if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function columnsOfCreate(stmt: string): string[] {
  const open = stmt.indexOf('(')
  const close = stmt.lastIndexOf(')')
  if (open < 0 || close < open) return []
  const cols: string[] = []
  for (const part of topLevelSplit(stmt.slice(open + 1, close))) {
    if (/^(constraint|primary\s+key|unique|check|foreign)\b/i.test(part)) continue
    cols.push(unquoteIdent(part.split(/\s+/)[0]!))
  }
  return cols
}

function sqlValue(token: string): unknown {
  const t = token.trim()
  if (/^null$/i.test(t)) return null
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t)
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replaceAll("''", "'")
  throw new Error(`unsupported SQL value in dump: ${t.slice(0, 40)}`)
}

export function fromSql(sql: string): D1Dump {
  const dump = emptyDump()
  const columns = new Map<string, string[]>()
  for (const stmt of splitStatements(sql)) {
    const create = /^create\s+table\s+(?:if\s+not\s+exists\s+)?(\S+?)\s*\(/i.exec(stmt)
    if (create) {
      columns.set(unquoteIdent(create[1]!), columnsOfCreate(stmt))
      continue
    }
    const ins = /^insert\s+into\s+(\S+?)\s*(\(([^)]*)\))?\s*values\s*([\s\S]*)$/i.exec(stmt)
    if (!ins) continue
    const name = unquoteIdent(ins[1]!)
    if (name !== 'meta' && !isTable(name)) continue
    const cols = ins[3] ? ins[3].split(',').map(unquoteIdent) : columns.get(name)
    if (!cols?.length) throw new Error(`INSERT INTO ${name} has no column list and no CREATE TABLE was seen before it`)
    // VALUES (...), (...)
    const tuples = topLevelSplit(ins[4]!)
    for (const tuple of tuples) {
      const inner = tuple.trim().replace(/^\(/, '').replace(/\)$/, '')
      const vals = topLevelSplit(inner).map(sqlValue)
      if (vals.length !== cols.length) throw new Error(`INSERT INTO ${name}: ${vals.length} values for ${cols.length} columns`)
      const row: DumpRow = Object.fromEntries(cols.map((c, i) => [c, vals[i]]))
      if (name === 'meta') setMeta(dump, row.key, row.value)
      else dump.tables[name as Table].push(normalizeRow(name as Table, row))
    }
  }
  return dump
}

export function parseDumpText(text: string): D1Dump {
  const t = text.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) return fromJson(JSON.parse(t))
  console.error('warning: SQL dump input is experimental; prefer the JSON dump from d1-dump-command')
  return fromSql(text)
}

export function readDump(file: string): D1Dump {
  return parseDumpText(readFileSync(file, 'utf8'))
}

if (isMain(import.meta.url)) {
  const { flags, opts } = parseArgs(process.argv.slice(2))
  if (flags.has('help') || flags.has('h')) {
    console.log(`usage: d1-dump-command [--db food-log] [--local]
Prints the command that dumps D1 as JSON (read-only SELECTs); run it, then pass the file to verify / reverse-export as --dump.
SQL dump input (wrangler d1 export) is EXPERIMENTAL: it is only tested on hand-written dumps and prints a warning when used.
Prefer the JSON dump from this command.`)
    process.exit(0)
  }
  console.log(`# ${flags.has('local') ? 'local D1' : '⛔ REMOTE D1: Brian only'} (read-only SELECTs)`)
  console.log(dumpCommand({ db: opts.db ?? 'food-log', local: flags.has('local') }))
  console.log('# or: wrangler d1 export <db> --remote --output tools/migrate/out/d1-dump.sql   (parsed best-effort; the JSON above is the verified path)')
}
