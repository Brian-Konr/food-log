// 失敗的 mutation（sync-client 的 failed 表）第一次出現時，用 v1 的文案跳一個 toast：
//   店家 → 「<店名>沒有存到」、刪除紀錄 → 「刪除失敗，已還原 <品名>」、收藏 → 「收藏沒有存到」。
// 永久錯誤（bad_record、forbidden、duplicate_name…）只給「捨棄」；其他給「重試」。
// 跳過的 mutationId 記在 localStorage，重開不會再跳。沒有 read_only：v2 沒有唯讀開關。
import { useEffect, useRef } from 'react'
import { useAppData } from '@/app/data'
import { useActions } from '@/app/services'
import { useUi } from '@/app/ui'
import { failureToast, isPermanent } from '@/data/failures'
import type { NameLookup } from '@/data/failures'
import { KEYS, readLocal, writeLocal } from '@/lib/local-storage'
import { useToast } from './ToastProvider'

const MAX_KEPT = 200

function loadSeen(): Set<number> {
  try {
    const raw = JSON.parse(readLocal(KEYS.failedNotified) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((n): n is number => typeof n === 'number') : [])
  } catch {
    return new Set()
  }
}

export function FailedToasts() {
  const { failed, logs, items, stores } = useAppData()
  const actions = useActions()
  const { showToast } = useToast()
  const ui = useUi()
  const seen = useRef<Set<number> | null>(null)

  useEffect(() => {
    if (seen.current === null) seen.current = loadSeen()
    const known = seen.current
    let changed = false
    const nameOf: NameLookup = (table, id) => {
      if (table === 'logs') return logs.find((l) => l.id === id)?.name
      if (table === 'items') return items.find((i) => i.id === id)?.name
      return stores.find((s) => s.id === id)?.name
    }
    for (const f of failed) {
      if (known.has(f.mutationId)) continue
      known.add(f.mutationId)
      changed = true
      if (f.name === 'stores.upsert@1') {
        const id = (f.args as { id?: string } | null)?.id
        const cur = ui.storeUi
        if (cur && id && ((cur.page === 'store' && cur.id === id) || (cur.page === 'rename' && cur.id === id) || (cur.page === 'item' && cur.storeId === id))) {
          ui.setStoreUi(null)
        }
      }
      const t = failureToast(f, nameOf)
      if (!t) continue
      const permanent = isPermanent(f)
      showToast(
        t.message,
        permanent ? () => void actions.discardFailed(f) : () => void actions.retryFailed(f.mutationId),
        { actionLabel: permanent ? '捨棄' : '重試' },
      )
    }
    if (changed) writeLocal(KEYS.failedNotified, JSON.stringify([...known].slice(-MAX_KEPT)))
    // 只在失敗清單變動時看；其他資料變動不該重新跳
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed])

  return null
}
