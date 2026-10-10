# food-log

Brian 用這個手機 PWA 記飲食與體重：今天還剩多少熱量／蛋白質、四週趨勢、自建品項。Kyujin 用同一個後端寫自建品項和體重，不能寫飲食紀錄。

線上版：https://brian-konr.github.io/food-log/

> 給 coding agent：請先讀 [`AGENTS.md`](AGENTS.md)。

## 架構

沒有我們自己的伺服器，全部是免費服務：

- **前端**：靜態 PWA（Vite、React、TypeScript、Tailwind v4、shadcn/ui、`vite-plugin-pwa`），放在 GitHub Pages，來源是本 repo 的 `gh-pages` 分支。
- **後端**：Brian 的 Google 帳號底下，一個綁定在 Google Sheet 上的 Apps Script，部署成網頁應用程式（網址結尾是 `/exec`）。
- **資料**：存在那份 Google Sheet。沒有照片、沒有 Drive。
- **保護**：`/exec` 網址是公開的（之後會放在 `deploy/gas-url`），每個請求都必須帶「共享密鑰」。密鑰只存在 Apps Script 的指令碼屬性和手機的瀏覽器裡，不進 repo，也不進 build 產物。

手機送出的紀錄會先存在手機的待送佇列，送成功才移除，所以離線或 Google 很慢時也不會遺失。

## 目錄

```
src/            前端（App.tsx 是唯一有狀態的容器；screens/、components/ 是只吃 props 的畫面）
src/api/        資料層：待送佇列（index.ts）、Apps Script 介面卡（gas.ts）、本機試用介面卡（mock.ts）
src/data/       Sheet 列轉換（codec.ts）、預設 Config、品項快照合併、搜尋、連線狀態
src/lib/        台北日界線、營養換算、趨勢、文案格式
gas/            Apps Script 後端：Code.gs、Schema.gs、Setup.gs、Trends.gs
                appsscript.json、FoodLog-AppsScript.gs（四個合併成一檔，方便貼上）
test/           Vitest 單元測試（含用假的 Apps Script 環境跑 gas/ 的程式）
scripts/        部署、合併 .gs、同步設計 token、建品項快照
public/         catalog-v1.json（示意快照）、icons/
deploy/         gas-url（目前的 /exec 網址；第一次部署後才放）
../docs/spec/   技術規格
../docs/design/ 設計系統 DESIGN.md、tokens.css、原型
../docs/kyujin-api.md  Kyujin 範例請求
```

## 本機開發

需要 Node.js 20.19 以上（Vite 8 的要求）。

```bash
npm ci
npm run dev        # http://localhost:5173
```

沒有設定 `VITE_GAS_URL`、也還沒在畫面上貼網址時，App 以「本機試用」模式執行：資料只存在這個瀏覽器，畫面會標「本機試用」，起始是空的飲食與體重（只有預設目標），沒有編造的紀錄。想連真的後端，就用 `VITE_GAS_URL="$(cat deploy/gas-url)" npm run dev`，第一次開啟時輸入共享密鑰（要向 Brian 拿）。注意這樣寫入的是真實資料。

`public/catalog-v1.json` 目前是 **4 筆示意**（`version` 為 `"fixture"`），讓本機搜尋看得到東西。正式檔由 `npm run build:catalog` 覆蓋，正式 `version` 為 `"2026-10-10"`。不要把示意檔當成完整目錄。

設計 token 的來源是 repo 的 `docs/design/tokens.css`；`npm run dev` 和 `npm run build` 之前會自動複製到 `src/styles/`。

## 測試與建置

```bash
npm test           # 單元測試：日界線、營養、趨勢、搜尋、目錄、待送佇列、Apps Script 後端、密鑰掃描
npm run build      # 型別檢查＋產出 dist/
npm run build:gas  # 改過 gas/*.gs 後重新產生 gas/FoodLog-AppsScript.gs（測試會檢查兩邊一致）
```

`npm run build` **不會**抓全家／7-11 目錄，也不打網路。

## 部署前端

```bash
./scripts/deploy-gh-pages.sh
```

這次實作**不要執行**。腳本會跑測試，讀 `deploy/gas-url` 當作 `VITE_GAS_URL`，用 `BASE=/food-log/` 建置，檢查產物裡沒有密鑰，再把 `dist/` 強制推到 `gh-pages` 分支。遠端頁面是 https://brian-konr.github.io/food-log/ 。

Kyujin 提醒連結是 `https://brian-konr.github.io/food-log/#weight`。

## Apps Script 後端

以下標 ⛔ 的步驟需要 Brian 本人的 Google 帳號，agent 不能代做。

### 第一次建立

