// 設定頁的「帳號」區塊：新增 passkey、立即同步、登出（有待送資料時先確認）、RP ID 說明；試用模式只有說明和「登入」。
// 版面沿用設定頁既有的列（h2 標題 + 圓角卡片 + 52px 的列），不加新的顏色。
import { useState } from 'react'
import { Sheet, SheetContent, SheetTitle } from '@food-log/ui'

export function AccountSection(props: {
  mode: 'trial' | 'account'
  pending: number
  rpId: string
  onAddPasskey: () => void
  onSyncNow: () => void
  onLogout: () => void
  onLogin: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  if (props.mode === 'trial') {
    return (
      <>
        <h2 className="mt-6 text-muted-foreground">帳號</h2>
        <div className="mt-2 overflow-hidden rounded-2xl bg-card">
          <p className="px-4 py-3 text-muted-foreground">本機試用：資料只存在這支手機，不會同步，之後登入也不會搬進帳號。</p>
          <button type="button" className="flex min-h-[52px] w-full items-center justify-between border-t border-border px-4" onClick={props.onLogin}>
            <span>登入</span>
            <span className="text-muted-foreground">›</span>
          </button>
        </div>
      </>
    )
  }
  return (
    <>
      <h2 className="mt-6 text-muted-foreground">帳號</h2>
      <div className="mt-2 overflow-hidden rounded-2xl bg-card">
        <button type="button" className="flex min-h-[52px] w-full items-center justify-between border-b border-border px-4" onClick={props.onSyncNow}>
          <span>立即同步</span>
          <span className="text-muted-foreground">{props.pending > 0 ? `${props.pending} 筆待上傳` : '›'}</span>
        </button>
        <button type="button" className="flex min-h-[52px] w-full items-center justify-between border-b border-border px-4" onClick={props.onAddPasskey}>
          <span>新增 passkey</span>
          <span className="text-muted-foreground">›</span>
        </button>
        <p className="px-4 py-3 text-muted-foreground">
          passkey 綁定的網域（RP ID）是 {props.rpId || '這個網址'}。換網址後舊的 passkey 不能用，要請 Brian 產生登入碼，登入後再新增。
        </p>
        <button
          type="button"
          className="flex min-h-[52px] w-full items-center justify-between border-t border-border px-4 text-destructive"
          onClick={() => (props.pending > 0 ? setConfirm(true) : props.onLogout())}
        >
          <span>登出</span>
        </button>
      </div>
      <Sheet open={confirm} onOpenChange={setConfirm}>
        <SheetContent>
          <div className="px-4 pb-4">
            <SheetTitle>還有 {props.pending} 筆沒有上傳</SheetTitle>
            <p className="mt-2">登出會把這支手機上的資料全部刪掉，還沒上傳的 {props.pending} 筆也會一起消失。</p>
            <button
              type="button"
              className="mt-4 h-12 w-full rounded-[var(--radius)] bg-secondary font-semibold text-destructive"
              onClick={() => {
                setConfirm(false)
                props.onLogout()
              }}
            >
              仍要登出
            </button>
            <button type="button" className="mt-2 h-12 w-full rounded-[var(--radius)] bg-primary font-bold text-primary-foreground" onClick={() => setConfirm(false)}>
              取消
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
