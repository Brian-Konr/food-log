import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Adapter } from '@/api/types'
import { createGasAdapter } from '@/api/gas'
import { createMockAdapter } from '@/api/mock'
import { uuid } from '@/api'
import { NetworkError } from '@/api/errors'
import type { CatalogItem, ItemRecord, LogRecord, MergedItem, SearchFilter, StoreRecord, Tab, Toast } from '@/types'
import { useFoodLog } from '@/hooks/useFoodLog'
import { taipeiIso, taipeiToday } from '@/lib/day'
import { parseWeightRange, type WeightRange } from '@/lib/trends'
import { formatLoggedToast, THEME_COLOR_DARK, THEME_COLOR_LIGHT } from '@/lib/format'
import { formatRemain, fromGrams, fromQty, itemMacros, parseTargets, remaining, sumLogs } from '@/lib/nutrition'
import { buildIndex, frequentChips, norm } from '@/data/search'
import type { Kv } from '@/data/kv'
import { TabBar } from '@/components/TabBar'
import { SearchDock, type DockChip } from '@/components/SearchDock'
import { SearchSheet } from '@/components/SearchSheet'
import { PortionSheet } from '@/components/PortionSheet'
import { WeightSheet } from '@/components/WeightSheet'
import { EditLogSheet } from '@/components/EditLogSheet'
import { ItemForm } from '@/components/ItemForm'
import { UndoToast } from '@/components/UndoToast'
import { NetworkBanner } from '@/components/NetworkBanner'
import { StorePicker } from '@/components/StorePicker'
import { StoreSheet } from '@/components/StoreSheet'
import { StoreItemForm } from '@/components/StoreItemForm'
import { StoreForm } from '@/components/StoreForm'
import { SyncBadge } from '@/components/SyncBadge'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { TodayScreen } from '@/screens/TodayScreen'
import { TrendsScreen } from '@/screens/TrendsScreen'
import { ItemsScreen } from '@/screens/ItemsScreen'
import { SettingsScreen } from '@/screens/SettingsScreen'
import { SetupScreen } from '@/screens/SetupScreen'

type StoreUi =
  | null
  | { page: 'picker' }
  | { page: 'quick' }
  | { page: 'store'; id: string }
  | { page: 'item'; storeId: string; itemId?: string }
  | { page: 'rename'; id: string }

export type AppProps = {
  initialHash?: string
  adapter?: Adapter
  catalogItems?: CatalogItem[]
  storage?: Storage
  now?: () => number
  checkConnection?: (url: string, secret: string) => Promise<string | null>
  kv?: Kv
}

function parseTab(hash: string): { tab: Tab; weight: boolean } {
  const h = hash.replace(/^#/, '')
  if (h === 'trends') return { tab: 'trends', weight: false }
  if (h === 'items') return { tab: 'items', weight: false }
  if (h === 'settings') return { tab: 'settings', weight: false }
  if (h === 'weight') return { tab: 'today', weight: true }
  return { tab: 'today', weight: false }
}

function toItemRecord(item: MergedItem, nowIso: string, patch: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: item.id,
    ts: nowIso,
    deleted: false,
    updated_at: '',
    kind: item.src === 'custom' ? '自建' : '補填',
    base_id: item.src === 'custom' ? '' : item.id.replace(/^ov:/, ''),
    src: item.sheetSrc,
    name: item.name,
    serving: item.serving,
    serving_g: item.servingG,
    kcal: item.kcal,
    protein: item.protein ?? 0,
    fat: item.fat ?? 0,
    carb: item.carb ?? 0,
    fav: item.fav,
    created_by: item.createdBy ?? 'app',
    store: item.storeId || '',
    ...patch,
  }
}

