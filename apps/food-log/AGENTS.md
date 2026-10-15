# AGENTS.md

> **v2 分支注意**：此檔隨 `app/` 搬到 `apps/food-log/`，路徑已變動：`gas/` → `../../legacy/gas/`；GAS 測試（`gas-*`、`gas-defaults`、`gas-trends-parity`）與 `build-gas.mjs` 在 `../../legacy/`；`../docs/` → `../../docs/`。套件管理改用 `npx -y pnpm@10`（`npm run X` → `npx -y pnpm@10 --filter @food-log/app X`；在本目錄也可直接 `npx -y pnpm@10 X`）。**v2 分支沒有部署腳本與 `deploy/gas-url`**：v1 部署只能從 `main` 做。以根目錄 [`AGENTS.md`](../../AGENTS.md) 為準。

給接手這個 repo 的 coding agent。人看的說明在 [`README.md`](README.md)；規格在 [`../../docs/spec/v1.1.md`](../../docs/spec/v1.1.md)（v1 行為沒寫要改的仍有效），施工計畫在 [`../../docs/plans/v1.1.md`](../../docs/plans/v1.1.md)。改動前請讀完這份文件。

## 專案目的與使用者

- **Brian** 用這個 PWA 記自己吃了什麼、還剩多少熱量／蛋白質，以及體重。資料在 Brian 的 Google Sheet，經 Apps Script。
- **Kyujin** 是外部客戶端（不是第二個畫面）。同一個 `/exec` 網址和共享密鑰。Kyujin 可以建／改店家、改任何店家品項、寫 `source=kyujin` 的 Logs、寫自己建的沒有店家的 `u:` 品項、寫體重。不能刪店家、不能動 `app`／`quick` 的 Logs、不能改沒有店家的 App 自建品項、不能補填官方品項、不能改設定。
- 介面全部是**繁體中文**，時區固定 Asia/Taipei（UTC+8，無夏令時間）。
- 資料存在 Google Sheet，人和其他工具會直接打開 Sheet 看，所以欄位值要人看得懂（存中文選項文字，不存代碼）。

## 目錄地圖

