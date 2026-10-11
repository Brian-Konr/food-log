# AGENTS.md

給接手這個 repo 的 coding agent。人看的說明在 [`README.md`](README.md)；規格在 [`../docs/spec/v1.1.md`](../docs/spec/v1.1.md)（v1 行為沒寫要改的仍有效），施工計畫在 [`../docs/plans/v1.1.md`](../docs/plans/v1.1.md)。改動前請讀完這份文件。

## 專案目的與使用者

- **Brian** 用這個 PWA 記自己吃了什麼、還剩多少熱量／蛋白質，以及體重。資料在 Brian 的 Google Sheet，經 Apps Script。
- **Kyujin** 是外部客戶端（不是第二個畫面）。同一個 `/exec` 網址和共享密鑰。Kyujin 可以建／改店家、改任何店家品項、寫 `source=kyujin` 的 Logs、寫自己建的沒有店家的 `u:` 品項、寫體重。不能刪店家、不能動 `app`／`quick` 的 Logs、不能改沒有店家的 App 自建品項、不能補填官方品項、不能改設定。
- 介面全部是**繁體中文**，時區固定 Asia/Taipei（UTC+8，無夏令時間）。
- 資料存在 Google Sheet，人和其他工具會直接打開 Sheet 看，所以欄位值要人看得懂（存中文選項文字，不存代碼）。

## 目錄地圖

| 路徑 | 內容 |
|---|---|
| `src/App.tsx` | 唯一有狀態的容器：hash 路由（`#today`、`#trends`、`#items`、`#settings`、`#weight`）、toast、把畫面接到資料層 |
| `src/screens/`、`src/components/` | 只吃 props 的展示元件，不直接呼叫資料層；`components/ui/` 是 shadcn/ui |
| `src/hooks/useFoodLog.ts` | 讀資料、定時重讀、`loadState`、快取、待送筆數、`failStreak` |
| `src/api/index.ts` | 待送佇列：存在 IndexedDB（`food-log`／`kv`），依序送出。啟動時從 localStorage 遷移 |
| `src/api/gas.ts` | Apps Script 介面卡（`GAS_TIMEOUT_MS = 55000`、`text/plain` POST） |
| `src/api/mock.ts` | 本機試用介面卡（沒有網址時使用）。起始是空資料，驗證規則和後端相同。`latencyMs`、`setOffline` |
| `src/api/errors.ts` | `NetworkError`、`ServerError`。`PERMANENT_ERRORS` 含 `forbidden`、`duplicate_name`、`schema_outdated` |
| `src/data/codec.ts` | Sheet 原始列和畫面型別（`src/types.ts`）之間的轉換 |
| `src/data/defaults.ts` | 預設 Config（必須和 `gas/Schema.gs` 的 `DEFAULT_CONFIG` 逐字相同） |
| `src/data/network.ts` | 連線狀態與橫幅規則 |
| `src/data/catalog.ts` | 載入快照並套上 `ov:` 補填、`u:` 自建、`fav_ids`、店家 |
| `src/data/search.ts` | 本機搜尋索引與計分。`SearchHit.group` 的 `'store'` 是 7-11・全家區；篩選膠囊 `'store'` 是餐廳品項 |
| `src/data/kv.ts`、`cache.ts`、`loadstate.ts` | IndexedDB、快照、載入五態 |
| `src/lib/day.ts` | 台北日界線、週一 |
| `src/lib/nutrition.ts` | 份量換算、合計、剩餘 |
| `src/lib/trends.ts` | 趨勢純函式（與 `gas/Trends.gs` 同一套算法） |
| `src/lib/format.ts` | 文案與數字格式 |
| `gas/` | Apps Script 後端：`Code.gs`（API）、`Schema.gs`（欄位、預設值）、`Setup.gs`（初始化、密鑰）、`Trends.gs`、`appsscript.json`、合併檔 `FoodLog-AppsScript.gs` |
| `test/` | Vitest；`gas-fakes.ts` 模擬 SpreadsheetApp、PropertiesService 等，讓 `gas/*.gs` 能在 Node 裡測。food-log 不使用 Drive |
| `scripts/` | `deploy-gh-pages.sh`、`build-gas.mjs`、`sync-tokens.mjs`、`build-catalog.mjs`、`fetch-fam-details.mjs` |
| `public/catalog-v1.json` | 內建品項快照。repo 裡的 `version: "fixture"` 是示意；正式檔由 `build:catalog` 覆蓋 |
| `../docs/spec/` | 技術規格 `v1.md`、`v1.1.md` |
| `../docs/design/` | `DESIGN.md`、`tokens.css`、原型 `mock/` |
| `../docs/kyujin-api.md` | Kyujin 範例請求 |
| `deploy/gas-url` | 目前的 `/exec` 網址（公開，不是秘密）。v1 實作時先不要建 |

