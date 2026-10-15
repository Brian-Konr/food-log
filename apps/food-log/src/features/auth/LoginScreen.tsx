import { useState } from 'react'
import { Button, Input, Label } from '@food-log/ui'
import { authClient, mapAuthError, type AuthErrorCode } from './auth-client'

/** 每種錯誤代碼對應的繁中說明；cancelled 不是錯誤，見 CANCELLED_HINT */
export const AUTH_ERROR_COPY: Record<Exclude<AuthErrorCode, 'cancelled'>, string> = {
  invalid_code: '登入碼不對或已過期，請重新產生一組',
  not_allowed: '這個帳號不在允許清單內',
  network: '連不上伺服器，請確認網路後再試',
  unsupported: '這個瀏覽器不支援 passkey，請改用登入碼',
  unknown: '登入失敗，請稍後再試',
}

/**
 * passkey 被取消。iOS/WebKit 在「這台裝置還沒有這個網站的 passkey」或逾時時也是同一種例外，
 * 和使用者按取消分不開，所以只給溫和的提示（不是錯誤），並自動展開登入碼。
 */
export const CANCELLED_HINT = '已取消，或這台裝置還沒有 passkey，可改用登入碼'

// 與 workers/api/scripts/login-code.ts 檔頭的用法一致；--email 換成自己的信箱
const LOGIN_CODE_COMMAND = 'cd workers/api && node scripts/login-code.ts --email <你的 email> --remote'

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState<'passkey' | 'code' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [code, setCode] = useState('')

  function show(err: unknown) {
    const c = mapAuthError(err)
    if (c === 'cancelled') {
      setError(null)
      setHint(CANCELLED_HINT)
      setShowCode(true)
      return
    }
    setHint(null)
    setError(AUTH_ERROR_COPY[c])
    if (c === 'unsupported') setShowCode(true)
  }

  async function withPasskey() {
    if (busy) return
    setBusy('passkey')
    setError(null)
    setHint(null)
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
    setHint(null)
    if (!c) {
      setError(AUTH_ERROR_COPY.invalid_code)
      return
    }
    setBusy('code')
    setError(null)
    try {
      await authClient.signInWithCode(c)
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
        {hint && <p role="status" className="mt-3 text-muted-foreground">{hint}</p>}
        <Button
          type="button"
          size="lg"
          className="mt-6 w-full rounded-[28px] font-bold"
          disabled={busy !== null}
          aria-busy={busy === 'passkey'}
          onClick={() => void withPasskey()}
        >
          {busy === 'passkey' ? '登入中…' : '用 passkey 登入'}
        </Button>

        <Button
          type="button"
          variant="ghost"
          className="mt-4 w-full text-muted-foreground"
          aria-expanded={showCode}
          aria-controls="login-code-panel"
          onClick={() => setShowCode((v) => !v)}
        >
          用登入碼
        </Button>
        {showCode && (
          <form id="login-code-panel" className="mt-2" onSubmit={(e) => void withCode(e)}>
            <p className="text-sm text-muted-foreground">
              登入碼由 Brian 在電腦上產生：<code className="break-all">{LOGIN_CODE_COMMAND}</code>。15 分鐘內有效、只能用一次。
            </p>
            <Label htmlFor="login-code" className="mt-3 block">登入碼</Label>
            <Input
              id="login-code"
              className="mt-1 font-mono tracking-widest"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              className="mt-4 w-full rounded-[28px] font-bold"
              disabled={busy !== null}
              aria-busy={busy === 'code'}
            >
              {busy === 'code' ? '登入中…' : '用登入碼登入'}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
