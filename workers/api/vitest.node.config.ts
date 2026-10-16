// Node-side tests (the deploy scripts run in Node, not in the Workers runtime the main config uses).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test-node/**/*.test.ts'], environment: 'node' },
})
