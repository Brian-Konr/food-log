// 時間工具：一律以台北時間（+08:00）產生 ISO 字串，不受手機時區影響。
export { taipeiIso as tpeIso, taipeiDay as tpeDate, addDays } from '@/lib/day'
import { taipeiIso } from '@/lib/day'

export function tpeNow(ms: number = Date.now()): string {
  return taipeiIso(ms)
}
