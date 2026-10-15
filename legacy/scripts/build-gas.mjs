// 把 gas/Schema.gs、Setup.gs、Code.gs、Trends.gs 合併成單一檔 gas/FoodLog-AppsScript.gs，
// 方便在 Apps Script 編輯器裡「全選貼上」一個檔案。改過任何 .gs 後執行：npm run build:gas
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
export const GAS_PARTS = ['Schema.gs', 'Setup.gs', 'Code.gs', 'Trends.gs']
const gasDir = resolve(dirname(fileURLToPath(import.meta.url)), '../gas')
export function mergedGas() {
  return GAS_PARTS.map((f) => `// ===== ${f} =====\n` + readFileSync(resolve(gasDir, f), 'utf8').replace(/\n*$/, '\n')).join('\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(resolve(gasDir, 'FoodLog-AppsScript.gs'), mergedGas())
  console.log('[build-gas] 已產生 gas/FoodLog-AppsScript.gs')
}
