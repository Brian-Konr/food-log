// 單日摘要。語意同 legacy/gas/Code.gs 的 summary_：
// 當天（day 欄位前 10 碼相等）未刪除的紀錄合計、目標、剩餘（可以是負數）。
// App 的「今天還剩多少」和 Kyujin 的 /bot/v1/summary 都用這一份，數字才會一致。
import { parseTargets, remaining, sumLogs } from './nutrition'
import type { Macros, Targets, TargetsConfig } from './nutrition'
import type { LogLike } from './trends'

export type DaySummary = {
  day: string
  count: number
  totals: Macros
  targets: Targets
  remaining: Macros
}

export function summarizeDay(logs: Iterable<LogLike>, config: TargetsConfig, day: string): DaySummary {
  const dayLogs: LogLike[] = []
  for (const l of logs) if (String(l.day || '').slice(0, 10) === day) dayLogs.push(l)
  const t = sumLogs(dayLogs)
  const totals: Macros = { kcal: t.kcal, protein: t.protein, fat: t.fat, carb: t.carb }
  const targets = parseTargets(config)
  return { day, count: t.count, totals, targets, remaining: remaining(targets, totals) }
}
