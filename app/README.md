# food-log

Brian 用這個手機 PWA 記飲食與體重：今天還剩多少熱量／蛋白質、四週趨勢、自建品項與常吃店家。Kyujin 用同一個後端寫店家、店家品項、`source=kyujin` 的飲食紀錄、自建品項和體重。

線上版：https://brian-konr.github.io/food-log/

> 給 coding agent：請先讀 [`AGENTS.md`](AGENTS.md)。

## 架構

沒有我們自己的伺服器，全部是免費服務：

- **前端**：靜態 PWA（Vite、React、TypeScript、Tailwind v4、shadcn/ui、`vite-plugin-pwa`），放在 GitHub Pages，來源是本 repo 的 `gh-pages` 分支。
- **後端**：Brian 的 Google 帳號底下，一個綁定在 Google Sheet 上的 Apps Script，部署成網頁應用程式（網址結尾是 `/exec`）。
- **資料**：存在那份 Google Sheet。沒有照片、沒有 Drive。
- **保護**：`/exec` 網址是公開的（之後會放在 `deploy/gas-url`），每個請求都必須帶「共享密鑰」。密鑰只存在 Apps Script 的指令碼屬性和手機的瀏覽器裡，不進 repo，也不進 build 產物。

手機送出的紀錄會先存在 IndexedDB 待送佇列，送成功才移除，所以離線或 Google 很慢時也不會遺失。有快照就先畫快照並顯示「同步中」；沒有快照就畫灰條，不要出現預設的 2,000 kcal。

## 目錄

```
src/            前端（App.tsx 是唯一有狀態的容器；screens/、components/ 是只吃 props 的畫面）
src/api/        資料層：待送佇列（index.ts）、Apps Script 介面卡（gas.ts）、本機試用介面卡（mock.ts）
src/data/       Sheet 列轉換（codec.ts）、預設 Config、品項快照合併、搜尋、連線狀態、IndexedDB（kv.ts）、快照（cache.ts）、載入狀態（loadstate.ts）
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
npm run e2e        # 真實點擊（WebKit）。會自己開 dev server；瀏覽器沿用 PLAYWRIGHT_DIR，不下載
npm run deploy     # 前端 gh-pages（./scripts/deploy-gh-pages.sh）
npm run deploy:gas # 在 app/ build:gas，複製到 clasp/src/Code.js，clasp push 再 update-deployment
```

`npm run build` **不會**抓全家／7-11 目錄，也不打網路。`npm run deploy` 與 `npm run deploy:gas` 這次實作不要執行。

## 部署前端

