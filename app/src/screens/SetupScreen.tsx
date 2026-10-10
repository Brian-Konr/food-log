import { useState } from 'react'

export function SetupScreen(props: {
  onStart: (url: string, secret: string) => void
  onMock: () => void
  error?: string | null
}) {
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 pt-[var(--safe-top)]">
      <h1 className="text-[34px] font-bold">food-log</h1>
      <p className="mt-2 text-muted-foreground">貼上 Apps Script 網址和共享密鑰</p>
      {props.error && <p className="mt-3 text-destructive">{props.error}</p>}
      <input className="mt-6 h-12 w-full rounded-xl border px-3" placeholder="網址" value={url} onChange={(e) => setUrl(e.target.value)} />
      <input className="mt-3 h-12 w-full rounded-xl border px-3" placeholder="共享密鑰" value={secret} onChange={(e) => setSecret(e.target.value)} />
      <button type="button" className="mt-6 h-14 w-full rounded-[28px] bg-primary text-lg font-bold text-primary-foreground" onClick={() => props.onStart(url.trim(), secret.trim())}>
        開始使用
      </button>
      <button type="button" className="mt-3 h-12 w-full" onClick={props.onMock}>先在這支手機試用</button>
    </div>
  )
}
