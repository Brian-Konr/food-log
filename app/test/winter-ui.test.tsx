// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SearchSheet } from '@/components/SearchSheet'
import { StoreItemForm } from '@/components/StoreItemForm'
import { ResultRow } from '@/components/ResultRow'
import { LogRow } from '@/components/LogRow'
import { SyncBadge } from '@/components/SyncBadge'
import { UndoToast } from '@/components/UndoToast'
import { merged, logFields } from './helpers'

afterEach(() => cleanup())

test('搜尋 Sheet 不指定店家在常吃店家上面，是 muted 次要列', () => {
  render(
    <SearchSheet
      open
      onOpenChange={() => {}}
      items={[]}
      stores={[]}
      logs={[]}
      today="2026-10-10"
      remainLine="還剩"
      query=""
      onQuery={() => {}}
      filter="all"
      onFilter={() => {}}
      onSelect={() => {}}
      onManual={() => {}}
      onQuick={() => {}}
      onOpenStore={() => {}}
      onAddStore={() => {}}
    />,
  )
  const quick = screen.getByRole('button', { name: '不指定店家' })
  const heading = screen.getByText('常吃店家')
  expect(quick.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(quick.className).toMatch(/text-muted-foreground/)
  expect(quick.querySelector('svg')).toBeTruthy()
})

test('新增品項表單返回維持一行', () => {
  render(
    <StoreItemForm
      open
      mode="store"
      online
      onBack={() => {}}
      onRecord={() => {}}
      onSaveOnly={() => {}}
    />,
  )
  const back = screen.getByRole('button', { name: '返回' })
  expect(back.className).toMatch(/whitespace-nowrap/)
  expect(back.textContent).toBe('‹ 返回')
})

test('店名 · 品項中間點兩邊有空格；蛋白 20.0 g', () => {
  const item = merged({
    id: 'u:1', name: '陽春麵', src: 'custom', sheetSrc: '其他',
    storeId: 's:1', storeName: 'e2e麵店', protein: 20, kcal: 400,
  })
  render(<ResultRow item={item} storeName="e2e麵店" onSelect={() => {}} />)
  const t = screen.getByRole('button').textContent || ''
  expect(t).toMatch(/e2e麵店\s·\s陽春麵/)
  expect(t).toContain('蛋白 20.0 g')
})

test('LogRow 寫蛋白 20.0 g', () => {
  render(
    <LogRow
      log={logFields({ id: 'l1', protein: 20, kcal: 400 })}
      onOpen={() => {}}
    />,
  )
  expect(screen.getByRole('button').textContent).toContain('蛋白 20.0 g')
})

test('離線徽章圓點用 muted', () => {
  const { container } = render(
    <SyncBadge loadState="fresh" pending={2} online={false} onRetry={() => {}} />,
  )
  expect(container.textContent).toContain('離線 · 2 筆待上傳')
  expect(container.querySelector('.bg-muted-foreground')).toBeTruthy()
})

test('toast 與內容欄同寬（max-w-xl）', () => {
  const { container } = render(
    <UndoToast toast={{ id: 't', message: '已記錄 陽春麵 1 份' }} onGone={() => {}} dock />,
  )
  const inner = container.querySelector('[role=status]')
  expect(inner?.className).toMatch(/max-w-xl/)
})

test('deploy-gas.sh 走 clasp/ 正式專案', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sh = readFileSync(path.join(here, '../scripts/deploy-gas.sh'), 'utf8')
  expect(sh).toContain('npm run build:gas')
  expect(sh).toContain('FoodLog-AppsScript.gs')
  expect(sh).toContain('Code.js')
  expect(sh).toContain('src-bak-')
  expect(sh).toContain('/home/box/.local/bin/clasp')
  expect(sh).toContain('update-deployment')
  expect(sh).toContain('appsscript.json')
  expect(sh).toContain('clasp')
  expect(sh).not.toMatch(/app\/\.clasp\.json|gas\/\.clasp\.json/)
  expect(sh).toContain('FOODLOG_DEPLOY_ID')
  expect(sh).toContain('AKfycbzkkNiqeHeFF7i0qgC8V8vTApGuvLgCgobEsDI_63c1ZUpftEf2tqYCjO57L64nlqwffQ')
  expect(sh).not.toContain('@HEAD')
  expect(sh).not.toContain('deployments')
  const parts = sh.split('"$CLASP_BIN"')
  expect(parts).toHaveLength(3)
  expect(parts[0]).toContain('cd "$CLASP_DIR"')
  expect(parts[1]).toContain('cd "$CLASP_DIR"')
})
