// Root 提供給設定頁用的帳號動作（登出、離開試用模式）。
import { createContext, useContext } from 'react'

export interface Controls {
  /** 登出：先通知伺服器，成功才刪本機資料庫。連不到伺服器就不登出（不然 cookie 還在）。 */
  logout(): Promise<{ ok: true } | { ok: false; message: string }>
  /** 離開試用模式，回到登入畫面（試用資料留在這支手機，不會搬進帳號）。 */
  leaveTrial(): void
}

export const ControlsContext = createContext<Controls | null>(null)

export function useControls(): Controls {
  const c = useContext(ControlsContext)
  if (!c) throw new Error('useControls 必須在 Root 底下使用')
  return c
}
