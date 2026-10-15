import { test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

function isSecretLike(s: string): boolean {
  if (/AIza[0-9A-Za-z_-]{30,}/.test(s)) return true
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return true
  if (/SHARED_SECRET\s*[:=]\s*['"][^'"]+['"]/.test(s)) return true
  if (/\b[0-9a-f]{48,}\b/.test(s) && /secret|token|key/i.test(s)) return true
  return false
}

// 掃 apps/food-log/src 與 packages/*/src（core、sync-client、ui 都自動納入）；v2 的 workers/api/src、wrangler.jsonc 由 workers 的測試掃
const packagesDir = resolve(root, '../../packages')
const srcDirs = [
  join(root, 'src'),
  ...readdirSync(packagesDir)
    .map((n) => join(packagesDir, n, 'src'))
    .filter((d) => existsSync(d) && statSync(d).isDirectory()),
]

test('掃描範圍包含 packages/ui/src', () => {
  expect(srcDirs).toContain(join(packagesDir, 'ui', 'src'))
})

test('前端原始碼沒有寫死的密鑰', () => {
  const offenders = srcDirs
    .flatMap(walk)
    .filter((f) => /\.(ts|tsx|css|json)$/.test(f))
    .filter((f) => isSecretLike(readFileSync(f, 'utf8')))
  expect(offenders).toEqual([])
})

test('build 產物（若有）沒有密鑰', () => {
  const dist = join(root, 'dist')
  if (!existsSync(dist)) return
  const hit = walk(dist).filter((f) => /\.(js|html|webmanifest)$/.test(f)).filter((f) => {
    const s = readFileSync(f, 'utf8')
    return /AIza[0-9A-Za-z_-]{30,}/.test(s) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s) || /SHARED_SECRET\s*[:=]\s*['"][^'"]+['"]/.test(s)
  })
  expect(hit).toEqual([])
})

test('原始碼不再有 Apps Script／共享密鑰的殘留（v2 沒有後端連線設定）', () => {
  const offenders = srcDirs
    .flatMap(walk)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => {
      const s = readFileSync(f, 'utf8')
      // 清理舊鍵的 local-storage.ts 是唯一可以出現這些字串的地方
      if (f.endsWith('lib/local-storage.ts')) return false
      return /script\.google\.com|foodlog\.(gasUrl|secret|mock)|GAS_TIMEOUT_MS|createGasAdapter/.test(s)
    })
  expect(offenders).toEqual([])
})

test('API 路徑不被 Service Worker 的 navigation fallback 吃掉', () => {
  const cfg = readFileSync(join(root, 'vite.config.ts'), 'utf8')
  expect(cfg).toContain('navigateFallbackDenylist: [/^\\/(sync|bot|api|telemetry)\\//]')
  expect(cfg).toMatch(/base: '\/'/)
  expect(cfg).toMatch(/registerType: 'prompt'/)
})