畫面元件只接收 props，不呼叫 `createApi`。只有 `App.tsx` 和 `useFoodLog` 碰資料層。

## 設計與產品原則

- 設計系統以 [`../docs/design/DESIGN.md`](../docs/design/DESIGN.md) 為準：行動優先、繁中、石墨色。顏色、字體、間距只用 design token，不要寫死數值。
- 改色只改 `docs/design/mock/build.py` 再重跑；實作者**不要**改色，也不要改 `tokens.css` 的色票。
- token 來源是 repo 的 [`../docs/design/tokens.css`](../docs/design/tokens.css)。`npm run dev/build` 會自動同步到 `src/styles/tokens.css`；兩份都要 commit。
- `docs/design/mock/` 的原型只是參考，**`src/` 的 App 程式碼才是正本**。
- 範例或示意資料必須標明是示意；本機試用模式不可以產生假的飲食紀錄。
- 範圍先守住 v1。

## 資料模型與 API 合約

- Sheet 分頁與欄位定義在 `gas/Schema.gs` 的 `SCHEMA`，說明在 README 的「Sheet 分頁與欄位」和 `../docs/spec/v1.md`。
- 五個分頁：Items（主鍵 `id`）、Logs（主鍵 `id`）、Weights（主鍵 `day`）、Stores（主鍵 `id`）、Config（主鍵 `key`）。Items 最後加 `store`；Logs 最後加 `source`、`store`。
- 前端一律 `POST`、`Content-Type: text/plain`，body 是 `{ secret, action, ... }`。action 有 `read`、`append`、`update`、`softDelete`、`restore`、`upsertItem`、`upsertStore`、`upsertWeight`、`setConfig`、`history`、`summary`、`trends`。參數與回傳見 README 的 API 表和 `gas/Code.gs` 檔頭。`history`、`summary`、`trends` 不進待送佇列。`read` 回 `stores`（沒有就當 `[]`）。
- 回應是 `{ ok: true, ... }` 或 `{ ok: false, error, message }`。`error` 代碼只有：`unauthorized`、`bad_json`、`bad_action`、`bad_table`、`bad_record`、`not_found`、`busy`、`server_error`、`forbidden`、`duplicate_name`、`schema_outdated`。
- 要加欄位時：改 `SCHEMA`，同步 `src/types.ts`、`src/data/codec.ts`、規格，加測試，跑 `npm run build:gas`。已上線的 Sheet：後端第一次收到請求會在 LockService 裡自動 migrate，並把 `schema_version` 寫進 Config，之後跳過。編輯器的 `migrateFoodLog` 仍可用（只補缺的，不清資料、不碰密鑰）。`setupFoodLog` 也可以再跑，只補缺的表和 Config。**不要改既有欄位的名稱或順序**。骨架或錯誤空畫面不要用 `DEFAULT_CONFIG` 的 2000 去畫剩餘。

## 不可破壞的規則

