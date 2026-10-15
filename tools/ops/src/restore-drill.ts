#!/usr/bin/env node
// restore-drill --dir <local export folder> [--db <sqlite path>] [--migrations <dir>] [--json]
//
// Restores a daily export (downloaded from R2 by Brian, see docs/runbooks/v2-cutover.md) into a FRESH local SQLite database
// built from workers/api/migrations, then compares row counts (live / deleted) with `_ok.json` and the per-day kcal / protein /
// fat / carb sums of the logs across three copies (part files, logs.csv, restored DB). It never talks to R2 or D1.
//
// Exit code: 0 ok, 1 mismatch, 2 refused (no _ok.json, consistent:false, bad arguments, DB file already exists).
import { parseArgs } from 'node:util'
import { DrillRefusal, formatReport, runDrill } from './drill-lib.ts'

const USAGE = 'usage: restore-drill --dir <local export folder> [--db <new sqlite file>] [--migrations <dir>] [--json]'

function main(): number {
  let values: { dir?: string; db?: string; migrations?: string; json?: boolean; help?: boolean }
  try {
    values = parseArgs({
      options: { dir: { type: 'string' }, db: { type: 'string' }, migrations: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
    }).values
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`)
    return 2
  }
  if (values.help || !values.dir) {
    console.error(USAGE)
    return values.help ? 0 : 2
  }
  const t0 = Date.now()
  try {
    const report = runDrill({ dir: values.dir, dbPath: values.db, migrationsDir: values.migrations })
    console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report))
    return report.ok ? 0 : 1
  } catch (e) {
    const refusal = e instanceof DrillRefusal
    console.error(refusal ? (e as Error).message : `restore-drill failed: ${(e as Error).stack ?? String(e)}`)
    console.error(`elapsed: ${((Date.now() - t0) / 1000).toFixed(2)} s`)
    return refusal ? 2 : 1
  }
}

process.exitCode = main()
