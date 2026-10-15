// 份量換算、合計、剩餘：與 packages/core 同一份（App 和 Kyujin 的 summary 才會算出一樣的數字）。
// legacy/test 仍從這裡引用，所以保留這個入口。
export {
  roundKcal,
  roundMacro,
  parseNonNeg,
  needsFill,
  scaleMacros,
  fromQty,
  fromGrams,
  canUseGrams,
  lastPortion,
  sumLogs,
  remaining,
  formatRemain,
  parseTargets,
  itemMacros,
  rescaleLog,
} from '@food-log/core'
