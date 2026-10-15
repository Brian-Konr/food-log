import { useState } from 'react'
import { authClient, mapAuthError, type AuthErrorCode } from './auth-client'

/** 每種錯誤代碼對應的繁中說明；cancelled 是使用者自己取消，不顯示錯誤 */
export const AUTH_ERROR_COPY: Record<Exclude<AuthErrorCode, 'cancelled'>, string> = {
  invalid_code: '登入碼不對或已過期，請重新產生一組',
  not_allowed: '這個帳號不在允許清單內',
  network: '連不上伺服器，請確認網路後再試',
  unknown: '登入失敗，請稍後再試',
}

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState<'passkey' | 'code' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')

  function show(err: unknown) {
    const c = mapAuthError(err)
    // 使用者按了取消（Face ID 或關掉面板）：安靜回到原畫面，不顯示錯誤
    setError(c === 'cancelled' ? null : AUTH_ERROR_COPY[c])
  }

  async function withPasskey() {
    if (busy) return
    setBusy('passkey')
    setError(null)
    try {
      await authClient.signInWithPasskey()
      onSignedIn()
    } catch (e) {
      show(e)
    } finally {
      setBusy(null)
    }
  }

  async function withCode(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const c = code.trim()
    if (!c) {
      setError(AUTH_ERROR_COPY.invalid_code)
      return
    }
    setBusy('code')
    setError(null)
    try {
      await authClient.signInWithCode(email.trim(), c)
      onSignedIn()
    } catch (err) {
      show(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 pt-[var(--safe-top)]">
      <div className="mx-auto w-full max-w-xl">
        <h1 className="text-[34px] font-bold">food-log</h1>
        <p className="mt-2 text-muted-foreground">登入後才能同步你的飲食紀錄</p>
        {error && <p role="alert" className="mt-3 text-destructive">{error}</p>}
        <button
          type="button"
          disabled={busy !== null}
          aria-busy={busy === 'passkey'}
          className="mt-6 h-14 w-full rounded-[28px] bg-primary text-lg font-bold text-primary-foreground disabled:opacity-60"
          onClick={() => void withPasskey()}
        >
          {busy === 'passkey' ? '登入中…' : '用 passkey 登入'}
        </button>

        <button
          type="button"
          aria-expanded={showCode}
          aria-controls="login-code-panel"
          className="mt-4 h-12 w-full text-muted-foreground"
          onClick={() => setShowCode((v) => !v)}
        >
          用登入碼
        </button>
        {showCode && (
          <form id="login-code-panel" className="mt-2" onSubmit={(e) => void withCode(e)}>
            <p className="text-sm text-muted-foreground">
              登入碼由 Brian 在電腦上執行 <code>pnpm --filter @food-log/api login-code</code> 產生，15 分鐘內有效、只能用一次。
            </p>
            <label className="mt-3 block">Email（選填）
              <input
                className="mt-1 h-12 w-full rounded-xl border px-3"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="mt-3 block">登入碼
              <input
                className="mt-1 h-12 w-full rounded-xl border px-3 font-mono tracking-widest"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={busy !== null}
              aria-busy={busy === 'code'}
              className="mt-4 h-12 w-full rounded-[28px] border font-bold disabled:opacity-60"
            >
              {busy === 'code' ? '登入中…' : '用登入碼登入'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
