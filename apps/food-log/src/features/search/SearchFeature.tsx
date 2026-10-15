// 今天頁底部的搜尋列（常吃膠囊）與搜尋 Sheet。
import { useEffect } from 'react'
import { useAppData } from '@/app/data'
import { useUi } from '@/app/ui'
import { SearchDock } from '@/components/SearchDock'
import { SearchSheet } from '@/components/SearchSheet'

export function SearchDockFeature() {
  const d = useAppData()
  const ui = useUi()
  return (
    <SearchDock
      chips={d.dockChips}
      searchRef={ui.searchBtnRef}
      onStore={ui.openStore}
      onItem={(i) => ui.setPortionItem(i)}
      onSearch={() => {
        ui.setSearchOpen(true)
        ui.searchInputRef.current?.focus()
      }}
    />
  )
}

export function SearchSheetFeature() {
  const d = useAppData()
  const ui = useUi()

  // 搜尋索引在閒置時先建好（indexed 本身由 data.tsx 的 useMemo 算）
  useEffect(() => {
    const idle = 'requestIdleCallback' in window ? window.requestIdleCallback.bind(window) : (cb: () => void) => setTimeout(cb, 0)
    const id = idle(() => {
      void d.indexed
    })
    return () => {
      if (typeof id === 'number') clearTimeout(id)
    }
  }, [d.indexed])

  return (
    <SearchSheet
      open={ui.searchOpen}
      onOpenChange={ui.setSearchOpen}
      items={d.items}
      stores={d.stores}
      indexed={d.indexed}
      logs={d.logs}
      today={d.today}
      remainLine={d.remainLine}
      query={ui.query}
      onQuery={ui.setQuery}
      filter={ui.filter}
      onFilter={ui.setFilter}
      onSelect={(i) => {
        ui.setSearchOpen(false)
        ui.setPortionItem(i)
      }}
      onManual={(name) => ui.openItemForm({ name })}
      onQuick={() => {
        ui.setSearchOpen(false)
        ui.setStoreUi({ page: 'quick' })
      }}
      onOpenStore={ui.openStore}
      onAddStore={() => {
        ui.setSearchOpen(false)
        ui.setDupStore(null)
        ui.setStoreUi({ page: 'picker' })
      }}
      inputRef={ui.searchInputRef}
    />
  )
}
