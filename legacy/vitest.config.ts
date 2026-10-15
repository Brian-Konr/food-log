// legacy/ 的 GAS 測試。部分測試會 import 前端的 '@/…'（對照 TS 與 .gs 的結果），
// 所以 '@' 指向 apps/food-log/src。
import path from 'node:path'

export default {
  resolve: { alias: { '@': path.resolve(import.meta.dirname, '../apps/food-log/src') } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
}
