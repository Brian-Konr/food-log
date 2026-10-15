// 所有測試共用：Dexie 在 import 的當下就抓全域 indexedDB，所以要在任何測試檔 import 之前先裝好 fake-indexeddb。
// （每台模擬裝置仍然各自用一個 IDBFactory，見 harness.tsx。）
import 'fake-indexeddb/auto'

// jsdom 沒有實作 scrollTo（路由換頁會呼叫）
if (typeof window !== 'undefined') window.scrollTo = () => {}
