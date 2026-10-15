// hash 路由：網址維持 v1 的 `#today` `#trends` `#items` `#settings` `#weight`（書籤、Kyujin 提醒裡的 `#weight` 連結都照用）。
// TanStack Router 內建的 createHashHistory 會寫成 `#/today`；這裡用同一套 createBrowserHistory 換掉
// 網址和路徑的對應：`#today` ⇄ `/today`。讀的時候兩種寫法（`#today`、`#/today`）都認得。
import { createBrowserHistory, parseHref } from '@tanstack/history'
import type { RouterHistory } from '@tanstack/history'

export function createAppHashHistory(win: Window = window): RouterHistory {
  return createBrowserHistory({
    window: win,
    parseLocation: () => {
      const raw = win.location.hash.replace(/^#\/?/, '').split(/[?#]/)[0] ?? ''
      return parseHref(`/${raw}`, win.history.state)
    },
    createHref: (href) => `${win.location.pathname}${win.location.search}#${href.replace(/^\//, '')}`,
  })
}
