// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { TodayScreen } from '@/screens/TodayScreen'
import { AuthError, HttpError, NetworkError, TooOldError } from '@food-log/sync-client'
import { classifyError, deriveLoadState, errorCopy, type LoadState } from '@/data/loadstate'
import { cleanup as cleanupDom } from '@testing-library/react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountApp, openEnv, seed, settle } from './harness'
import type { LogRecord, MergedItem } from '@/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const TODAY = '2026-10-10'
const log: LogRecord = {
  id: 'l1', ts: '2026-10-10T12:00:00+08:00', deleted: false, updated_at: '', day: TODAY,
  item_id: 'fm:1', name: '雞胸', src: '全家', qty: 1, grams: null, kcal: 100, protein: 10, fat: 1, carb: 2, source: 'app', store: '',
}
const remain = { kcal: 1700, protein: 140, fat: 59, carb: 198 }
const eaten = { kcal: 100, protein: 10, fat: 1, carb: 2 }
const targets = { kcal: 1800, protein: 150, fat: 60, carb: 200 }
const itemsById = new Map<string, MergedItem>()

function renderToday(loadState: LoadState, extra: Partial<Parameters<typeof TodayScreen>[0]> = {}) {
  return render(
    <TodayScreen
      today={TODAY}
      remain={remain}
      eaten={eaten}
      targets={targets}
      logs={[log]}
      itemsById={itemsById}
      stores={[]}
      onWeight={() => {}}
      onOpenLog={() => {}}
      loadState={loadState}
      staleToday={false}
      onRetry={() => {}}
      pending={0}
      online
      {...extra}
    />,
  )
}

function banned(text: string) {
  expect(text).not.toContain('2000')
  expect(text).not.toContain('2,000')
  expect(text).not.toContain('0 筆')
  expect(text).not.toContain('今天還沒有紀錄')
}

test('deriveLoadState 五態', () => {
  expect(deriveLoadState({ booting: true, hasData: false, fresh: false, error: null })).toBe('skeleton')
  expect(deriveLoadState({ booting: false, hasData: true, fresh: false, error: null })).toBe('cached-syncing')
  expect(deriveLoadState({ booting: false, hasData: true, fresh: true, error: null })).toBe('fresh')
  expect(deriveLoadState({ booting: false, hasData: true, fresh: false, error: { kind: 'offline', code: 'NET-0' } })).toBe('error-cached')
  expect(deriveLoadState({ booting: false, hasData: false, fresh: false, error: { kind: 'offline', code: 'NET-0' } })).toBe('error-empty')
  // 本機沒有伺服器資料、也還沒失敗：還是骨架，不是 fresh
  expect(deriveLoadState({ booting: false, hasData: false, fresh: false, error: null })).toBe('skeleton')
})

test('classifyError：NET-0、API-<status>、unauthorized（錯誤物件與代碼字串都認得）', () => {
  expect(classifyError(new NetworkError(), true)).toEqual({ kind: 'offline', code: 'NET-0' })
  expect(classifyError('NET-0', true)).toEqual({ kind: 'offline', code: 'NET-0' })
  expect(classifyError(new HttpError(503), true)).toEqual({ kind: 'server', code: 'API-503' })
  expect(classifyError('API-500', true)).toEqual({ kind: 'server', code: 'API-500' })
  expect(classifyError(new AuthError(), true)).toEqual({ kind: 'auth', code: 'unauthorized' })
  expect(classifyError('unauthorized', true)).toEqual({ kind: 'auth', code: 'unauthorized' })
  expect(classifyError(new TooOldError(2), true)).toEqual({ kind: 'server', code: 'client_too_old' })
  // 瀏覽器離線一律是 NET-0
  expect(classifyError(new HttpError(500), false)).toEqual({ kind: 'offline', code: 'NET-0' })
  expect(errorCopy('server', 'API-503').codeLine).toBe('錯誤代碼 API-503')
  expect(errorCopy('auth', 'unauthorized').reason).toContain('登入')
})

test('skeleton 沒有假數字、沒有 1800 英雄數字', () => {
  const { container } = renderToday('skeleton')
  banned(container.textContent || '')
  expect(container.textContent).not.toMatch(/1800|1,800/)
  expect(container.textContent).toContain('今天還剩')
})

