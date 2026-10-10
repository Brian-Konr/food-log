export type CatalogSrc = 'familymart' | '711' | 'custom'
export type SheetSrc = '7-11' | '全家' | '其他'
export type CreatedBy = 'app' | 'kyujin'
export type ItemKind = '自建' | '補填'
export type NetworkState = 'online' | 'offline' | 'unreachable'
export type Tab = 'today' | 'trends' | 'items' | 'settings'
export type SyncState = 'synced' | 'queued' | 'failed'

export type CatalogItem = {
  id: string
  src: CatalogSrc
  name: string
  cat: string
  serving: string
  servingG: number | null
  perPack: number
  kcal: number
  protein: number | null
  fat: number | null
  carb: number | null
}

export type MergedItem = CatalogItem & {
  fav: boolean
  createdBy: CreatedBy | null
  override: boolean
  needsFill: boolean
  sheetSrc: SheetSrc
}

export type LogRecord = {
  id: string
  ts: string
  deleted: boolean
  updated_at: string
  day: string
  item_id: string
  name: string
  src: SheetSrc
  qty: number
  grams: number | null
  kcal: number
  protein: number
  fat: number
  carb: number
  __pending?: boolean
}

export type WeightRecord = {
  id: string
  day: string
  ts: string
  deleted: boolean
  updated_at: string
  kg: number
  __pending?: boolean
}

export type ItemRecord = {
  id: string
  ts: string
  deleted: boolean
  updated_at: string
  kind: ItemKind
  base_id: string
  src: SheetSrc
  name: string
  serving: string
  serving_g: number | null
  kcal: number
  protein: number
  fat: number
  carb: number
  fav: boolean
  created_by: CreatedBy
  __pending?: boolean
}

export type ConfigMap = Record<string, string>

export type Snapshot = {
  ok: true
  version: number
  serverTime: string
  config: ConfigMap
  items: ItemRecord[]
  logs: LogRecord[]
  weights: WeightRecord[]
}

export type Macros = { kcal: number; protein: number; fat: number; carb: number }

export type DayTotals = Macros & { count: number }

export type Targets = { kcal: number; protein: number; fat: number; carb: number }

export type DaySlotKind = 'today' | 'future' | 'incomplete' | 'complete'

export type DaySlot = DayTotals & {
  day: string
  slot: DaySlotKind
  kg: number | null
}

export type WeekSummary = {
  weekStart: string
  weekEnd: string
  avgKcal: number | null
  avgDeficit: number | null
  proteinHit: number
  proteinDenom: number
  incompleteDays: number
}

export type WeightSeries = {
  points: { day: string; kg: number }[]
  avg7: { day: string; kg: number }[]
  expected: { day: string; kg: number }[]
  startDay: string | null
  startAvg: number | null
  endAvg: number | null
  endDay: string | null
  deltaKg: number | null
  expectedDeltaKg: number | null
}

export type TrendsView = {
  summary: WeekSummary
  slots: DaySlot[]
  weight: WeightSeries
  completeDays: number
  insufficient: boolean
  chartIncompleteN: number
  chartIncompleteDays: string[]
  overGoalDays: number
  chartAvgKcal: number | null
}

export type SearchFilter = 'all' | 'fav' | '711' | 'familymart'

export type SearchHit = {
  item: MergedItem
  score: number
  group: 'fav-recent' | 'store'
}

export type Toast = {
  id: string
  message: string
  undo?: () => unknown
}
