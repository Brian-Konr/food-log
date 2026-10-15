// TanStack Router，hash 路由。網址：#today #trends #items #settings #weight（見 history.ts）。
// `weight` 是今天頁 + 開著的記體重 Sheet（深連結）。未知的 hash 一律回今天。
import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/history'
import { ItemsPage } from '@/features/items/ItemsPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { TodayPage } from '@/features/today/TodayPage'
import { TrendsPage } from '@/features/trends/TrendsPage'
import { AppShell } from './AppShell'

const rootRoute = createRootRoute({ component: AppShell })
const page = (path: string, component: () => React.JSX.Element) => createRoute({ getParentRoute: () => rootRoute, path, component })

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', beforeLoad: () => { throw redirect({ to: '/today', replace: true }) } }),
  page('/today', TodayPage),
  page('/weight', TodayPage),
  page('/trends', TrendsPage),
  page('/items', ItemsPage),
  page('/settings', SettingsPage),
  createRoute({ getParentRoute: () => rootRoute, path: '$', component: Outlet, beforeLoad: () => { throw redirect({ to: '/today', replace: true }) } }),
])

export function createAppRouter(history: RouterHistory) {
  return createRouter({ routeTree, history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