test('skeleton 剩餘卡與真資料同一套字級槽', () => {
  const { container } = renderToday('skeleton')
  const card = container.querySelector('[data-remain-card]')
  expect(card?.querySelector('.h-14')).toBeTruthy()
  expect(card?.querySelector('.h-9')).toBeTruthy()
  expect(card?.textContent).toContain('kcal')
  expect(card?.textContent).toContain('g 蛋白質')
})

test('fresh 與 cached-syncing 熱量 text-hero、蛋白質 text-2xl', () => {
  for (const st of ['fresh', 'cached-syncing'] as const) {
    const { container, unmount } = renderToday(st)
    const card = container.querySelector('[data-remain-card]')
    expect(card?.querySelector('.text-hero')).toBeTruthy()
    expect(card?.querySelector('.text-2xl')).toBeTruthy()
    unmount()
  }
})

test('error-empty 有讀不到和重試，沒有假數字', () => {
  const { container } = renderToday('error-empty', { errorReason: '沒有網路連線', errorCodeLine: '錯誤代碼 NET-0' })
  banned(container.textContent || '')
  expect(container.textContent).not.toMatch(/1800|1,800/)
  expect(container.textContent).toContain('讀不到今天的資料')
  expect(container.textContent).toContain('重試')
})

test('cached-syncing 看得到快取數字；300ms 後同步中', () => {
  vi.useFakeTimers()
  const { container } = renderToday('cached-syncing')
  banned(container.textContent || '')
  expect(container.textContent).toContain('1,700')
  act(() => { vi.advanceTimersByTime(300) })
  expect(container.textContent).toContain('同步中')
})

test('error-cached 沒有假 2000', () => {
  const { container } = renderToday('error-cached')
  banned(container.textContent || '')
})

test('fresh 看得到伺服器數字', () => {
  const { container } = renderToday('fresh')
  banned(container.textContent || '')
  expect(container.textContent).toContain('1,700')
  expect(container.textContent).toContain('雞胸')
})

test('熱量超過、蛋白質沒超過：還剩 47.8 g 蛋白質', () => {
  const { container } = renderToday('fresh', {
    remain: { kcal: -120, protein: 47.8, fat: 0, carb: 0 },
    eaten: { kcal: 1920, protein: 102.2, fat: 60, carb: 200 },
  })
  const card = container.querySelector('[data-remain-card]')
  const text = card?.textContent || ''
  expect(text).toContain('今天超過')
  expect(text).toContain('還剩')
  expect(text).toContain('47.8')
  expect(text).toContain('g 蛋白質')
  expect(text).not.toContain('蛋白質超過')
  expect(card?.getAttribute('aria-label')).toContain('還剩 47.8 公克蛋白質')
  const num = card?.querySelector('.text-2xl')
  expect(num?.className).toContain('text-[var(--macro-protein)]')
})

test('蛋白質超過：整句蛋白質超過 5.0 g，用 --over', () => {
  const { container } = renderToday('fresh', {
    remain: { kcal: -120, protein: -5, fat: 0, carb: 0 },
    eaten: { kcal: 1920, protein: 155, fat: 60, carb: 200 },
  })
  const card = container.querySelector('[data-remain-card]')
  const text = card?.textContent || ''
  expect(text).toContain('蛋白質超過 5.0 g')
  expect(text).not.toContain('g 蛋白質')
  const num = card?.querySelector('.text-2xl')
  expect(num?.className).toContain('text-[var(--over)]')
  const aria = card?.getAttribute('aria-label') || ''
  expect(aria).toContain('蛋白質超過 5.0 公克')
  expect(aria).not.toContain('-')
})

test('只有蛋白質超過時標題仍是今天還剩', () => {
  const { container } = renderToday('fresh', {
    remain: { kcal: 100, protein: -5, fat: 0, carb: 0 },
    eaten: { kcal: 1700, protein: 155, fat: 60, carb: 200 },
  })
  const card = container.querySelector('[data-remain-card]')
  expect(card?.textContent).toContain('今天還剩')
  expect(card?.textContent).toContain('蛋白質超過 5.0 g')
})

test('兩者都沒超過：蛋白質行沒有還剩前綴', () => {
  const { container } = renderToday('fresh', {
    remain: { kcal: 100, protein: 47.8, fat: 0, carb: 0 },
    eaten: { kcal: 1700, protein: 102.2, fat: 60, carb: 200 },
  })
  const card = container.querySelector('[data-remain-card]')
  const text = card?.textContent || ''
  expect(text).toContain('今天還剩')
  expect(text).not.toContain('還剩 47.8')
  expect(text).toContain('47.8')
  expect(text).toContain('g 蛋白質')
})

