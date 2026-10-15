import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './app/Root'
import { registerServiceWorker } from './app/sw'

// registerType: 'prompt'：新版裝好後等著，由更新提示（或 409 client_too_old）換上並重新載入
registerServiceWorker(registerSW)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
