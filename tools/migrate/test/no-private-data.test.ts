// Real food data must never reach the public repo (plan section 9, security test row): tools/migrate/out holds Sheet snapshots,
// generated SQL and D1 dumps. It is gitignored, and this test fails if anything under it is tracked or not ignored.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const repo = path.resolve(import.meta.dirname, '../../..')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

let inGit = true
try {
  git('rev-parse', '--git-dir')
} catch {
  inGit = false // e.g. a source tarball: nothing to check
}

describe.skipIf(!inGit)('tools/migrate/out stays out of git', () => {
  test('nothing under tools/migrate/out is tracked', () => {
    expect(git('ls-files', 'tools/migrate/out').trim()).toBe('')
    expect(git('ls-files', '--', 'tools/*/out/**').trim()).toBe('')
  })

  test('the paths the tools write to are ignored', () => {
    for (const f of ['tools/migrate/out/sheet-20261015-090000.json', 'tools/migrate/out/import-20261015-090000/import-001-of-001.sql', 'tools/migrate/out/d1-dump.json', 'tools/ops/out/drill.json']) {
      expect(() => git('check-ignore', '-q', f), f).not.toThrow()
    }
  })

  test('no tracked file looks like a Sheet snapshot or a generated import', () => {
    const tracked = git('ls-files').split('\n')
    expect(tracked.filter((f) => /(^|\/)sheet-\d{8}-\d{6}\.json$/.test(f) || /(^|\/)import-\d{3}-of-\d{3}\.sql$/.test(f) || /(^|\/)d1-dump\.(json|sql)$/.test(f))).toEqual([])
  })
})
