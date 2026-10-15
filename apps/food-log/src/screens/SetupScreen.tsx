import { useState } from 'react'
import { createGasAdapter } from '@/api/gas'

const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/

/** 先實際打一次 read，確認網址和密鑰真的連得上，才回傳 null；否則回傳給人看的錯誤 */
export async function checkConnection(url: string, secret: string, fetchImpl?: typeof fetch): Promise<string | null> {
  if (!URL_RE.test(url)) return '網址格式不對，應該是 https://script.google.com/macros/s/…/exec'
  if (!secret) return '請填共享密鑰'
  try {
    const res = await createGasAdapter({ url, secret, fetchImpl, timeoutMs: 30_000 }).call({ action: 'read' } as never)
    if (res.ok) return null
    if (res.error === 'unauthorized') return '共享密鑰不正確'
    return res.message || `連線失敗（${res.error}）`
  } catch {
    return '連不上這個網址，請確認網路和網址'
  }
}

export function SetupScreen(props: {
  onStart: (url: string, secret: string) => void
  onMock?: () => void
  onCancel?: () => void
  initialUrl?: string
  initialSecret?: string
  error?: string | null
  check?: (url: string, secret: string) => Promise<string | null>
}) {
  const [url, setUrl] = useState(props.initialUrl ?? '')
  const [secret, setSecret] = useState(props.initialSecret ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const editing = !!props.onCancel
  async function submit() {
    const u = url.trim(), s = secret.trim()
    setBusy(true); setErr(null)
    const e = await (props.check ?? checkConnection)(u, s)
    setBusy(false)
    if (e) { setErr(e); return }
    props.onStart(u, s)
  }
  return (
    <div className={editing ? 'fixed inset-0 z-50 flex flex-col justify-center overflow-y-auto bg-background px-6 pt-[var(--safe-top)]' : 'flex min-h-dvh flex-col justify-center px-6 pt-[var(--safe-top)]'}>
      <div className="mx-auto w-full max-w-xl">
        <h1 className="text-[34px] font-bold">{editing ? '後端連線設定' : 'food-log'}</h1>
        <p className="mt-2 text-muted-foreground">貼上 Apps Script 網址和共享密鑰，會先試連一次才儲存</p>
        {(err || props.error) && <p role="alert" className="mt-3 text-destructive">{err || props.error}</p>}
        <label className="mt-6 block">Apps Script 網址
          <input className="mt-1 h-12 w-full rounded-xl border px-3" inputMode="url" autoCapitalize="off" autoCorrect="off" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="mt-3 block">共享密鑰
          <input className="mt-1 h-12 w-full rounded-xl border px-3" autoCapitalize="off" autoCorrect="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </label>
        <button type="button" disabled={busy} className="mt-6 h-14 w-full rounded-[28px] bg-primary text-lg font-bold text-primary-foreground disabled:opacity-60" onClick={() => void submit()}>
          {busy ? '連線中…' : editing ? '儲存' : '開始使用'}
        </button>
        {editing
          ? <button type="button" className="mt-3 h-12 w-full" onClick={props.onCancel}>取消</button>
          : props.onMock && <button type="button" className="mt-3 h-12 w-full" onClick={props.onMock}>先在這支手機試用</button>}
      </div>
    </div>
  )
}
