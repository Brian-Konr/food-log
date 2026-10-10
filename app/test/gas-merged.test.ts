import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { mergedGas } from '../scripts/build-gas.mjs'

test('gas/FoodLog-AppsScript.gs 跟四個來源檔一致（改了 .gs 請跑 npm run build:gas）', () => {
  expect(readFileSync(new URL('../gas/FoodLog-AppsScript.gs', import.meta.url), 'utf8')).toBe(mergedGas())
})
