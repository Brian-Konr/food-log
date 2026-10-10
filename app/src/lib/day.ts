const OFFSET = 8 * 3600 * 1000
const DAY_MS = 86400000

export function taipeiDay(date: Date): string {
  return new Date(date.getTime() + OFFSET).toISOString().slice(0, 10)
}

export function taipeiIso(ms: number): string {
  return new Date(ms + OFFSET).toISOString().slice(0, 19) + '+08:00'
}

export function taipeiToday(now: Date | number = Date.now()): string {
  const ms = typeof now === 'number' ? now : now.getTime()
  return taipeiDay(new Date(ms))
}

/** YYYY-MM-DD 加減天：用 UTC 午夜再加整天，不受機器時區影響。 */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(day + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10)
}

/** 該日所在週的週一。星期日減 6 天，星期一減 0 天。 */
export function weekStart(day: string): string {
  const d = new Date(Date.parse(day + 'T00:00:00Z'))
  const wd = d.getUTCDay()
  const back = wd === 0 ? 6 : wd - 1
  return addDays(day, -back)
}

export function weekEnd(monday: string): string {
  return addDays(monday, 6)
}
