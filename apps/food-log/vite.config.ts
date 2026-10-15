/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// 本機開發：Worker（wrangler dev --local，預設 8787）和網頁同源，cookie 才會跟著走。
const API = process.env.API_ORIGIN ?? 'http://127.0.0.1:8787'

export default defineConfig({
  // v2：Worker 直接在網域根目錄提供網頁（不再是 GitHub Pages 的 /food-log/）
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt'：新版裝好後等著，不自己換。換上由 UpdatePrompt／409 client_too_old 觸發（src/app/sw.ts）
      registerType: 'prompt',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'food-log',
        short_name: 'food-log',
        lang: 'zh-Hant-TW',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0B0B0C',
        theme_color: '#0B0B0C',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,json}'],
        // API 路徑不能被 Service Worker 的 navigation fallback 吃掉（Worker 自己回 JSON）
        navigateFallbackDenylist: [/^\/(sync|bot|api|telemetry)\//],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    proxy: {
      '/api': API,
      '/sync': API,
      '/telemetry': API,
    },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
    // app 與 @food-log/ui 共用同一份 React，避免兩個 instance 讓 hooks／context 壞掉
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
})