export default function App(props: AppProps = {}) {
  const storage = props.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
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
  const [storeUi, setStoreUi] = useState<StoreUi>(null)
  const [dupStore, setDupStore] = useState<{ id: string; name: string } | null>(null)
  const [nowTick, setNowTick] = useState(() => now())
  const [weightRange, setWeightRange] = useState<WeightRange>(() => parseWeightRange(get('foodlog.weightRange')))
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)
  const seenFailed = useRef(new Set<string>())

  const adapter = useMemo(() => {
    if (props.adapter) return props.adapter
    if (mockMode) {
      const latencyMs = Number(get('foodlog.mockDelayMs') || '0') || 0
      const inner = createMockAdapter({ storage, now, latencyMs })
      const orig = inner.call.bind(inner)
      inner.call = async (op) => {
        if (op.action === 'read') {
          const n = Number(get('foodlog.mockFailReads') || '0') || 0
          if (n > 0) {
            set('foodlog.mockFailReads', String(n - 1))
            throw new NetworkError('目前連不上', 'fetch')
          }
        } else {
          const n = Number(get('foodlog.mockFailWrites') || '0') || 0
          if (n > 0) {
            set('foodlog.mockFailWrites', String(n - 1))
            return { ok: false, error: 'bad_record', message: '模擬寫入失敗' }
          }
        }
        return orig(op)
      }
      return inner
    }
    if (gasUrl && secret) return createGasAdapter({ url: gasUrl, secret })
    return null
    // get/set close over storage; mock flags are read at adapter creation / each call
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.adapter, mockMode, gasUrl, secret, storage, now])

  const needSetup = !adapter
  const fl = useFoodLog({ adapter, storage, now, catalog: props.catalogItems, kv: props.kv })
  const data = fl.data
  const items = fl.items
  const stores = fl.stores
  const logs = data?.logs ?? []
  const weights = data?.weights ?? []
  const config = data?.config ?? {}
  const todayKnown = (fl.loadState === 'fresh' || (fl.loadState === 'cached-syncing' && !fl.staleToday)) && !fl.staleToday
  const targets = todayKnown || fl.loadState === 'cached-syncing' || fl.loadState === 'error-cached' || fl.loadState === 'fresh'
    ? parseTargets(config)
    : { kcal: 0, protein: 0, fat: 0, carb: 0 }
  const todayLogs = logs.filter((l) => l.day === today)
  const eaten = sumLogs(todayLogs)
  const remain = remaining(targets, eaten)
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const indexed = useMemo(() => buildIndex(items), [items])
  const dockChips: DockChip[] = useMemo(() => {
    const eatenStores = stores
      .filter((s) => !s.deleted && s.last_eaten_at)
      .sort((a, b) => b.last_eaten_at.localeCompare(a.last_eaten_at))
      .slice(0, 3)
    const itemLimit = 6 - eatenStores.length
    const itemList = frequentChips(items.filter((i) => !i.storeId), logs, today, itemLimit)
    return [
      ...eatenStores.map((s) => ({ kind: 'store' as const, id: s.id, name: s.name })),
      ...itemList.map((item) => ({ kind: 'item' as const, item })),
    ]
  }, [stores, items, logs, today])

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

  useEffect(() => {
    if (!fl.queuedCount) return
    const t = setInterval(() => setNowTick(now()), 1000)
    return () => clearInterval(t)
  }, [fl.queuedCount, now])

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

  function showToast(message: string, undo?: () => unknown, extra?: { durationMs?: number; actionLabel?: string }) {
    setToast({ id: uuid(), message, undo, durationMs: extra?.durationMs, actionLabel: extra?.actionLabel })
  }

  function dropOrReverse(table: 'Logs' | 'Items' | 'Stores' | 'Weights', id: string, kind: 'append' | 'softDelete' | 'upsertItem' | 'upsertStore' | 'upsertWeight') {
    const api = fl.api
    if (!api) return
    const q = api.outbox().find((x) => {
      if (kind === 'append' && x.action === 'append') return x.record.id === id
      if (kind === 'upsertItem' && x.action === 'upsertItem') return x.record.id === id
      if (kind === 'upsertStore' && x.action === 'upsertStore') return x.record.id === id
      if (kind === 'upsertWeight' && x.action === 'upsertWeight') return x.record.id === id
      if (kind === 'softDelete' && x.action === 'softDelete') return x.id === id
      return false
    })
    if (q) return api.dropQueued(q.qid)
    if (kind === 'append' || kind === 'upsertItem' || kind === 'upsertStore' || kind === 'upsertWeight') return api.remove(table, id)
    return api.restore(table, id)
  }

  function failedQidForRecord(id: string): string | undefined {
    return fl.failed.find((f) => {
      if (f.op.action === 'append' && f.op.record.id === id) return true
      if (f.op.action === 'upsertItem' && f.op.record.id === id) return true
      if (f.op.action === 'upsertStore' && f.op.record.id === id) return true
      if (f.op.action === 'upsertWeight' && f.op.record.id === id) return true
      if ((f.op.action === 'update' || f.op.action === 'softDelete' || f.op.action === 'restore') && f.op.id === id) return true
      return false
    })?.qid
  }

  useEffect(() => {
    const api = fl.api
    if (!api) return
    for (const f of fl.failed) {
      if (seenFailed.current.has(f.qid)) continue
      seenFailed.current.add(f.qid)
      const op = f.op
      if (op.action === 'upsertStore') {
        const name = op.record.name
        const sid = op.record.id
        if (storeUi?.page === 'store' && storeUi.id === sid) setStoreUi(null)
        if (storeUi?.page === 'rename' && storeUi.id === sid) setStoreUi(null)
        if (storeUi?.page === 'item' && storeUi.storeId === sid) setStoreUi(null)
        showToast(`${name}沒有存到・重試`, () => api.retryFailed(f.qid), { actionLabel: '重試' })
      } else if (op.action === 'softDelete' && op.table === 'Logs') {
        const name = logs.find((l) => l.id === op.id)?.name || '紀錄'
        showToast(`刪除失敗，已還原 ${name}・重試`, () => api.retryFailed(f.qid), { actionLabel: '重試' })
      } else if (f.label === 'fav' || (op.action === 'setConfig' && op.key === 'fav_ids') || (op.action === 'upsertItem' && f.label === 'fav')) {
        showToast('收藏沒有存到・重試', () => api.retryFailed(f.qid), { actionLabel: '重試' })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fl.failed])

  const onRecord = useCallback((args: {
    item: MergedItem
    qty: number
    grams: number | null
    fill?: { protein: number; fat: number; carb: number }
    nutrition?: { kcal: number; protein: number; fat: number; carb: number }
  }) => {
    const api = fl.api
    if (!api) return
    const item = args.item
    const filled = args.nutrition
      ? { ...item, ...args.nutrition, needsFill: false }
      : args.fill
        ? { ...item, protein: args.fill.protein, fat: args.fill.fat, carb: args.fill.carb, needsFill: false }
        : item
    const per = itemMacros(filled)
    if (!per) return
    const macros = args.grams != null && item.servingG ? fromGrams(per, args.grams, item.servingG).macros : fromQty(per, args.qty)
    const qty = args.grams != null && item.servingG ? args.grams / item.servingG : args.qty
    const groupId = (args.fill || args.nutrition) ? uuid() : undefined
    const ts = taipeiIso(now())
    if (args.fill) {
      const rec: ItemRecord = item.src === 'custom'
        ? toItemRecord(item, ts, { protein: args.fill.protein, fat: args.fill.fat, carb: args.fill.carb })
        : {
            id: 'ov:' + item.id, ts, deleted: false, updated_at: '', kind: '補填', base_id: item.id, src: item.sheetSrc,
            name: item.name, serving: item.serving, serving_g: item.servingG, kcal: item.kcal,
            protein: args.fill.protein, fat: args.fill.fat, carb: args.fill.carb, fav: false, created_by: 'app', store: '',
          }
      void api.upsertItem(rec, { groupId })
    }
    if (args.nutrition && item.src === 'custom') {
      void api.upsertItem(toItemRecord(filled, ts, {
        kcal: args.nutrition.kcal, protein: args.nutrition.protein, fat: args.nutrition.fat, carb: args.nutrition.carb,
      }), { groupId })
    }
    const log: LogRecord = {
      id: uuid(), ts, deleted: false, updated_at: '', day: taipeiToday(now()),
      item_id: item.id, name: item.name, src: item.sheetSrc, qty, grams: args.grams, ...macros,
      source: 'app', store: item.storeId || '',
    }
    void api.appendLog(log, { groupId })
    setPortionItem(null)
    setSearchOpen(false)
    setStoreUi(null)
    showToast(formatLoggedToast(item.name, qty, args.grams), () => dropOrReverse('Logs', log.id, 'append'))
  }, [fl.api, now])

  async function setFav(item: MergedItem, fav: boolean) {
    const api = fl.api
    if (!api) return
    if (item.src === 'custom') {
      await api.upsertItem(toItemRecord(item, taipeiIso(now()), { fav }), { label: 'fav' })
    } else {
      const latest = api.peek()?.config.fav_ids ?? config.fav_ids ?? ''
      const ids = new Set(latest.split(',').map((s) => s.trim()).filter(Boolean))
      if (fav) ids.add(item.id)
      else ids.delete(item.id)
      await api.setConfig('fav_ids', [...ids].join(','), { label: 'fav' })
    }
  }
  const toggleFav = (item: MergedItem) => setFav(item, !item.fav)

  function openStore(id: string) {
    setSearchOpen(false)
    setDupStore(null)
    setStoreUi({ page: 'store', id })
  }

  function findDup(name: string, exceptId?: string): StoreRecord | undefined {
    const n = norm(name)
    return stores.find((s) => !s.deleted && s.id !== exceptId && norm(s.name) === n)
  }

  function createStore(name: string) {
    const api = fl.api
    if (!api) return
    const d = findDup(name)
    if (d) { setDupStore({ id: d.id, name: d.name }); return }
    setDupStore(null)
    const id = 's:' + uuid()
    const rec: StoreRecord = {
      id, ts: taipeiIso(now()), deleted: false, updated_at: '', name, last_eaten_at: '', created_by: 'app',
    }
    void api.upsertStore(rec)
    setStoreUi({ page: 'store', id })
  }

  function renameStore(id: string, name: string) {
    const api = fl.api
    if (!api) return
    const d = findDup(name, id)
    if (d) { setDupStore({ id: d.id, name: d.name }); return }
    setDupStore(null)
    const cur = stores.find((s) => s.id === id)
    if (!cur) return
    void api.upsertStore({ ...cur, name })
    setStoreUi({ page: 'store', id })
  }

  function saveStoreItem(v: { name: string; kcal: number; protein: number; fat: number; carb: number }, thenPortion: boolean) {
    const api = fl.api
    if (!api || storeUi?.page !== 'item') return
    const storeId = storeUi.storeId
    const id = storeUi.itemId?.startsWith('u:') ? storeUi.itemId : 'u:' + uuid()
    const rec: ItemRecord = {
      id, ts: taipeiIso(now()), deleted: false, updated_at: '', kind: '自建', base_id: '', src: '其他',
      name: v.name, serving: '1 份', serving_g: null, kcal: v.kcal, protein: v.protein, fat: v.fat, carb: v.carb,
      fav: false, created_by: 'app', store: storeId,
    }
    void api.upsertItem(rec)
    if (storeUi.itemId && (v.kcal !== itemsById.get(id)?.kcal || v.protein !== itemsById.get(id)?.protein)) {
      showToast(`已更新 ${v.name}，之後記錄會用新的營養素`)
    }
    if (thenPortion) {
      const storeName = stores.find((s) => s.id === storeId)?.name ?? ''
      setPortionItem({
        id, src: 'custom', name: v.name, cat: '', serving: '1 份', servingG: null, perPack: 1,
        kcal: v.kcal, protein: v.protein, fat: v.fat, carb: v.carb, fav: false, createdBy: 'app',
        override: false, needsFill: false, sheetSrc: '其他', storeId, storeName,
      })
      setStoreUi(null)
    } else {
      setStoreUi({ page: 'store', id: storeId })
    }
  }

  function saveQuick(v: { name: string; kcal: number; protein: number; fat: number; carb: number }) {
    const api = fl.api
    if (!api) return
    const log: LogRecord = {
      id: uuid(), ts: taipeiIso(now()), deleted: false, updated_at: '', day: taipeiToday(now()),
      item_id: '', name: v.name.trim(), src: '其他', qty: 1, grams: null,
      kcal: v.kcal, protein: v.protein, fat: v.fat, carb: v.carb, source: 'quick', store: '',
    }
    void api.appendLog(log)
    setStoreUi(null)
    setSearchOpen(false)
    showToast(formatLoggedToast(v.name.trim() || '快速記錄', 1, null), () => dropOrReverse('Logs', log.id, 'append'))
  }

  const remainLine = todayKnown
    ? `${formatRemain(remain.kcal, 'kcal')} · ${formatRemain(remain.protein, 'g')} 蛋白質`
    : '同步後顯示剩餘'

  const failedLogCount = todayLogs.filter((l) => !l.deleted && l.__write === 'failed').length
  const weightFail = fl.failed.map((f) => {
    if (f.op.action !== 'upsertWeight') return null
    return { kg: f.op.record.kg, onRetry: () => void fl.api?.retryFailed(f.qid) }
  }).find(Boolean) ?? null

  const failedKeys: Record<string, { onRetry: () => void; onDiscard: () => void }> = {}
  for (const f of fl.failed) {
    if (f.op.action === 'setConfig') {
      failedKeys[f.op.key] = {
        onRetry: () => { void fl.api?.retryFailed(f.qid) },
        onDiscard: () => { void fl.api?.discardFailed(f.qid) },
      }
    }
  }

  const onlineForKyujin = (typeof navigator === 'undefined' || navigator.onLine) && fl.network !== 'offline' && (fl.api?.status().online !== false)

  if (needSetup) {
    return (
      <SetupScreen
        error={setupError}
        check={props.checkConnection}
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

  const badge = (
    <SyncBadge
      loadState={fl.loadState}
      pending={fl.queuedCount}
      online={fl.network !== 'offline'}
      onRetry={() => { void fl.refresh() }}
      retrying={fl.retrying}
    />
  )

  return (
    <div className="relative h-full min-h-dvh min-h-full bg-background pt-[var(--safe-top)] text-foreground">
      <NetworkBanner network={fl.network} mock={mockMode && !props.adapter ? true : mockMode} />
      {tab === 'today' && (
        <TodayScreen
          today={today}
          remain={remain}
          eaten={eaten}
          targets={targets}
          logs={todayLogs}
          itemsById={itemsById}
          stores={stores}
          onWeight={openWeight}
          onOpenLog={setEditLog}
          loadState={fl.loadState}
          staleToday={fl.staleToday}
          errorReason={fl.errorReason}
          errorCodeLine={fl.errorCodeLine}
          retrying={fl.retrying}
          onRetry={() => { void fl.refresh() }}
          pending={fl.queuedCount}
          online={fl.network !== 'offline'}
          now={nowTick}
          failedLogCount={failedLogCount}
          hasToast={!!toast}
        />
      )}
      {tab === 'trends' && (
        <TrendsScreen
          today={today}
          logs={logs}
          weights={weights}
          config={config}
          onWeight={openWeight}
          loadState={fl.loadState}
          pending={fl.queuedCount}
          online={fl.network !== 'offline'}
          onRetry={() => { void fl.refresh() }}
          retrying={fl.retrying}
          staleToday={fl.staleToday}
          weightFail={weightFail}
          range={weightRange}
          onRange={(r) => { setWeightRange(r); set('foodlog.weightRange', r) }}
          weightDays={data?.weightDays}
        />
      )}
      {tab === 'items' && (
        <ItemsScreen
          items={items}
          stores={stores}
          onUnfav={(i) => {
            void setFav(i, false)
            showToast(`已取消收藏 ${i.name}`, () => setFav(i, true))
          }}
          onOpenPortion={(i) => setPortionItem(i)}
          onEdit={(i) => { setItemForm(i); setItemFormOpen(true) }}
          onDelete={(i) => {
            void fl.api?.remove('Items', i.id)
            showToast(`已刪除 ${i.name}`, () => dropOrReverse('Items', i.id, 'softDelete'))
          }}
          onCreate={() => { setItemForm({}); setItemFormOpen(true) }}
          onOpenStore={openStore}
          loadState={fl.loadState}
          pending={fl.queuedCount}
          online={fl.network !== 'offline'}
          onRetry={() => { void fl.refresh() }}
          retrying={fl.retrying}
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
          badge={badge}
          failedKeys={failedKeys}
        />
      )}
      {tab === 'today' && (
        <SearchDock
          chips={dockChips}
          searchRef={searchBtnRef}
          onStore={openStore}
          onItem={(i) => setPortionItem(i)}
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
        stores={stores}
        indexed={indexed}
        logs={logs}
        today={today}
        remainLine={remainLine}
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
        onSelect={(i) => { setSearchOpen(false); setPortionItem(i) }}
        onManual={(name) => { setItemForm({ name }); setItemFormOpen(true) }}
        onQuick={() => { setSearchOpen(false); setStoreUi({ page: 'quick' }) }}
        onOpenStore={openStore}
        onAddStore={() => { setSearchOpen(false); setDupStore(null); setStoreUi({ page: 'picker' }) }}
        inputRef={searchInputRef}
      />
      <StorePicker
        open={storeUi?.page === 'picker'}
        onOpenChange={(v) => { if (!v) setStoreUi(null) }}
        stores={stores}
        remainLine={remainLine}
        onQuick={() => setStoreUi({ page: 'quick' })}
        onOpenStore={openStore}
        onCreate={createStore}
        duplicateName={dupStore?.name}
        duplicateId={dupStore?.id}
      />
      <StoreSheet
        open={storeUi?.page === 'store'}
        store={storeUi?.page === 'store' ? stores.find((s) => s.id === storeUi.id) ?? null : null}
        items={storeUi?.page === 'store' ? items.filter((i) => i.storeId === storeUi.id) : []}
        logs={logs}
        remainLine={remainLine}
        onOpenItem={(item) => { setPortionItem(item) }}
        onAddItem={() => { if (storeUi?.page === 'store') setStoreUi({ page: 'item', storeId: storeUi.id }) }}
        onRename={() => { if (storeUi?.page === 'store') { setDupStore(null); setStoreUi({ page: 'rename', id: storeUi.id }) } }}
        onDelete={() => {
          if (storeUi?.page !== 'store') return
          const s = stores.find((x) => x.id === storeUi.id)
          if (!s) return
          void fl.api?.remove('Stores', s.id)
          setStoreUi(null)
          showToast(`已刪除 ${s.name}`, () => dropOrReverse('Stores', s.id, 'softDelete'))
        }}
        onClose={() => setStoreUi(null)}
      />
      <StoreItemForm
        open={storeUi?.page === 'item' || storeUi?.page === 'quick'}
        mode={storeUi?.page === 'quick' ? 'quick' : 'store'}
        initial={storeUi?.page === 'item' && storeUi.itemId ? itemsById.get(storeUi.itemId) : undefined}
        online={onlineForKyujin}
        onBack={() => {
          if (storeUi?.page === 'item') setStoreUi({ page: 'store', id: storeUi.storeId })
          else setStoreUi(null)
        }}
        onCloseAll={() => { setStoreUi(null); setSearchOpen(false) }}
        onRecord={(v) => {
          if (storeUi?.page === 'quick') saveQuick(v)
          else saveStoreItem(v, true)
        }}
        onSaveOnly={storeUi?.page === 'item' ? (v) => saveStoreItem(v, false) : undefined}
      />
      {storeUi?.page === 'rename' && (
        <Sheet open onOpenChange={(o) => { if (!o) setStoreUi({ page: 'store', id: storeUi.id }) }}>
          <SheetContent className="top-[calc(var(--safe-top)+8px)] bottom-0 h-auto">
            <SheetTitle className="px-4">改名</SheetTitle>
            <StoreForm
              initialName={stores.find((s) => s.id === storeUi.id)?.name}
              submitLabel="儲存"
              duplicateName={dupStore?.name}
              onSubmit={(name) => renameStore(storeUi.id, name)}
              onOpenExisting={dupStore ? () => openStore(dupStore.id) : undefined}
            />
          </SheetContent>
        </Sheet>
      )}
      <PortionSheet
        open={!!portionItem}
        onOpenChange={(o) => { if (!o) setPortionItem(null) }}
        item={portionItem}
        logs={logs}
        remain={remain}
        targets={targets}
        todayKnown={todayKnown}
        onToggleFav={(i) => void toggleFav(i)}
        onRecord={onRecord}
        onSaveNutrition={(item, n) => {
          void fl.api?.upsertItem(toItemRecord(item, taipeiIso(now()), n))
          showToast(`已更新 ${item.name}，之後記錄會用新的營養素`)
        }}
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
            return dropOrReverse('Weights', id, 'upsertWeight')
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
          showToast('已更新紀錄', () => fl.api?.updateLog(log.id, { qty: old.qty, grams: old.grams, kcal: old.kcal, protein: old.protein, fat: old.fat, carb: old.carb, ts: old.ts, day: old.day, name: old.name }))
        }}
        onDelete={(log) => {
          void fl.api?.remove('Logs', log.id)
          setEditLog(null)
          showToast(`已刪除 ${log.name || '快速記錄'}`, () => dropOrReverse('Logs', log.id, 'softDelete'))
        }}
        onRetry={(log) => {
          const qid = failedQidForRecord(log.id)
          if (qid) void fl.api?.retryFailed(qid)
        }}
        onDiscard={(log) => {
          const qid = failedQidForRecord(log.id)
          if (qid) void fl.api?.discardFailed(qid)
          setEditLog(null)
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
            fav: itemForm?.fav ?? false, created_by: itemForm?.createdBy ?? 'app', store: itemForm?.storeId ?? '',
          })
          setItemFormOpen(false)
        }}
      />
      {setupOpen && (
        <SetupScreen
          error={setupError}
          initialUrl={gasUrl}
          initialSecret={secret}
          check={props.checkConnection}
          onCancel={() => setSetupOpen(false)}
          onStart={(url, s) => {
            set('foodlog.gasUrl', url); set('foodlog.secret', s); set('foodlog.mock', ''); setGasUrl(url); setSecret(s); setMockMode(false); setSetupOpen(false)
          }}
        />
      )}
      <UndoToast toast={toast} onGone={() => setToast(null)} dock={tab === 'today'} durationMs={toast?.durationMs} />
    </div>
  )
}
