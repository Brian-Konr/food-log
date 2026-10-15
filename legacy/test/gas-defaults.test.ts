import { expect, test } from 'vitest'
import { loadGas } from './gas-fakes'
import { DEFAULT_CONFIG } from '@/data/defaults'

test('defaults.ts 與 Schema 的 DEFAULT_CONFIG 鍵和值一致，且沒有 theme', () => {
  const { g } = loadGas()
  const gasCfg = Object.fromEntries((g.DEFAULT_CONFIG as [string, string][]).map(([k, v]) => [k, v]))
  expect(gasCfg).toEqual(DEFAULT_CONFIG)
  expect('theme' in gasCfg).toBe(false)
  expect('theme' in DEFAULT_CONFIG).toBe(false)
})
