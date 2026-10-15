import { useSyncClient } from '@food-log/sync-client'
import { useAppData } from '@/app/data'
import { useControls } from '@/app/controls'
import { useActions, useServices } from '@/app/services'
import { SyncBadge } from '@/components/SyncBadge'
import { SettingsScreen } from '@/screens/SettingsScreen'
import { useToast } from '@/features/toast/ToastProvider'
import type { NameLookup } from '@/data/failures'
import { AccountSection } from './AccountSection'
import { FailedSection } from './FailedSection'

export function SettingsPage() {
  const d = useAppData()
  const actions = useActions()
  const { theme, setTheme } = useServices()
  const { showToast, guard } = useToast()
  const client = useSyncClient()
  const controls = useControls()

  // 失敗的設定：在對應那一列顯示「沒有存到 · 重試」「捨棄」
  const failedKeys: Record<string, { onRetry?: () => void; onDiscard: () => void; message?: string }> = {}
  for (const f of d.failed) {
    if (f.name !== 'config.set@1') continue
    const key = (f.args as { key?: string } | null)?.key
    if (!key) continue
    failedKeys[key] = {
      onRetry: () => void guard(actions.retryFailed(f.mutationId)),
      onDiscard: () => void actions.discardFailed(f),
    }
  }

  const nameOf: NameLookup = (table, id) => {
    if (table === 'logs') return d.logs.find((l) => l.id === id)?.name
    if (table === 'items') return d.items.find((i) => i.id === id)?.name
    return d.stores.find((s) => s.id === id)?.name
  }

  async function addPasskey() {
    // better-auth 的 passkey client 只在這時候才載入（不進首頁 bundle）
    let mods: [typeof import('@/features/auth/auth-client'), typeof import('@/features/auth/LoginScreen')]
    try {
      mods = await Promise.all([import('@/features/auth/auth-client'), import('@/features/auth/LoginScreen')])
    } catch {
      showToast('新增 passkey 失敗，請確認網路後再試')
      return
    }
    const [{ authClient, mapAuthError }, { AUTH_ERROR_COPY, CANCELLED_HINT }] = mods
    try {
      await authClient.addPasskey()
      showToast('已新增 passkey')
    } catch (e) {
      const c = mapAuthError(e)
      showToast(c === 'cancelled' ? CANCELLED_HINT : AUTH_ERROR_COPY[c])
    }
  }

  async function logout() {
    const r = await controls.logout()
    if (!r.ok) showToast(r.message)
  }

  return (
    <SettingsScreen
      config={d.config}
      theme={theme}
      onTheme={setTheme}
      onSetConfig={(k, v) => void guard(actions.setConfig(k, v))}
      onToast={(m) => showToast(m)}
      badge={<SyncBadge loadState={d.loadState} pending={d.pending} online={d.network !== 'offline'} onRetry={d.retry} retrying={d.retrying} />}
      failedKeys={failedKeys}
      extra={
        <>
          <AccountSection
            mode={d.mode}
            pending={d.pending}
            rpId={typeof location === 'undefined' ? '' : location.hostname}
            onAddPasskey={() => void addPasskey()}
            onSyncNow={() => void client.syncNow()}
            onLogout={() => void logout()}
            onLogin={controls.leaveTrial}
          />
          <FailedSection
            failed={d.failed.filter((f) => f.name !== 'config.set@1')}
            nameOf={nameOf}
            onRetry={(f) => void guard(actions.retryFailed(f.mutationId))}
            onDiscard={(f) => void actions.discardFailed(f)}
          />
        </>
      }
    />
  )
}