1. **前端不放任何私密 token 或密鑰。** 共享密鑰只由使用者在手機上輸入。`test/security.test.ts` 會掃原始碼和 `dist/`。`/exec` 網址不是密鑰，可以留在 `deploy/gas-url`。
2. **密鑰、token 都不進 repo。** repo 是公開的。
3. **寫入必須冪等。** 每筆紀錄的 `id` 在前端產生，後端遇到重複 id 視為成功。逾時後重送不能變成兩筆。例外只有體重：同一天第二筆新 id 會覆寫公斤數，Sheet 仍只有一筆未刪除的列；重送舊 id 不改儲存格。
4. **所有請求最長等 55 秒**（`GAS_TIMEOUT_MS`）。不要把逾時調短。
5. **離線佇列不能默默丟資料。** 送不出去的紀錄留在手機 IndexedDB。暫時失敗後依序等 2 秒、5 秒、15 秒各自動 `flush` 一次；三次之後等回到前景或 `online` 再試。永久錯誤不進這個計時器。
6. **連線橫幅**：瀏覽器 `navigator.onLine === false` 立刻顯示「連不到 Google 試算表」。背景讀取失敗一次不顯示，15 秒後重讀；沒有快取且連續失敗 2 次才顯示。有快取的讀取失敗不顯示橫幅，用頂列 `SyncBadge`。寫入的 `NetworkError`（含 55 秒逾時）一次不把 `online` 設成 false、不顯示橫幅；同一筆留在佇列，依序再等 2 秒、5 秒、15 秒各試一次，三次都失敗才顯示橫幅。不要因為佇列裡有紀錄就把一次寫入失敗當成斷線。
7. **後端寫入用 `LockService` 包住（等 10 秒）**。飲食紀錄只 append 和軟刪除（`deleted=TRUE`）。
8. **`src/data/defaults.ts` 和 `gas/Schema.gs` 的預設值必須一致**，`test/defaults.test.ts` 會比對。`theme` 不進 Sheet。
9. **`gas/FoodLog-AppsScript.gs` 是產生出來的**，改 `gas/*.gs` 後要跑 `npm run build:gas`，`test/gas-merged.test.ts` 會檢查。
10. **`appsscript.json` 的授權範圍只有 `spreadsheets.currentonly`。** 不要加 Drive，不要加完整 `spreadsheets`。
11. **不要打全家 API。** 不要讀 `/workspace/food-research` 來找未寫進規格的欄位。不要執行 `fetch-fam-details.mjs`。
12. 每筆飲食紀錄的熱量、蛋白質、脂肪、碳水都是 ≥ 0 的有限數字。只有熱量的品項要先補三項營養素；面板關掉就什麼都不寫；後端拒收缺營養素的紀錄。
13. 台北日界線用 OFFSET 公式（`Date` + 8 小時再 `toISOString` slice），不要用會受機器時區影響的 `getDate()` / `Intl`。
14. 一週從週一起算。今天永遠不是「記錄不完整」。不要用負數表示超過（畫面寫「超過」）。

## 測試、建置與驗證

```bash
npm ci
npm test            # 全部單元測試，必須全過
npm run build       # tsc -b + vite build，必須沒有錯誤
npm run build:gas   # 改過 gas/ 才需要
npm run e2e         # 真實點擊；自己開 dev server，PLAYWRIGHT_DIR 預設已設，不下載瀏覽器
```

改動後的驗證：

1. `npm test` 和 `npm run build` 都通過。
2. 畫面有改的話，`npm run dev` 用手機尺寸（例如 390×844）在本機試用模式走一次相關流程。
3. 不要在沒有 Brian 同意的情況下，用真實的 `/exec` 網址和密鑰寫入測試資料；真實 Sheet 是正式資料。
4. 部署前端用 `./scripts/deploy-gh-pages.sh`，之後打開 https://brian-konr.github.io/food-log/ 確認能載入。沒有 Brian 同意不要部署。
5. 改了 `gas/` 的話，前端部署不會更新後端；要請 Brian 照 README「更新程式碼」重新部署新版本。

預設測試環境是 `node`；只有 `*.test.tsx` 在檔案第一行寫 `// @vitest-environment jsdom`。

## 需要 Brian 本人操作的步驟

agent 做不到、也不應該嘗試繞過：

- 用 Brian 的 Google 帳號開新試算表、綁定 Apps Script。
- 在 Apps Script 編輯器貼上新程式碼、執行 `setupFoodLog` 或 `rotateSharedSecret`、授權 Google 權限。
- 部署或更新 Apps Script 網頁應用程式（「管理部署作業 → 編輯 → 新版本」可以維持網址不變）。
- 把 `/exec` 網址放進 `deploy/gas-url`。
- GitHub repo 設定：Pages 來源、Actions 權限、Secrets/Variables。
- 跑 `deploy-gh-pages.sh` 部署前端。

遇到這些步驟時，把要做的事和確切步驟寫給 Brian，然後停下來。

## v1 不做

衛福部資料、AI 照片、推薦、自動算目標、推播、多人、超過 4 週的趨勢。
