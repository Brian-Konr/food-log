/** NOTE 解析：列表和明細都用同一函式。 */
export function parseNote(note) {
  const s = String(note ?? '')
  const kcalM = s.match(/(?:每份)?熱量\s*([0-9]+(?:\.[0-9]+)?)\s*大卡/)
  const gM = s.match(/每份規格\s*([0-9]+(?:\.[0-9]+)?)\s*公克/)
  const packM = s.match(/本包裝含\s*([0-9]+(?:\.[0-9]+)?)\s*份/)
  const kcal = kcalM ? Number(kcalM[1]) : null
  const servingG = gM ? Number(gM[1]) : null
  const perPack = packM ? Number(packM[1]) : 1
  const serving = servingG != null ? `1 份（${servingG} g）` : '1 份'
  return {
    kcal: kcal != null && Number.isFinite(kcal) ? kcal : null,
    servingG: servingG != null && Number.isFinite(servingG) ? servingG : null,
    perPack: Number.isFinite(perPack) && perPack > 0 ? perPack : 1,
    serving,
  }
}

export function flattenFamList(doc) {
  const list = doc && Array.isArray(doc.LIST) ? doc.LIST : []
  const out = []
  for (const cat of list) {
    const catName = cat && cat.CATEGORY_NAME != null ? String(cat.CATEGORY_NAME) : ''
    const items = cat && Array.isArray(cat.ITEM) ? cat.ITEM : []
    for (const it of items) {
      out.push({
        CMNO: String(it.CMNO ?? ''),
        PRODNAME: String(it.PRODNAME ?? ''),
        NOTE: String(it.NOTE ?? ''),
        CATEGORY_NAME: catName,
      })
    }
  }
  return out
}

export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}
