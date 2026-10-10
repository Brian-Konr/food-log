import type { SheetSrc } from '@/types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function formatMacro(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1)
}

export function formatKg(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1)
}

/** 10月10日 星期六 */
export function formatLongDate(day: string): string {
  const [, m, d] = day.split('-').map(Number)
  const wd = weekdayIndex(day)
  return `${m}月${d}日 星期${WEEKDAYS[wd]}`
}

/** 10/9 — 取前 10 碼，月/日不補零。店家品項列第二行用。 */
export function formatMd(isoOrDay: string): string {
  const day = String(isoOrDay).slice(0, 10)
  const [, m, d] = day.split('-').map(Number)
  if (!m || !d) return ''
  return `${m}/${d}`
}

/** 10/10（六） */
export function formatShortDate(day: string): string {
  const [, m, d] = day.split('-').map(Number)
  return `${m}/${d}（${WEEKDAYS[weekdayIndex(day)]}）`
}

export function weekdayIndex(day: string): number {
  return new Date(Date.parse(day + 'T00:00:00Z')).getUTCDay()
}

export function formatHm(iso: string): string {
  return iso.slice(11, 16)
}

export function srcLabel(src: SheetSrc | 'familymart' | '711' | 'custom', custom = false): string {
  const map: Record<string, string> = { familymart: '全家', '711': '7-11', custom: '其他', '7-11': '7-11', 全家: '全家', 其他: '其他' }
  const base = map[src] ?? src
  return custom ? `${base} · 自建` : base
}

export function catalogSrcToSheet(src: 'familymart' | '711' | 'custom', customSrc?: SheetSrc): SheetSrc {
  if (src === 'familymart') return '全家'
  if (src === '711') return '7-11'
  return customSrc ?? '其他'
}

export function sheetSrcToCatalog(src: SheetSrc): 'familymart' | '711' | 'custom' {
  if (src === '全家') return 'familymart'
  if (src === '7-11') return '711'
  return 'custom'
}

export function formatQty(qty: number, grams: number | null): string {
  if (grams != null && grams > 0) return `${trimNum(grams)} g`
  if (qty === 0.5) return '½ 份'
  if (qty === 1) return '1 份'
  return `${trimNum(qty)} 份`
}

export function trimNum(n: number): string {
  return String(Math.round(n * 10) / 10)
}

export function formatLoggedToast(name: string, qty: number, grams: number | null): string {
  return `已記錄 ${name.trim() || '快速記錄'} ${formatQty(qty, grams)}`
}

export function withSpace(text: string): string {
  return text.replace(/([0-9])([\u4e00-\u9fff])/g, '$1 $2').replace(/([\u4e00-\u9fff])([0-9])/g, '$1 $2')
}

export const THEME_COLOR_DARK = '#0B0B0C'
export const THEME_COLOR_LIGHT = '#F5F5F3'