| 路徑 | 內容 |
|---|---|
| `src/app/` | 外框：`Root.tsx`（啟動：試用／登入／離線打開、401 重新登入、登出）、`providers.tsx`、`router.tsx`（TanStack Router，hash 路由 `#today #trends #items #settings #weight`，`history.ts` 保持不帶斜線的網址）、`AppShell.tsx`、`data.tsx`（`useAppData`：從本機 Dexie 一次讀一張同時刻的快照並算好畫面要的數字）、`ui.tsx`（哪個 Sheet 開著）、`services.tsx`（時鐘、動作、主題）、`session.ts`（這次打開是否同步成功）、`sw.ts`、`update-info.ts` |
| `src/features/{today,trends,items,settings,weight,stores,search,log,toast}/` | 把 `useAppData()` 接到畫面元件的薄容器；`auth/`、`update/` 是登入畫面與更新提示 |
| `src/screens/`、`src/components/` | 只吃 props 的展示元件，不直接呼叫資料層；shadcn/ui 元件與 `cn` 已搬到 `../../packages/ui`（`@food-log/ui`），用 `import { Sheet, cn } from '@food-log/ui'`。加 shadcn 元件要在 `../../packages/ui` 跑 `npx shadcn@latest add <name>`（本目錄已沒有 `components.json`），再到 `packages/ui/src/index.ts` 匯出 |
| `src/data/actions.ts` | 所有使用者動作（含 undo），每個都是對 `SyncClient.mutate` 的呼叫；undo 一律是反向 mutation（計畫 §3.6）。畫面不直接呼叫 `mutate` |
| `src/data/failures.ts`、`view.ts` | 失敗清單（sync-client 的 `failed` 表）文案；core 的列 → 畫面元件用的紀錄型別（`src/types.ts`） |
| `src/data/defaults.ts` | v1 的預設 Config，**只給 `../../legacy/test/gas-defaults.test.ts` 比對**；App 不用（v2 預設在 `packages/core`） |
| `src/data/network.ts` | 連線狀態與橫幅規則 |
| `src/data/catalog.ts` | 官方品項快照 + 本機 `ov:` 補填、`u:` 自建、`favorites`（不再有 `fav_ids`）、店家，合併成畫面清單 |
| `src/data/search.ts` | 本機搜尋索引與計分。`SearchHit.group` 的 `'store'` 是 7-11・全家區；篩選膠囊 `'store'` 是餐廳品項 |
| `src/data/loadstate.ts` | 載入五態與錯誤分類（`NET-0`、`API-<status>`、`unauthorized`） |
| `src/lib/day.ts`、`nutrition.ts`、`trends.ts` | 從 `packages/core` 轉出（App、Kyujin 的 summary 同一份算法）；`legacy/test` 仍從這裡引用，不要刪 |
| `src/lib/format.ts` | 文案與數字格式 |
| `../../legacy/gas/` | Apps Script 後端（v2 分支搬到 legacy）：`Code.gs`（API）、`Schema.gs`（欄位、預設值）、`Setup.gs`（初始化、密鑰）、`Trends.gs`、`appsscript.json`、合併檔 `FoodLog-AppsScript.gs` |
| `test/` | Vitest（前端測試）。GAS 測試在 `../../legacy/test/`：`gas-fakes.ts` 模擬 SpreadsheetApp、PropertiesService 等，讓 `legacy/gas/*.gs` 能在 Node 裡測；`gas-defaults`、`gas-trends-parity` 也在那裡（單向引用本目錄；本目錄不得 import `legacy/`）。food-log 不使用 Drive |
| `scripts/` | `build-catalog.mjs`、`fetch-fam-details.mjs`（`build-gas.mjs` 在 `../../legacy/scripts/`；部署腳本只在 `main`） |
| `public/catalog-v1.json` | 內建品項快照。repo 裡的 `version: "fixture"` 是示意；正式檔由 `build:catalog` 覆蓋 |
| `../../docs/spec/` | 技術規格 `v1.md`、`v1.1.md` |
| `../../docs/design/` | `DESIGN.md`、`tokens.css`、原型 `mock/` |
| `../../docs/kyujin-api.md` | Kyujin 範例請求 |
| `deploy/gas-url` | **只在 `main`**（`app/deploy/gas-url`）：目前的 `/exec` 網址（公開，不是秘密）。v2 分支沒有這個檔案 |

畫面元件只接收 props。只有 `src/app/data.tsx`（讀）、`src/data/actions.ts`（寫）和 features 的容器碰 sync-client。

## 設計與產品原則

- 設計系統以 [`../../docs/design/DESIGN.md`](../../docs/design/DESIGN.md) 為準：行動優先、繁中、石墨色。顏色、字體、間距只用 design token，不要寫死數值。
- 改色只改 `docs/design/mock/build.py` 再重跑；實作者**不要**改色，也不要改 `tokens.css` 的色票。
- token 來源是 repo 的 [`../../docs/design/tokens.css`](../../docs/design/tokens.css)。`dev`／`build` 會用 `../../packages/ui/scripts/sync-tokens.mjs` 自動同步到 `../../packages/ui/styles/tokens.css`；兩份都要 commit。`src/index.css` 以 `@import "@food-log/ui/styles.css"` 引入（該入口 `packages/ui/styles/index.css` 會引入 tokens，並用 `@source` 讓 Tailwind 掃 `packages/ui/src`）。
- `docs/design/mock/` 的原型只是參考，**`src/` 的 App 程式碼才是正本**。
- 範例或示意資料必須標明是示意；本機試用模式不可以產生假的飲食紀錄。
- 範圍先守住 v1。

## 資料模型與 API 合約

> **v2（階段 2 之後）**：資料在手機的 Dexie，前端只認 `packages/sync-client`（`SyncClient.mutate` 寫、hooks 讀）；同步協定與 mutation 目錄見 [`../../docs/plans/v2.md`](../../docs/plans/v2.md) §3，登入見 PRD §7。沒有 Apps Script 介面卡、沒有共享密鑰、沒有 `read_only`。下面這節是 v1 的欄位與 API 說明，只在讀 `legacy/` 時參考。

