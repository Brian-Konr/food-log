import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Adapter } from '@/api/types'
import { createGasAdapter } from '@/api/gas'
import { createMockAdapter } from '@/api/mock'
import { uuid } from '@/api'
import type { CatalogItem, ItemRecord, LogRecord, MergedItem, SearchFilter, Tab, Toast } from '@/types'
import { useFoodLog } from '@/hooks/useFoodLog'
import { taipeiIso, taipeiToday } from '@/lib/day'
import { formatLoggedToast, THEME_COLOR_DARK, THEME_COLOR_LIGHT } from '@/lib/format'
import { fromGrams, fromQty, itemMacros, parseTargets, remaining, sumLogs } from '@/lib/nutrition'
import { buildIndex, frequentChips } from '@/data/search'
import { TabBar } from '@/components/TabBar'
import { SearchDock } from '@/components/SearchDock'
import { SearchSheet } from '@/components/SearchSheet'
import { PortionSheet } from '@/components/PortionSheet'
import { WeightSheet } from '@/components/WeightSheet'
import { EditLogSheet } from '@/components/EditLogSheet'
import { ItemForm } from '@/components/ItemForm'
import { UndoToast } from '@/components/UndoToast'
import { NetworkBanner } from '@/components/NetworkBanner'
import { TodayScreen } from '@/screens/TodayScreen'
import { TrendsScreen } from '@/screens/TrendsScreen'
import { ItemsScreen } from '@/screens/ItemsScreen'
import { SettingsScreen } from '@/screens/SettingsScreen'
import { SetupScreen } from '@/screens/SetupScreen'

export type AppProps = {
  initialHash?: string
  adapter?: Adapter
  catalogItems?: CatalogItem[]
  storage?: Storage
  now?: () => number
}