```bash
npm run deploy
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

這次（v1.1）改了分頁、欄位、action、權限。只部署前端時，舊 `/exec` 沒有 `upsertStore`，也沒有新欄。Brian 或 Kazuha 按這個順序：

1. 開發機改 `app/gas/*.gs`，跑 `npm run build:gas` 與 `npm test`。合併檔是 `app/gas/FoodLog-AppsScript.gs`（不要手改）。
2. ⛔ 貼上編輯器，或在 app/ 跑 `npm run deploy:gas`。腳本會 `build:gas`，把 `gas/FoodLog-AppsScript.gs` 複製成 repo 根目錄 `clasp/src/Code.js`（保留 `clasp/src/appsscript.json`），先把 `clasp/src` 備份成 `clasp/src-bak-時間戳`，再用 `/home/box/.local/bin/clasp` 在 `clasp/` push，並對 `clasp deployments` 裡非 `@HEAD` 的正式部署做 `update-deployment`。不要改 `app/deploy/gas-url`。
3. ⛔ 在編輯器選 `migrateFoodLog` 按 Run（可選：後端第一次收到請求也會在 lock 裡自動 migrate，並把 `schema_version` 寫進 Config，之後跳過）。執行紀錄要看到第一次有建立 `Stores`、Items/Logs 補了欄；再跑一次是空陣列。不要跑 `rotateSharedSecret`。`setupFoodLog` 可以再跑，它只補缺的表和 Config，不重生密鑰。
4. ⛔「部署 → 管理部署作業 → 鉛筆 → 新版本」（`npm run deploy:gas` 已做這步就不用再按）。`/exec` 網址不變，不要改 `app/deploy/gas-url`。
5. ⛔ 前端用 `npm run deploy`。這次實作不要執行。

前端要容忍舊後端：`read` 沒有 `stores` 時當成 `[]`。`schema_outdated` 只會出現在自動 migrate 仍失敗時；畫面把錯誤代碼顯示出來。

v1.1.1 沒有新欄位，不要為了它跑 migrate；要更新 Apps Script 只是因為 Weights 的讀取窗口變了。

v1.1.3 沒有新欄位，但寫入改成純文字格式，**要重新部署 Apps Script**。部後端之後打兩次 health（`GET /exec` 不帶密鑰）：第一次的 `migration.textFixes` 是這次改寫的 day／src 格數，第二次必須是 0。不要跑 `rotateSharedSecret`，也不必在編輯器手動執行 `migrateFoodLog`（後端第一次請求會自動跑）。只部署前端不會停止試算表把 `7-11` 和日期轉成 Date。

v1.1.4 沒有新欄位，不要跑 migrate，不要跑 `rotateSharedSecret`。`softDelete` 改成冪等：App 刪一個不存在或已經刪除的 id 回 `{ ok: true }`，不改儲存格。Kyujin 的 forbidden 不變（刪不到的 Logs、店家、品項、體重仍是 forbidden）。**要重新部署 Apps Script**，否則舊 `/exec` 仍對找不到的 id 回 `not_found`。前端會把 softDelete 的 `not_found` 當成成功，並在打開時清掉舊的失敗刪除，所以只部署前端也能止住「每次打開都 toast」；仍請先部後端、再部前端。部署後不必看 health 的 `textFixes`，也不必手動跑 `migrateFoodLog`。

授權範圍維持 `spreadsheets.currentonly`。不要加 Drive。

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

`id`, `ts`, `deleted`, `updated_at`, `kind`, `base_id`, `src`, `name`, `serving`, `serving_g`, `kcal`, `protein`, `fat`, `carb`, `fav`, `created_by`, `store`

- `kind`：`自建` 或 `補填`
- `id`：自建 `u:<uuid>`；補填 `ov:<官方 id>`，且 `base_id` = 那個官方 id
- `src`：`7-11`／`全家`／`其他`
- `created_by`：`app` 或 `kyujin`
- `fav`：只有自建品項使用。官方收藏不在這張表（在 Config `fav_ids`）
- `store`：店家品項＝`Stores.id`；一般自建／補填＝空。店家品項必須 `kind=自建`、`src=其他`、`id` 以 `u:` 開頭、`serving='1 份'`

**Logs**（主鍵 `id`）

`id`, `ts`, `deleted`, `updated_at`, `day`, `item_id`, `name`, `src`, `qty`, `grams`, `kcal`, `protein`, `fat`, `carb`, `source`, `store`

- `ts` 是吃的時間。`day` 是台北日期 `YYYY-MM-DD`，由前端算好
- `name` 是當下的品名快照。快速記錄允許空名
- `kcal/protein/fat/carb` 是**這筆實際吃的量**（已換算、已四捨五入），不是每份
- 用份數時 `grams` 空著。用克數時 `grams` 有值，`qty` = `grams / servingG`
- `source`：`app`（舊列空值也算 `app`）／`quick`／`kyujin`
- `store`：記下去當下的 `Stores.id`，可空。改品項營養素時不要回寫這欄
- 快速記錄：`item_id` 空、`qty` 固定 1、不建立 Items 列
- 沒有 `who` 欄

**Stores**（主鍵 `id`）

`id`, `ts`, `deleted`, `updated_at`, `name`, `last_eaten_at`, `created_by`

- `id`：`s:` + uuid
- `last_eaten_at`：有帶 `store` 的 Log append 時更新成較新的那個 `ts`，不要往回撥
- 刪店會連帶軟刪該店未刪除品項；復原只還原同一 `updated_at` 的品項。Logs 不動

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

錯誤碼只有：`unauthorized`、`bad_json`、`bad_action`、`bad_table`、`bad_record`、`not_found`、`busy`、`server_error`、`forbidden`、`duplicate_name`、`schema_outdated`。

`client`：Kyujin 送 `"kyujin"`。App 不送或送 `"app"`。

Logs 的 append/update 以及 upsertItem：四項營養素都要是有限數字且 ≥ 0。`null`、空字串、`NaN`、負數、Infinity、數字字串都回 `bad_record`。`0` 可以。

| action | 參數 | 說明 |
|---|---|---|
| `read` | `since?` | `version: 1`。Config、Items、Stores 全回（含已刪除）。Logs：`day >= 今天減 34 天`（共 35 天），含已刪除。Weights：`day >= 今天減 89 天`（共 90 天），含已刪除。有 `since` 時 Logs／Weights 再濾 `updated_at >= since`。回應含 `weightDays: 90`；舊後端沒有這個欄位時前端不要當成失敗。沒有 `stores` 時前端當 `[]` |
| `append` | `table:'Logs'`, `record` | 新增飲食紀錄。`id` 由前端產生，重複的 `id` 視為成功。Kyujin 必須 `source:'kyujin'` |
| `update` | `table:'Logs'`, `id`, `patch` | 改份量、時間、營養素、品名。不能改 `id`、`source`、`store`、`item_id`。Kyujin 只能改 `source=kyujin` 的列 |
| `softDelete` / `restore` | `table`, `id` | 軟刪除／復原。Weights 依列上的 `id`。Weights restore 時若該 `day` 已有未刪除列則 `bad_record`。`Stores` 會連帶品項。Kyujin 不能刪／復原店家；Logs 僅限 `source=kyujin` |
| `upsertItem` | `record` | 自建 `u:` 或補填 `ov:`。不能改官方 `fm:`／`711:`。同一 `id` 再送是更新不是第二列。`store` 非空時必須是未刪除店家。Kyujin 可改店家品項（含 App 建的）；沒有店家時只能寫自己的 `u:` |
| `upsertStore` | `record: { id, name, ts?, created_by? }` | 新建或改名。`id` 以 `s:` 開頭。重複店名（NFKC／標點正規化後相同）回 `duplicate_name`。Kyujin 新建必須 `created_by:kyujin`；改名保留原本 `created_by` |
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

外部客戶端，不是 App 裡的第二個畫面。請求加 `"client": "kyujin"`。可以：`read`、`summary`、`trends`、`history`、`upsertStore`（新建 `created_by:kyujin`，可改 App 店名）、店家品項 `upsertItem`（含 App 建的）、寫／改／刪 `source=kyujin` 的 Logs、寫自己建的沒有店家的 `u:`、`upsertWeight`。不可以：刪／復原店家、動 `app`／`quick` 的 Logs、改沒有店家的 App `u:`、補填 `ov:`、改官方品項、`setConfig`。

範例請求見 [`../docs/kyujin-api.md`](../docs/kyujin-api.md)。`summary` 的 `remaining` 若為負數，表示當天已經超過目標；App 會顯示「超過」，不會顯示負號。

## 文件

- [`AGENTS.md`](AGENTS.md)：給 coding agent 的規則
- [`../docs/spec/v1.md`](../docs/spec/v1.md)、[`../docs/spec/v1.1.md`](../docs/spec/v1.1.md)：技術規格
- [`../docs/PRD.md`](../docs/PRD.md)：產品需求
- [`../docs/design/DESIGN.md`](../docs/design/DESIGN.md)：設計系統
- [`../docs/kyujin-api.md`](../docs/kyujin-api.md)：Kyujin API 範例