- Sheet 分頁與欄位定義在 `../../legacy/gas/Schema.gs` 的 `SCHEMA`，說明在 README 的「Sheet 分頁與欄位」和 `../../docs/spec/v1.md`。
- 五個分頁：Items（主鍵 `id`）、Logs（主鍵 `id`）、Weights（主鍵 `day`）、Stores（主鍵 `id`）、Config（主鍵 `key`）。Items 最後加 `store`；Logs 最後加 `source`、`store`。Items／Logs／Stores／Weights 的文字欄（含 `src`、`day`、`id`、`ts`、`updated_at`）寫入前要 `setNumberFormat('@')` 再 `setValues`。不要用 `appendRow` 寫這些分頁，否則試算表會把 `'7-11'` 和 `'YYYY-MM-DD'` 收成 Date。
- 前端一律 `POST`、`Content-Type: text/plain`，body 是 `{ secret, action, ... }`。action 有 `read`、`append`、`update`、`softDelete`、`restore`、`upsertItem`、`upsertStore`、`upsertWeight`、`setConfig`、`history`、`summary`、`trends`。參數與回傳見 README 的 API 表和 `../../legacy/gas/Code.gs` 檔頭。`history`、`summary`、`trends` 不進待送佇列。`read` 回 `stores`（沒有就當 `[]`）。
- 回應是 `{ ok: true, ... }` 或 `{ ok: false, error, message }`。`error` 代碼只有：`unauthorized`、`bad_json`、`bad_action`、`bad_table`、`bad_record`、`not_found`、`busy`、`server_error`、`forbidden`、`duplicate_name`、`schema_outdated`、`read_only`。
- 要加欄位時：改 `SCHEMA`，同步 `src/types.ts`、`src/data/codec.ts`、規格，加測試，跑 `npx -y pnpm@10 --filter @food-log/legacy build:gas`。已上線的 Sheet：後端第一次收到請求會在 LockService 裡自動 migrate，並把 `schema_version` 寫進 Config，之後跳過。編輯器的 `migrateFoodLog` 仍可用（只補缺的，不清資料、不碰密鑰）。`setupFoodLog` 也可以再跑，只補缺的表和 Config。**不要改既有欄位的名稱或順序**。骨架或錯誤空畫面不要用 `DEFAULT_CONFIG` 的 2000 去畫剩餘。

## 不可破壞的規則

1. **前端不放任何私密 token 或密鑰。** 登入靠 Better Auth 的 session cookie（passkey／一次性登入碼），前端沒有任何金鑰。`test/security.test.ts` 會掃原始碼和 `dist/`。`/exec` 網址不是密鑰，可以留在 `main` 的 `deploy/gas-url`。
2. **密鑰、token 都不進 repo。** repo 是公開的。
3. **寫入必須冪等。** 每筆紀錄的 `id` 在前端產生，後端遇到重複 id 視為成功。逾時後重送不能變成兩筆。例外只有體重：同一天第二筆新 id 會覆寫公斤數，Sheet 仍只有一筆未刪除的列；重送舊 id 不改儲存格。
4. **同步請求最長等 15 秒**（sync-client 的 `REQUEST_TIMEOUT_MS`）。寫入先進本機，不等網路（v1 的 55 秒已經沒有了）。
5. **離線佇列不能默默丟資料。** 送不出去的紀錄留在手機 IndexedDB。暫時失敗後依序等 2 秒、5 秒、15 秒各自動 `flush` 一次；三次之後等回到前景或 `online` 再試。永久錯誤不進這個計時器。
6. **連線橫幅**：瀏覽器 `navigator.onLine === false` 立刻顯示「連不到伺服器」。同步失敗一次不顯示；本機沒有伺服器資料且連續失敗 2 次才顯示。本機有資料時的同步失敗不顯示橫幅，用頂列 `SyncBadge`。寫入的 `NetworkError`（含 15 秒逾時）一次不把 `online` 設成 false、不顯示橫幅；同一筆留在佇列，依序再等 2 秒、5 秒、15 秒各試一次，三次都失敗才顯示橫幅。不要因為佇列裡有紀錄就把一次寫入失敗當成斷線。
7. **後端寫入用 `LockService` 包住（等 10 秒）**。飲食紀錄只 append 和軟刪除（`deleted=TRUE`）。
8. **`src/data/defaults.ts` 和 `legacy/gas/Schema.gs` 的預設值必須一致**，`legacy/test/gas-defaults.test.ts` 會比對。`theme` 不進 Sheet。
9. **`legacy/gas/FoodLog-AppsScript.gs` 是產生出來的**，改 `legacy/gas/*.gs` 後要跑 `npx -y pnpm@10 --filter @food-log/legacy build:gas`，`legacy/test/gas-merged.test.ts` 會檢查。
10. **`appsscript.json` 的授權範圍只有 `spreadsheets.currentonly`。** 不要加 Drive，不要加完整 `spreadsheets`。
11. **不要打全家 API。** 不要讀 `/workspace/food-research` 來找未寫進規格的欄位。不要執行 `fetch-fam-details.mjs`。
12. 每筆飲食紀錄的熱量、蛋白質、脂肪、碳水都是 ≥ 0 的有限數字。只有熱量的品項要先補三項營養素；面板關掉就什麼都不寫；後端拒收缺營養素的紀錄。
13. 台北日界線用 OFFSET 公式（`Date` + 8 小時再 `toISOString` slice），不要用會受機器時區影響的 `getDate()` / `Intl`。
14. 一週從週一起算。今天永遠不是「記錄不完整」。不要用負數表示超過（畫面寫「超過」）。