// ---- 冷啟動：任何時間點都不能出現和真實資料不一致的數字（PRD 驗收 #10） ----

function watchText() {
  const seen: string[] = []
  const states: string[] = []
  const grab = () => {
    seen.push(document.body.textContent ?? '')
    const st = document.querySelector('[data-load-state]')?.getAttribute('data-load-state')
    if (st && states.at(-1) !== st) states.push(st)
  }
  const mo = new MutationObserver(grab)
  mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
  grab()
  return { seen, states, stop: () => mo.disconnect() }
}

const fakeNumber = (t: string) => /2,?000/.test(t)

async function serverWithTarget1800() {
  const env = await openEnv()
  await seed(env.server, 'config.set@1', { key: 'target_kcal', value: '1800' })
  return env.server
}

test('冷啟動（沒有任何本機資料）：骨架 → 同步完才有數字；全程沒有預設的 2000', async () => {
  cleanupDom()
  const server = await serverWithTarget1800()
  await seed(server, 'logs.add@1', {
    log: {
      id: 'l1', ts: '2026-10-10T12:00:00+08:00', day: '2026-10-10', item_id: null, name: '午餐', src: '其他', qty: 1, grams: null,
      kcal: 300, protein: 20, fat: 5, carb: 30, source: 'quick', store_id: null,
    },
  })
  const env = await openEnv({ server }) // 沒有 synced：本機是空的
  const w = watchText()
  const { container } = mountApp(env)
  await waitFor(() => expect(container.querySelector('[data-load-state="fresh"]')).toBeTruthy())
  await waitFor(() => expect(container.textContent).toContain('1,500')) // 1800 − 300
  w.stop()
  expect(w.states[0]).toBe('skeleton') // 第一個畫面是骨架，不是數字
  expect(w.states.at(-1)).toBe('fresh')
  expect(w.seen.filter(fakeNumber)).toEqual([])
  // 還沒 fresh 之前，不會說「今天還沒有紀錄」（那是伺服器說了才算）
  const firstFresh = w.seen.findIndex((t, i) => i > 0 && t.includes('1,500'))
  expect(w.seen.slice(0, firstFresh).filter((t) => t.includes('今天還沒有紀錄'))).toEqual([])
})

test('冷啟動又連不上：error-empty，讀不到今天的資料，沒有數字', async () => {
  cleanupDom()
  const env = await openEnv()
  env.transport.online = false
  const w = watchText()
  const { container } = mountApp(env)
  await waitFor(() => expect(container.querySelector('[data-load-state="error-empty"]')).toBeTruthy())
  expect(container.textContent).toContain('讀不到今天的資料')
  expect(container.textContent).toContain('NET-0')
  expect(container.textContent).not.toMatch(/今天還沒有紀錄/)
  w.stop()
  expect(w.seen.filter(fakeNumber)).toEqual([])
})

test('伺服器 5xx 冷啟動：API-<status> 代碼', async () => {
  cleanupDom()
  const env = await openEnv()
  env.transport.pull = async () => {
    throw new HttpError(503)
  }
  const { container } = mountApp(env)
  await waitFor(() => expect(container.querySelector('[data-load-state="error-empty"]')).toBeTruthy())
  expect(container.textContent).toContain('API-503')
})

test('有本機資料、這次還沒同步成功：畫本機資料（cached-syncing／error-cached），不是 fresh，也沒有 2000', async () => {
  cleanupDom()
  const server = await serverWithTarget1800()
  const env = await openEnv({ server, synced: true }) // 上次打開過
  env.transport.online = false // 這次連不上
  const w = watchText()
  const { container } = mountApp(env)
  await waitFor(() => expect(container.querySelector('[data-load-state="error-cached"]')).toBeTruthy())
  expect(container.querySelector('[data-load-state="fresh"]')).toBeNull()
  expect(container.textContent).toContain('1,800') // 本機的 config，不是預設值
  expect(container.textContent).toContain('沒有同步 · 重試')
  w.stop()
  expect(w.seen.filter(fakeNumber)).toEqual([])
  // 連線恢復後按重試 → fresh
  env.transport.online = true
  fireEvent.click(screen.getByText('沒有同步 · 重試'))
  await settle(env)
  await waitFor(() => expect(container.querySelector('[data-load-state="fresh"]')).toBeTruthy())
})
