// 啟動流程：決定這支手機用哪個模式，開 SyncClient，再把整個 App 掛上去。
//   1. 這支手機選過「先在這支手機試用」→ 試用模式（本機 Dexie，沒有 transport、不連 Worker）
//   2. 否則問 session（authClient.getSession）：
//        有登入 → 帳號模式（每個 userId 一個 Dexie 資料庫，之後的同步走 /sync/*）
//        沒登入 → 登入畫面（passkey／登入碼；可以改選試用）
//        連不到伺服器 → 有登入過的 userId 就直接用本機資料庫打開（離線也能記），否則登入畫面
//   3. 同步途中收到 401（phase = auth）→ 蓋一層登入畫面，待送資料保留，登入完成就 resume。
// 登入畫面（features/auth/LoginScreen）與 authClient（features/auth/auth-client）是獨立做的；
// authClient.getSession() 離線或 5xx 會丟例外（不是「沒登入」），只有確定沒登入才回 null。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RouterHistory } from '@tanstack/history'
import { FetchTransport, SyncClient, useSyncClient, useSyncStatus } from '@food-log/sync-client'
import { KEYS, cleanupLegacyKeys, readLocal, removeLocal, writeLocal } from '@/lib/local-storage'
import type { CatalogItem } from '@/types'
import { authClient } from '@/features/auth/auth-client'
import { LoginScreen } from '@/features/auth/LoginScreen'
import type { ComponentType } from 'react'
import { AppProviders } from './providers'
import { trackTooOld } from './update-info'
import type { Controls } from './controls'

export interface AppProps {
  /** 直接給 client：跳過登入流程（測試用）。 */
  client?: SyncClient
  /** 開 client 的方式；userId 是 null 就是試用模式。預設：Dexie + FetchTransport。 */
  openClient?: (userId: string | null) => Promise<SyncClient>
  authClient?: Pick<typeof authClient, 'getSession' | 'signOut'>
  LoginScreen?: ComponentType<{ onSignedIn(): void }>
  now?: () => number
  catalogItems?: CatalogItem[]
  history?: RouterHistory
  autoStart?: boolean
  storage?: Storage
}

const defaultOpenClient = (userId: string | null): Promise<SyncClient> =>
  userId === null
    ? SyncClient.open({ userId: null })
    : SyncClient.open({ userId, transport: trackTooOld(new FetchTransport({ baseUrl: import.meta.env.VITE_API_BASE ?? '' })) })

type Boot = { kind: 'booting' } | { kind: 'login' } | { kind: 'ready'; client: SyncClient }

export default function Root(props: AppProps) {
  const open = props.openClient ?? defaultOpenClient
  const auth = props.authClient ?? authClient
  const Login = props.LoginScreen ?? LoginScreen
  const [boot, setBoot] = useState<Boot>(props.client ? { kind: 'ready', client: props.client } : { kind: 'booting' })
  const [nonce, setNonce] = useState(0)
  const bootRef = useRef(boot)
  bootRef.current = boot
  const st = props.storage

  useEffect(() => {
    cleanupLegacyKeys(st)
  }, [st])

  useEffect(() => {
    if (props.client) return
    let cancelled = false
    const ready = async (userId: string | null) => {
      const client = await open(userId)
      if (!cancelled) setBoot({ kind: 'ready', client })
    }
    void (async () => {
      if (readLocal(KEYS.mode, st) === 'trial') return ready(null)
      let session: { userId: string } | null | 'unreachable'
      try {
        session = await auth.getSession()
      } catch {
        session = 'unreachable'
      }
      if (cancelled) return
      if (session && session !== 'unreachable') {
        writeLocal(KEYS.userId, session.userId, st)
        return ready(session.userId)
      }
      const known = readLocal(KEYS.userId, st)
      // 丟例外 = 連不上（不能判斷有沒有登入）：有登入過就用本機資料庫打開；null = 確定沒登入，不能當成離線
      if (known && session === 'unreachable') return ready(known)
      setBoot({ kind: 'login' })
    })()
    return () => {
      cancelled = true
    }
    // open／auth 是穩定的注入點；只在 nonce（重新登入完成）變動時重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, props.client])

  const startTrial = useCallback(async () => {
    writeLocal(KEYS.mode, 'trial', st)
    setBoot({ kind: 'ready', client: await open(null) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st])

  const controls: Controls = {
    async logout() {
      const b = bootRef.current
      if (b.kind !== 'ready') return { ok: true }
      if (b.client.mode === 'account') {
        try {
          await auth.signOut()
        } catch {
          return { ok: false, message: '連不到伺服器，無法登出' }
        }
      }
      removeLocal(KEYS.userId, st)
      removeLocal(KEYS.failedNotified, st)
      setBoot({ kind: 'login' })
      await b.client.destroy()
      return { ok: true }
    },
    leaveTrial() {
      const b = bootRef.current
      removeLocal(KEYS.mode, st)
      if (b.kind === 'ready') b.client.close()
      setBoot({ kind: 'login' })
      setNonce((n) => n + 1)
    },
  }

  if (boot.kind === 'booting') return <div className="min-h-dvh bg-background" aria-busy="true" />
  if (boot.kind === 'login') {
    return (
      <>
        <Login onSignedIn={() => { setBoot({ kind: 'booting' }); setNonce((n) => n + 1) }} />
        <div className="fixed inset-x-0 bottom-0 z-[60] mx-auto w-full max-w-xl px-6 pb-[calc(var(--safe-bottom)+16px)]">
          <button type="button" className="h-12 w-full rounded-[var(--radius)] bg-secondary font-semibold" onClick={() => void startTrial()}>
            先在這支手機試用
          </button>
        </div>
      </>
    )
  }
  return (
    <AppProviders
      client={boot.client}
      controls={controls}
      now={props.now}
      catalogItems={props.catalogItems}
      history={props.history}
      autoStart={props.autoStart}
    >
      <ReauthOverlay Login={Login} />
    </AppProviders>
  )
}

/** 同步收到 401：蓋一層登入畫面。待送資料還在（pending 保留），登入完成就繼續同步。 */
function ReauthOverlay(props: { Login: ComponentType<{ onSignedIn(): void }> }) {
  const client = useSyncClient()
  const status = useSyncStatus()
  if (status.phase !== 'auth') return null
  const { Login } = props
  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-background">
      <Login onSignedIn={() => client.resume()} />
    </div>
  )
}
