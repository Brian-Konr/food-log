// 店名正規化。必須和 legacy/gas/Code.gs 的 normName_ 與前端 data/search.ts 的 norm 相同：
// NFKC → 小寫 → 移除空白與常見標點。
const PUNCT = /[\s\-·・（）()【】[\]、，。．/／]/g

export function normName(s: string): string {
  return String(s).normalize('NFKC').toLowerCase().replace(PUNCT, '')
}

export const norm = normName
