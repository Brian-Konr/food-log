// 跨 feature 的畫面狀態（哪個 Sheet 開著）。原本都在 App.tsx 的 useState，拆開之後放在這裡，
// 各 feature 只讀寫自己要的那幾個。資料不放這裡（見 data.tsx）。
import { createContext, useContext, useMemo, useRef, useState } from 'react'
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import type { LogRecord, MergedItem, SearchFilter } from '@/types'

export type StoreUi =
  | null
  | { page: 'picker' }
  | { page: 'quick' }
  | { page: 'store'; id: string }
  | { page: 'item'; storeId: string; itemId?: string }
  | { page: 'rename'; id: string }

export interface UiState {
  searchOpen: boolean
  setSearchOpen: Dispatch<SetStateAction<boolean>>
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  filter: SearchFilter
  setFilter: Dispatch<SetStateAction<SearchFilter>>
  portionItem: MergedItem | null
  setPortionItem: Dispatch<SetStateAction<MergedItem | null>>
  editLog: LogRecord | null
  setEditLog: Dispatch<SetStateAction<LogRecord | null>>
  itemForm: Partial<MergedItem> | null
  itemFormOpen: boolean
  openItemForm: (initial: Partial<MergedItem>) => void
  setItemFormOpen: Dispatch<SetStateAction<boolean>>
  storeUi: StoreUi
  setStoreUi: Dispatch<SetStateAction<StoreUi>>
  dupStore: { id: string; name: string } | null
  setDupStore: Dispatch<SetStateAction<{ id: string; name: string } | null>>
  /** 開店家 Sheet（同時關掉搜尋、清掉重複店名提示）。 */
  openStore: (id: string) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  searchBtnRef: RefObject<HTMLButtonElement | null>
}

const UiContext = createContext<UiState | null>(null)

export function useUi(): UiState {
  const u = useContext(UiContext)
  if (!u) throw new Error('useUi 必須在 <UiProvider> 底下使用')
  return u
}

export function UiProvider(props: { children?: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SearchFilter>('all')
  const [portionItem, setPortionItem] = useState<MergedItem | null>(null)
  const [editLog, setEditLog] = useState<LogRecord | null>(null)
  const [itemForm, setItemForm] = useState<Partial<MergedItem> | null>(null)
  const [itemFormOpen, setItemFormOpen] = useState(false)
  const [storeUi, setStoreUi] = useState<StoreUi>(null)
  const [dupStore, setDupStore] = useState<{ id: string; name: string } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)

  const value = useMemo<UiState>(
    () => ({
      searchOpen,
      setSearchOpen,
      query,
      setQuery,
      filter,
      setFilter,
      portionItem,
      setPortionItem,
      editLog,
      setEditLog,
      itemForm,
      itemFormOpen,
      openItemForm: (initial) => {
        setItemForm(initial)
        setItemFormOpen(true)
      },
      setItemFormOpen,
      storeUi,
      setStoreUi,
      dupStore,
      setDupStore,
      openStore: (id) => {
        setSearchOpen(false)
        setDupStore(null)
        setStoreUi({ page: 'store', id })
      },
      searchInputRef,
      searchBtnRef,
    }),
    [searchOpen, query, filter, portionItem, editLog, itemForm, itemFormOpen, storeUi, dupStore],
  )
  return <UiContext.Provider value={value}>{props.children}</UiContext.Provider>
}
