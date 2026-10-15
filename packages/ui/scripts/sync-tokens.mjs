// 把設計 token 的來源 docs/design/tokens.css 複製到 packages/ui/styles/（app 的 dev/build 前自動執行）。
// packages/ui/styles/tokens.css 也有進 repo，所以就算沒有 docs/design/ 也能建置。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../../docs/design/tokens.css')
const dst = resolve(here, '../styles/tokens.css')
if (!existsSync(src)) {
  console.warn('[sync-tokens] 找不到 docs/design/tokens.css，沿用 packages/ui/styles/ 裡現有的那份')
  process.exit(0)
}
mkdirSync(dirname(dst), { recursive: true })
if (existsSync(dst) && readFileSync(src, 'utf8') === readFileSync(dst, 'utf8')) process.exit(0)
copyFileSync(src, dst)
console.log('[sync-tokens] 已從 docs/design/ 同步 tokens.css')