function parseTab(hash: string): { tab: Tab; weight: boolean } {
  const h = hash.replace(/^#/, '')
  if (h === 'trends') return { tab: 'trends', weight: false }
  if (h === 'items') return { tab: 'items', weight: false }
  if (h === 'settings') return { tab: 'settings', weight: false }
  if (h === 'weight') return { tab: 'today', weight: true }
  return { tab: 'today', weight: false }
}

export default function App(props: AppProps = {}) {
  const storage = props.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  // 穩定的參考：每次 render 都換新函式會讓 adapter／api 每次重建，造成無限重繪
  const now = useMemo(() => props.now ?? (() => Date.now()), [props.now])
  const get = (k: string) => storage?.getItem(k) ?? null
  const set = (k: string, v: string) => storage?.setItem(k, v)

  const [theme, setTheme] = useState<'dark' | 'light'>(() => (get('foodlog.theme') === 'light' ? 'light' : 'dark'))
  const [gasUrl, setGasUrl] = useState(() => get('foodlog.gasUrl') ?? '')
  const [secret, setSecret] = useState(() => get('foodlog.secret') ?? '')
  const [mockMode, setMockMode] = useState(() => get('foodlog.mock') === '1' || !!props.adapter)
  const setupError = null as string | null
  const [hash, setHash] = useState(() => props.initialHash ?? (typeof location === 'undefined' ? '' : location.hash))
  const { tab, weight: weightFromHash } = parseTab(hash)
  const [weightOpen, setWeightOpen] = useState(weightFromHash)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SearchFilter>('all')
  const [portionItem, setPortionItem] = useState<MergedItem | null>(null)
  const [editLog, setEditLog] = useState<LogRecord | null>(null)
  const [itemForm, setItemForm] = useState<Partial<MergedItem> | null>(null)
  const [itemFormOpen, setItemFormOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [today, setToday] = useState(() => taipeiToday(now()))
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)

  const adapter = useMemo(() => {
    if (props.adapter) return props.adapter
    if (mockMode) return createMockAdapter({ storage, now })
    if (gasUrl && secret) return createGasAdapter({ url: gasUrl, secret })
    return null
  }, [props.adapter, mockMode, gasUrl, secret, storage, now])

  const needSetup = !adapter
  const fl = useFoodLog({ adapter, storage, now, catalog: props.catalogItems })
  const data = fl.data
  const items = fl.items
  const logs = data?.logs ?? []
  const weights = data?.weights ?? []
  const config = data?.config ?? {}
  const targets = parseTargets(config)
  const todayLogs = logs.filter((l) => l.day === today)
  const eaten = sumLogs(todayLogs)
  const remain = remaining(targets, eaten)
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const indexed = useMemo(() => buildIndex(items), [items])
  const chips = useMemo(() => frequentChips(items, logs, today), [items, logs, today])

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light')
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'light' ? THEME_COLOR_LIGHT : THEME_COLOR_DARK)
  }, [theme])

  useEffect(() => {
    const onHash = () => {
      const h = location.hash
      setHash(h)
      const p = parseTab(h)
      if (p.weight) setWeightOpen(true)
    }
    addEventListener('hashchange', onHash)
    if (weightFromHash) setWeightOpen(true)
    return () => removeEventListener('hashchange', onHash)
  }, [weightFromHash])

  useEffect(() => {
    const tick = () => setToday(taipeiToday(now()))
    const t = setInterval(tick, 60_000)
    const vis = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', vis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis) }
  }, [now])

  useEffect(() => {
    const idle = 'requestIdleCallback' in window ? window.requestIdleCallback.bind(window) : (cb: () => void) => setTimeout(cb, 0)
    const id = idle(() => { void indexed })
    return () => { if (typeof id === 'number') clearTimeout(id) }
  }, [indexed])

  function go(t: Tab) {
    const h = '#' + t
    setHash(h)
    if (typeof location !== 'undefined') history.replaceState(null, '', location.pathname + location.search + h)
  }

  function openWeight() {
    setWeightOpen(true)
    if (typeof location !== 'undefined') location.assign(location.pathname + location.search + '#weight')
    setHash('#weight')
  }
  function closeWeight(v: boolean) {
    setWeightOpen(v)
    if (!v && (hash === '#weight' || parseTab(hash).weight)) {
      const next = location.pathname + location.search + '#today'
      history.replaceState(null, '', next)
      setHash('#today')
    }
  }

  function showToast(message: string, undo?: () => unknown) {
    setToast({ id: uuid(), message, undo })
  }

  const onRecord = useCallback((args: { item: MergedItem; qty: number; grams: number | null; fill?: { protein: number; fat: number; carb: number } }) => {
    const api = fl.api
    if (!api) return
    const item = args.item
    const filled = args.fill ? { ...item, protein: args.fill.protein, fat: args.fill.fat, carb: args.fill.carb, needsFill: false } : item
    const per = itemMacros(filled)
    if (!per) return
    const macros = args.grams != null && item.servingG ? fromGrams(per, args.grams, item.servingG).macros : fromQty(per, args.qty)
    const qty = args.grams != null && item.servingG ? args.grams / item.servingG : args.qty
    if (args.fill) {
      const rec: ItemRecord = item.src === 'custom'
        ? {
            id: item.id, ts: taipeiIso(now()), deleted: false, updated_at: '', kind: '自建', base_id: '', src: item.sheetSrc,
            name: item.name, serving: item.serving, serving_g: item.servingG, kcal: item.kcal,
            protein: args.fill.protein, fat: args.fill.fat, carb: args.fill.carb, fav: item.fav, created_by: item.createdBy ?? 'app',
          }
        : {
            id: 'ov:' + item.id, ts: taipeiIso(now()), deleted: false, updated_at: '', kind: '補填', base_id: item.id, src: item.sheetSrc,
            name: item.name, serving: item.serving, serving_g: item.servingG, kcal: item.kcal,
            protein: args.fill.protein, fat: args.fill.fat, carb: args.fill.carb, fav: false, created_by: 'app',
          }
      void api.upsertItem(rec)
    }
    const log: LogRecord = {
      id: uuid(), ts: taipeiIso(now()), deleted: false, updated_at: '', day: taipeiToday(now()),
      item_id: item.id, name: item.name, src: item.sheetSrc, qty, grams: args.grams, ...macros,
    }
    void api.appendLog(log)
    setPortionItem(null)
    setSearchOpen(false)
    showToast(formatLoggedToast(item.name, qty, args.grams), () => api.remove('Logs', log.id))
  }, [fl.api, now])

  async function setFav(item: MergedItem, fav: boolean) {
    const api = fl.api
    if (!api) return
    if (item.src === 'custom') {
      const rec: ItemRecord = {
        id: item.id, ts: taipeiIso(now()), deleted: false, updated_at: '', kind: '自建', base_id: '', src: item.sheetSrc,
        name: item.name, serving: item.serving, serving_g: item.servingG, kcal: item.kcal,
        protein: item.protein ?? 0, fat: item.fat ?? 0, carb: item.carb ?? 0, fav, created_by: item.createdBy ?? 'app',
      }
      await api.upsertItem(rec)
    } else {
      // 讀最新的 fav_ids（復原時閉包裡的 config 可能是舊的）
      const latest = api.peek()?.config.fav_ids ?? config.fav_ids ?? ''
      const ids = new Set(latest.split(',').map((s) => s.trim()).filter(Boolean))
      if (fav) ids.add(item.id)
      else ids.delete(item.id)
      await api.setConfig('fav_ids', [...ids].join(','))
    }
  }
  const toggleFav = (item: MergedItem) => setFav(item, !item.fav)

  if (needSetup) {
    return (
      <SetupScreen
        error={setupError}
        onStart={(url, s) => {
          if (!url || !s) return
          set('foodlog.gasUrl', url)
          set('foodlog.secret', s)
          setGasUrl(url)
          setSecret(s)
          setMockMode(false)
        }}
        onMock={() => { set('foodlog.mock', '1'); setMockMode(true) }}
      />
    )
  }

  return (
    <div className="min-h-dvh bg-background pt-[var(--safe-top)] text-foreground">
      <NetworkBanner network={fl.network} mock={mockMode && !props.adapter ? true : mockMode} />
      {tab === 'today' && (
        <TodayScreen
          today={today}
          remain={remain}
          eaten={eaten}
          targets={targets}
          logs={todayLogs}
          itemsById={itemsById}
          onWeight={openWeight}
          onOpenLog={setEditLog}
        />
      )}
      {tab === 'trends' && (
        <TrendsScreen today={today} logs={logs} weights={weights} config={config} onWeight={openWeight} />
      )}
      {tab === 'items' && (
        <ItemsScreen
          items={items}
          onUnfav={(i) => {
            void setFav(i, false)
            showToast(`已取消收藏 ${i.name}`, () => setFav(i, true))
          }}
          onOpenPortion={(i) => setPortionItem(i)}
          onEdit={(i) => { setItemForm(i); setItemFormOpen(true) }}
          onDelete={(i) => {
            void fl.api?.remove('Items', i.id)
            showToast(`已刪除 ${i.name}`, () => fl.api?.restore('Items', i.id))
          }}
          onCreate={() => { setItemForm({}); setItemFormOpen(true) }}
        />
      )}
      {tab === 'settings' && (
        <SettingsScreen
          config={config}
          theme={theme}
          onTheme={(t) => { setTheme(t); set('foodlog.theme', t) }}
          onSetConfig={(k, v) => void fl.api?.setConfig(k, v)}
          onToast={(m) => showToast(m)}
          onEditConnection={() => setSetupOpen(true)}
        />
      )}
      {tab === 'today' && (
        <SearchDock
          chips={chips}
          searchRef={searchBtnRef}
          onChip={(i) => setPortionItem(i)}
          onSearch={() => {
            setSearchOpen(true)
            searchInputRef.current?.focus()
          }}
        />
      )}
      <TabBar tab={tab} onChange={go} />
      <SearchSheet
        open={searchOpen}
        onOpenChange={setSearchOpen}
        items={items}
        indexed={indexed}
        logs={logs}
        today={today}
        remain={remain}
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
        onSelect={(i) => { setSearchOpen(false); setPortionItem(i) }}
        onManual={(name) => { setItemForm({ name }); setItemFormOpen(true) }}
        inputRef={searchInputRef}
      />
      <PortionSheet
        open={!!portionItem}
        onOpenChange={(o) => { if (!o) setPortionItem(null) }}
        item={portionItem}
        logs={logs}
        remain={remain}
        targets={targets}
        onToggleFav={(i) => void toggleFav(i)}
        onRecord={onRecord}
      />
      <WeightSheet
        open={weightOpen}
        onOpenChange={closeWeight}
        today={today}
        weights={weights}
        onSave={({ day, kg, overwrite, prevKg }) => {
          const id = uuid()
          const ts = day === today ? taipeiIso(now()) : `${day}T12:00:00+08:00`
          void fl.api?.upsertWeight({ day, kg, id, ts }).catch(() => {})
          setWeightOpen(false)
          closeWeight(false)
          showToast(`已記錄 ${kg.toFixed(1)} kg（${day.slice(5, 7).replace(/^0/, '')}/${day.slice(8, 10).replace(/^0/, '')}）`, () => {
            if (overwrite && prevKg != null) return fl.api?.upsertWeight({ day, kg: prevKg, id: uuid(), ts })
            return fl.api?.remove('Weights', id)
          })
        }}
      />
      <EditLogSheet
        open={!!editLog}
        onOpenChange={(o) => { if (!o) setEditLog(null) }}
        log={editLog}
        item={editLog ? itemsById.get(editLog.item_id) ?? null : null}
        today={today}
        onSave={(log, patch) => {
          const old = { ...log }
          void fl.api?.updateLog(log.id, patch)
          setEditLog(null)
          showToast('已更新紀錄', () => fl.api?.updateLog(log.id, { qty: old.qty, grams: old.grams, kcal: old.kcal, protein: old.protein, fat: old.fat, carb: old.carb, ts: old.ts, day: old.day }))
        }}
        onDelete={(log) => {
          void fl.api?.remove('Logs', log.id)
          setEditLog(null)
          showToast(`已刪除 ${log.name}`, () => fl.api?.restore('Logs', log.id))
        }}
      />
      <ItemForm
        open={itemFormOpen}
        onOpenChange={setItemFormOpen}
        initial={itemForm ?? undefined}
        onSave={(v) => {
          const id = itemForm?.id?.startsWith('u:') ? itemForm.id : 'u:' + uuid()
          void fl.api?.upsertItem({
            id, ts: taipeiIso(now()), deleted: false, updated_at: '', kind: '自建', base_id: '', src: v.src,
            name: v.name, serving: v.serving, serving_g: v.servingG, kcal: v.kcal, protein: v.protein, fat: v.fat, carb: v.carb,
            fav: itemForm?.fav ?? false, created_by: itemForm?.createdBy ?? 'app',
          })
          setItemFormOpen(false)
        }}
      />
      {setupOpen && (
        <SetupScreen
          error={setupError}
          onStart={(url, s) => {
            set('foodlog.gasUrl', url); set('foodlog.secret', s); setGasUrl(url); setSecret(s); setMockMode(false); setSetupOpen(false)
          }}
          onMock={() => { set('foodlog.mock', '1'); setMockMode(true); setSetupOpen(false) }}
        />
      )}
      <UndoToast toast={toast} onGone={() => setToast(null)} dock={tab === 'today'} />
    </div>
  )
}