1. ⛔ 用 Brian 的帳號新建一個 Google Sheet，開「擴充功能 → Apps Script」。
2. 把 `gas/FoodLog-AppsScript.gs` 的內容全部貼進 `程式碼.gs`（或分別貼 `Schema.gs`、`Setup.gs`、`Code.gs`、`Trends.gs`）。在「專案設定」勾選「在編輯器中顯示 appsscript.json」，把 `gas/appsscript.json` 貼進去。授權範圍只有 `spreadsheets.currentonly`，不要加 Drive。
3. ⛔ 選 `setupFoodLog` 執行，第一次會要求授權試算表。完成後在執行紀錄看共享密鑰，用聊天私下傳給自己和 Kazuha。不要把密鑰貼進 repo、issue 或公開地方。
4. ⛔「部署 → 新增部署作業 → 網頁應用程式」，執行身分選「我」，存取權選「任何人」。把結尾是 `/exec` 的網址寫進 `deploy/gas-url`，再部署前端。
5. GitHub Pages 用 `gh-pages` 分支，網站路徑 `/food-log/`。

`setupFoodLog` 可以重複執行：只補缺少的分頁、欄位和 Config key，不會清資料，也不會覆蓋已存在的設定。不要寫入示範飲食或示範體重。

### 更新程式碼（網址不變）

1. 改 `gas/` 裡的檔案，跑 `npm run build:gas` 和 `npm test`。
2. ⛔ 在 Apps Script 編輯器貼上新的 `gas/FoodLog-AppsScript.gs`（或對應的檔案）並存檔。
3. ⛔「部署 → 管理部署作業 → 選現有的部署 → 編輯（鉛筆）→ 版本選『新版本』→ 部署」。這樣 `/exec` 網址不會變，前端不用重新部署。
4. 如果 Schema 加了欄位，再執行一次 `setupFoodLog` 補上表頭。
5. 如果 `appsscript.json` 的授權範圍變了，執行任一函式時會再要求授權一次。
6. 只改前端：不用重部署 Apps Script。

如果改用「新增部署作業」，會得到新的網址，要更新 `deploy/gas-url` 並重新部署前端。

scriptId 留給 Brian 填，不要抄其他專案的 scriptId。

## 共享密鑰

- 密鑰存在 Apps Script「指令碼屬性」的 `SHARED_SECRET`，由 `setupFoodLog` 第一次執行時產生。
- 第一次開 App 時貼上 `/exec` 網址和密鑰，存在該手機瀏覽器的 localStorage（`foodlog.gasUrl`、`foodlog.secret`）。
- 每個請求的 body 都帶著密鑰，後端比對不符就回 `{ ok: false, error: "unauthorized" }`。
- 換密鑰：⛔ 在 Apps Script 執行 `rotateSharedSecret`，舊密鑰立刻失效，手機要到設定頁重新輸入。
- Kyujin 也用同一組密鑰，請求時加 `"client": "kyujin"`。範例見 [`../docs/kyujin-api.md`](../docs/kyujin-api.md)。

## Sheet 分頁與欄位

共同規則：人看得懂的值。布林寫 `TRUE` / `FALSE`。時間是含 `+08:00` 的 ISO 字串。空的選填數字寫空字串，讀回來變成 `null`。

**Items**（主鍵 `id`）

`id`, `ts`, `deleted`, `updated_at`, `kind`, `base_id`, `src`, `name`, `serving`, `serving_g`, `kcal`, `protein`, `fat`, `carb`, `fav`, `created_by`

- `kind`：`自建` 或 `補填`
- `id`：自建 `u:<uuid>`；補填 `ov:<官方 id>`，且 `base_id` = 那個官方 id
- `src`：`7-11`／`全家`／`其他`
- `created_by`：`app` 或 `kyujin`
- `fav`：只有自建品項使用。官方收藏不在這張表（在 Config `fav_ids`）

**Logs**（主鍵 `id`）

`id`, `ts`, `deleted`, `updated_at`, `day`, `item_id`, `name`, `src`, `qty`, `grams`, `kcal`, `protein`, `fat`, `carb`

- `ts` 是吃的時間。`day` 是台北日期 `YYYY-MM-DD`，由前端算好
- `name` 是當下的品名快照
- `kcal/protein/fat/carb` 是**這筆實際吃的量**（已換算、已四捨五入），不是每份
- 用份數時 `grams` 空著。用克數時 `grams` 有值，`qty` = `grams / servingG`
- 沒有 `who` 欄

**Weights**（主鍵 `day`，不是 `id`）

`day`, `ts`, `deleted`, `updated_at`, `kg`, `id`

一天最多一筆未刪除的列。`id` 仍由前端產生，放在最後一欄，用來做冪等。

**Config**（主鍵 `key`）

`key`, `value`, `updated_at`

預設（`defaults.ts` 和 `Schema.gs` 的 `DEFAULT_CONFIG` 必須完全一致，值都是字串）：

