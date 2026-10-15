// 趨勢純函式：與 packages/core 同一份（與 legacy/gas/Trends.gs 同一套算法；黃金案例在 test/fixtures/trends-cases.json）。
// legacy/test 仍從這裡引用，所以保留這個入口。
export {
  isIncomplete,
  totalsByDay,
  weekSummary,
  kcalBarSlots,
  latestKgByDay,
  avg7,
  weightSeries,
  trendsView,
  parseWeightRange,
  WEIGHT_RANGE_DAYS,
  weightYTicks,
} from '@food-log/core'
export type { WeightRange } from '@food-log/core'