## 測試、建置與驗證

```bash
# 在 repo 根目錄執行（pnpm 沒有全域安裝，一律 npx -y pnpm@10）
npx -y pnpm@10 install
npx -y pnpm@10 -r test                         # 全部單元測試（前端 + legacy），必須全過
npx -y pnpm@10 --filter @food-log/app build    # tsc -b + vite build，必須沒有錯誤
npx -y pnpm@10 --filter @food-log/legacy build:gas   # 改過 legacy/gas/ 才需要
npx -y pnpm@10 --filter @food-log/app e2e      # 真實點擊；自己開 dev server，PLAYWRIGHT_DIR 預設已設，不下載瀏覽器
```

改動後的驗證：

1. `npx -y pnpm@10 -r test` 和 `npx -y pnpm@10 --filter @food-log/app build` 都通過。
2. 畫面有改的話，`npx -y pnpm@10 --filter @food-log/app dev` 用手機尺寸（例如 390×844）在本機試用模式走一次相關流程。
3. 不要在沒有 Brian 同意的情況下，用真實的 `/exec` 網址和密鑰寫入測試資料；真實 Sheet 是正式資料。
4. 部署前端（v1，`./scripts/deploy-gh-pages.sh`）**只能在 `main` 做**，v2 分支沒有這支腳本，不要從 v2 部署。之後打開 https://brian-konr.github.io/food-log/ 確認能載入。沒有 Brian 同意不要部署。
5. 改了 `legacy/gas/` 的話，前端部署不會更新後端；要請 Brian 在 `main` 照 README「更新程式碼」重新部署新版本。

預設測試環境是 `node`；只有 `*.test.tsx` 在檔案第一行寫 `// @vitest-environment jsdom`。

## 需要 Brian 本人操作的步驟

agent 做不到、也不應該嘗試繞過：

- 用 Brian 的 Google 帳號開新試算表、綁定 Apps Script。
- 在 Apps Script 編輯器貼上新程式碼、執行 `setupFoodLog` 或 `rotateSharedSecret`、授權 Google 權限。
- 部署或更新 Apps Script 網頁應用程式（「管理部署作業 → 編輯 → 新版本」可以維持網址不變）。
- 把 `/exec` 網址放進 `main` 的 `app/deploy/gas-url`。
- GitHub repo 設定：Pages 來源、Actions 權限、Secrets/Variables。
- 在 `main` 跑 `deploy-gh-pages.sh` 部署前端（v2 分支不放這支腳本）。

遇到這些步驟時，把要做的事和確切步驟寫給 Brian，然後停下來。

## v1 不做

衛福部資料、AI 照片、推薦、自動算目標、推播、多人、超過 4 週的趨勢。