| key | value |
|---|---|
| `target_kcal` | `2000` |
| `target_protein` | `150` |
| `target_fat` | `60` |
| `target_carb` | `200` |
| `tdee` | 空字串 |
| `remind_meal_times` | 空字串 |
| `remind_weight_time` | 空字串 |
| `fav_ids` | 空字串 |

`theme` **不要**進 Sheet，只放 localStorage `foodlog.theme`。`setConfig` 只接受上表這些 key。

## API

前端一律 `POST` 到 `/exec` 網址，`Content-Type: text/plain`（避免 CORS 預檢），body 是 JSON：`{ secret, action, client?, ... }`。回應是 `{ ok: true, ... }` 或 `{ ok: false, error: "代碼", message }`。不帶參數的 `GET` 是健康檢查。

寫入包 `LockService.getScriptLock().tryLock(10000)`。拿不到回 `{ ok:false, error:'busy', message:'另一個人正在寫入，請再試一次' }`。讀取不加鎖。`updated_at` 一律由後端寫成台北現在時間。

錯誤碼只有：`unauthorized`、`bad_json`、`bad_action`、`bad_table`、`bad_record`、`not_found`、`busy`、`server_error`、`forbidden`。

`client`：Kyujin 送 `"kyujin"`。App 不送或送 `"app"`。

Logs 的 append/update 以及 upsertItem：四項營養素都要是有限數字且 ≥ 0。`null`、空字串、`NaN`、負數、Infinity、數字字串都回 `bad_record`。`0` 可以。

| action | 參數 | 說明 |
|---|---|---|
| `read` | `since?` | `version: 1`。Config、Items 全回（含已刪除）。Logs、Weights：`day >= 今天減 34 天`（共 35 天），含已刪除。有 `since` 時 Logs／Weights 再濾 `updated_at >= since` |
| `append` | `table:'Logs'`, `record` | 新增飲食紀錄。`id` 由前端產生，重複的 `id` 視為成功。Kyujin：`forbidden` |
| `update` | `table:'Logs'`, `id`, `patch` | 改份量、時間、營養素。不能改 `id`。Kyujin：`forbidden` |
| `softDelete` / `restore` | `table`, `id` | 軟刪除／復原。Weights 依列上的 `id`。Weights restore 時若該 `day` 已有未刪除列則 `bad_record`。Kyujin：`forbidden` |
| `upsertItem` | `record` | 自建 `u:` 或補填 `ov:`。不能改官方 `fm:`／`711:`。同一 `id` 再送是更新不是第二列。Kyujin 只能寫 `u:` 且 `created_by:kyujin`，不能改 App 建的品項 |
| `upsertWeight` | `record: { day, kg, id, ts }` | 同日新 id 覆寫公斤數、保留原 id；重送同一 id 不改儲存格。`kg` 30.0–250.0、最多一位小數 |
| `setConfig` | `key`, `value` | 設定頁存檔。Kyujin：`forbidden` |
| `history` | `table`, `before`, `limit?` | `Logs` 或 `Weights`。`day < before`，新到舊，預設 35、上限 90。不進待送佇列。Kyujin 可以呼叫 |
| `summary` | `day` | 該日未刪除 Logs 加總與剩餘。`remaining = target - total`，可以是負數（表示超過）。不進待送佇列。Kyujin 可以呼叫 |
| `trends` | `weekStart` | 必須是週一。回該週摘要，形狀與 `lib/trends.ts` 的 `weekSummary()` 相同。不進待送佇列。Kyujin 可以呼叫 |

體重覆寫：

1. 任一列（含已刪除）的 `id` 等於這次的 `id`：回 `{ ok:true, duplicate:true }`，不要改儲存格。
2. 否則若有該 `day` 且未刪除的列：只覆寫 `kg`、`ts`、`updated_at`，不要改 `id`。
3. 否則 append 新列。

復原覆寫：用**新的 id** 和舊的 `kg` 再送一次 `upsertWeight`。不要重用舊 id。

## Kyujin

外部客戶端，不是 App 裡的第二個畫面。請求加 `"client": "kyujin"`。可以：`read`、`summary`、`trends`、`history`、寫 `u:` 自建品項（`created_by` 必須是 `kyujin`）、`upsertWeight`。不可以：寫 Logs、補填 `ov:`、改官方品項、`setConfig`、改 App 建的 `u:` 品項、刪除。

範例請求見 [`../docs/kyujin-api.md`](../docs/kyujin-api.md)。`summary` 的 `remaining` 若為負數，表示當天已經超過目標；App 會顯示「超過」，不會顯示負號。

## 文件

- [`AGENTS.md`](AGENTS.md)：給 coding agent 的規則
- [`../docs/spec/v1.md`](../docs/spec/v1.md)：技術規格
- [`../docs/PRD.md`](../docs/PRD.md)：產品需求
- [`../docs/design/DESIGN.md`](../docs/design/DESIGN.md)：設計系統
- [`../docs/kyujin-api.md`](../docs/kyujin-api.md)：Kyujin API 範例
