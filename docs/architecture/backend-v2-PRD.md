# 後端 v2 PRD：food-log 改成本機優先 + Cloudflare Workers

| 項目 | 內容 |
|---|---|
| 文件版本 | v2.1（2026-10-15 依施工計畫修正：D1 交易、CPU 限制、登入碼、favorites/config 版本號、分支策略）。v2.0 取代 2026-10-11 的 v1.0「Supabase + Cloudflare」草案，舊版留在 git 歷史 |
| 日期 | 2026-10-15（台北時間） |
| 產品負責人 | Brian |
| 狀態 | **方向已確認**（Brian 2026-10-15 核准施工計畫 [`docs/plans/v2.md`](../plans/v2.md)）；第 15 節列出仍待決的事項 |
| 範圍 | 只有 food-log。sicily-care 之後另寫 PRD，沿用這份的共用套件 |
| 架構圖 | [`backend-v2-architecture.html`](backend-v2-architecture.html) |
| 依據 | `docs/PRD.md` v1.5、`app/README.md`、`app/gas/Code.gs`（現行業務規則）、`docs/kyujin-api.md` |

> 標記說明：**（估計）** 表示推估值。價格與免費額度是 2026-10-15 查到的官方資料，實作前要再確認一次。

---

## 1. 背景與問題

### 1.1 現況

- **前端**：React 19 + Vite + Tailwind + shadcn 的 PWA，放在 GitHub Pages。已經有 IndexedDB 待送佇列、樂觀寫入、快照。
- **後端**：Apps Script `/exec` + Google Sheet，約 800 行業務規則（`Code.gs`），有 vitest 測試。
- **驗證**：手機上手動貼 `/exec` 網址和共享密鑰；Kyujin 用同一把密鑰，自己帶 `client:"kyujin"`。

### 1.2 問題

1. **慢**：Apps Script 冷啟動可能要數十秒，前端逾時只好設成 55 秒。
2. **設定畫面不好用**：換手機要重貼網址和密鑰；密鑰外流就能寫入全部資料。
3. **沒有真正的身分**：後端分不出是 App 還是 Kyujin，`client:"kyujin"` 是自己報的。
4. **資料完整性**：Sheet 沒有型別，`7-11`、日期、提醒時間會被自動轉成 Date，要靠 `setNumberFormat('@')` 和遷移腳本補救。
5. **規則分散**：趨勢計算在 `Trends.gs` 和 `src/lib/trends.ts` 各寫一份；前端的驗證和後端又各寫一份。
6. **加功能成本高**：加一個欄位要改 `SCHEMA`、`codec.ts`、`types.ts`、遷移邏輯，還要請 Brian 手動部署 Apps Script。

### 1.3 和 v1.0 草案的差異

| 主題 | v1.0（Supabase） | v2.0（本文件） | 理由 |
|---|---|---|---|
| 資料庫 | Supabase Postgres（免費方案） | Cloudflare D1（SQLite） | 免費 Supabase 7 天沒活動會暫停、沒有自動備份；D1 不會暫停，有 7 天 Time Travel |
| 業務規則 | RLS + trigger + Worker + 前端，分四處 | 一份 TypeScript mutators，前端和 Worker 共用 | 加功能只改一個地方 |
| 同步 | 前端直接寫表，以列為單位 LWW | 同步「動作」（mutation），伺服器說了算 | 保留使用者意圖（刪店連帶刪品項、體重覆寫） |
| 游標 | trigger 寫 `updated_at = now()` | 伺服器遞增版本號 | `now()` 是交易開始時間，並行寫入會漏資料 |
| 登入 | Google OAuth | passkey，加一次性登入碼（第 7.1 節） | iOS 主畫面 PWA 和 Safari 儲存分開，OAuth 跳轉可能回不到 PWA |
| 前端託管 | Cloudflare Pages | Worker static assets，同一個 Worker | Cloudflare 新專案建議用 Workers；同網域不用處理 CORS |
| 網域 | 先買網域 | 先用 `workers.dev` | 不是解決問題的必要條件 |
| 廠商 | Supabase + Cloudflare + Google Cloud | 只有 Cloudflare | 維運面最小 |

## 2. 目標／非目標

### 2.1 目標

- **G1 不等後端**：打開 App 立刻顯示本機資料；記一筆在 100 ms 內反映在畫面上，離線也能記，恢復連線後自動送出，不重複、不遺失。
- **G2 規則只有一份**：所有寫入都是有名字的 mutation，定義在 `packages/core`。前端樂觀執行一次，Worker 在 D1 交易裡權威執行一次。summary、trends 的計算也只有一份。
- **G3 真正的身分**：Brian 用 passkey 登入，不再貼網址和密鑰。Kyujin 有自己的 API key 和 scope，權限在伺服器判斷。
- **G4 有型別的資料**：D1 表有 CHECK 約束；API 輸入用 zod 驗證；型別從資料庫一路檢查到 UI。
- **G5 沒人照顧也不會壞**：不會被暫停；每天自動匯出；有還原演練。
- **G6 好加功能**：加一個欄位或一個動作，只需要改 schema、mutation、UI 和測試，部署是一個指令。
- **G7 遷移不卡功能**：切換前，現行版本照常可以改和部署。

### 2.2 非目標

- 這次不改產品功能和 UI 風格。例外是登入畫面、遷移提示，以及拿掉「後端連線設定」畫面。
- 不做 SSR，前端維持純靜態 PWA。
- 不做多人、推播、新的 AI 功能。
- 不搬 sicily-care。monorepo 和共用套件會預留它的位置。
- 不升級付費方案，除非第 13 節的條件出現。
- 不買網域。之後要換網域時，passkey 要重新註冊一次（第 15 節）。

## 3. 使用者與權限

| 角色 | 身分 | 可以做的事 |
|---|---|---|
| Brian（`owner`） | passkey 登入；email 在允許清單上 | 所有 mutation、讀取全部資料 |
| Kyujin（`bot`） | API key，帶 scope | 見第 3.1 節 |
| Cron（`system`） | Worker 內部 | 唯讀匯出 |
| 其他人 | 就算拿到網址 | 無法註冊；沒有 session 的請求一律 401 |

### 3.1 Kyujin 權限矩陣

沿用 `kyujin-api.md` 和 `Code.gs` 的規則，搬到 `packages/core` 的權限函式裡，用表格式測試覆蓋每一格。

| 動作 | Kyujin | 錯誤 |
|---|---|---|
| 讀取、summary、trends、history | ✅ | — |
| 新增或改名店家 | ✅ 新建時 `created_by=kyujin`；改名保留原本的 `created_by` | — |
| 刪除或復原店家 | ❌ | `forbidden` |
| 店家品項 upsert（含 App 建的） | ✅ | — |
| 沒有店家的 `u:` 品項 | 只能寫自己建的 | `forbidden` |
| `ov:` 補填、官方 `fm:`／`711:` | ❌ | `forbidden` |
| Logs 新增、修改、刪除、復原 | 只限 `source=kyujin` | `forbidden` |
| 改 Log 的 `source` | ❌ | `bad_record` |
| 體重 upsert | ✅ | — |
| 體重刪除、復原 | ❌ | `forbidden` |
| 設定 | ❌ | `forbidden` |

## 4. 架構總覽

```
iPhone PWA（Worker static assets，同網域）
  UI ─ useLiveQuery ─ Dexie（已確認狀態 + 待送 mutations）
                        │ POST /sync/push  [{clientId, mutationId, name, args}]
                        │ GET  /sync/pull  ?cookie=<版本號>
                        ▼
Worker（Hono）── Better Auth（passkey / 一次性登入碼 / bot API keys）
  ├ mutators 在 D1 交易裡執行（packages/core，前後端同一份）
  ├ /bot/*  Kyujin：OpenAPI；MCP 列為之後再做
  └ Cron    每日匯出到 R2
D1（food-log 一個資料庫）    R2（每日匯出）
```

### 4.1 元件與職責

| 元件 | 職責 | 不做的事 |
|---|---|---|
| `apps/food-log` | PWA：畫面、Dexie、同步迴圈、Service Worker | 不放機密 |
| `packages/core` | zod schema、mutators、權限、營養與趨勢計算、台北日界線 | 不碰 I/O；只透過注入的 `Tx` 介面讀寫 |
| `packages/sync-client` | Dexie 資料庫、待送佇列、push/pull、rebase、`useLiveQuery` hooks | 不含業務規則 |
| `workers/api` | Hono 路由、Better Auth、`/sync`、`/bot`、Cron、static assets | 不另外寫一份業務規則 |
| D1 | 資料、版本號、每台裝置處理到第幾個 mutation、auth 表 | — |
| R2 | 每日匯出（JSON），之後 sicily-care 的照片 | — |

### 4.2 Repo 結構

```
apps/food-log/          現在的 app/ 搬過來
packages/core/
packages/sync-client/
packages/ui/            shadcn 元件、design tokens（之後 sicily-care 共用）
workers/api/
docs/
```

用 pnpm workspaces 管理。`catalog-v1.json` 繼續當靜態檔，和 PWA 一起由 Worker 提供。

## 5. 同步模型

### 5.1 原則

- **伺服器說了算**：前端送出的是動作，不是列。
- **前端產生 id**：`u:`、`s:`、`ov:`、UUID 等格式不變，離線新增也不用改。
- **畫面只讀本機**：Dexie 的內容 = 伺服器最後確認的狀態 + 重播還沒確認的 mutations。

### 5.2 Push

1. 前端在同一個 Dexie 交易裡：寫入 mutation 到待送佇列，並在本機執行 mutator → 畫面立刻更新。
2. 待送佇列依序送到 `POST /sync/push`。每筆帶 `clientId`（每個安裝一個 UUID）和遞增的 `mutationId`。
3. Worker 對每筆 mutation：
   - 驗證 session 和 zod schema。
   - `mutationId <= lastMutationId[clientId]` → 已處理過，跳過（冪等）。
   - 執行 mutator，用一個 D1 batch 原子提交：資料、版本號 +1、`lastMutationId`。
   - **D1 沒有互動式交易**（不能 `BEGIN` → 讀 → 跑 JS → `COMMIT`，只有 `db.batch()` 是原子的）。所以 mutator 先讀、把寫入放進緩衝區，batch 的第一句用 `cas_guard` 表比對 `meta.version` 是否仍是讀到的值（樂觀並行控制）；比對失敗就重讀重試，最多 5 次，之後當暫時性錯誤。部分唯一索引在資料庫層再擋一次。階段 0 驗證；不可行時改用 SQLite-backed Durable Object。
   - 失敗：
     - 業務錯誤（`bad_record`、`forbidden`、`duplicate_name`…）：記錄錯誤，`lastMutationId` 照樣前進，前端在 UI 提示。
     - 暫時性錯誤：整批中止，前端退避重試。

### 5.3 Pull

- `GET /sync/pull?cookie=<版本號>` 回傳 `version > cookie` 的所有變更，包含軟刪除的 tombstone，以及這台裝置的 `lastMutationId`。
- 前端套用變更，丟掉已確認的待送 mutations，再重播剩下的。
- 第一次登入時 `cookie=0`：拉全部資料，一年不到 1 萬列（估計）。現在的「Logs 35 天、Weights 90 天」窗口只保留給 Bot API。
- **一律分頁**：Workers 免費方案每個請求只有 10 ms CPU，所以每頁約 2,000 列，只在版本號之間切；回應帶 `more`。
- cookie 是 `<epoch>:<version>`。從備份還原或重新匯入時寫入新的 epoch，pull 看到 epoch 不同就回 `reset:true` 讓前端重拉。

### 5.4 版本號

- `meta` 表裡一個全域計數器。每個寫入交易遞增一次，寫進受影響列的 `version` 欄。
- 版本號只在 CAS 保護的 batch 裡遞增，一定照提交順序增加，pull 不會漏資料。

### 5.5 觸發時機

- iOS 沒有 Background Sync。以下時機會 push，再接著 pull：
  - 打開 App
  - 回到前景（`visibilitychange`）
  - 恢復連線（`online`）
  - 每次本機寫入之後
  - 前景時每 60 秒一次
- 暫時性失敗依序等 2、5、15 秒重試，沿用現在的規則；之後等下一個觸發時機。

### 5.6 衝突

- mutation 在伺服器上**依抵達順序**重新執行，所以重播時看到的是最新狀態。例如：已經被刪除的 Log 不能再修改，會回 `ignored: deleted`，行為和現在一樣。
- 體重同一天的覆寫、刪店連帶刪品項、`last_eaten_at` 只能往後更新，這些規則都寫在 mutator 裡，不需要另外的衝突策略。

### 5.7 版本相容

- PWA 可能被 Service Worker 快取住，舊版本會繼續送 mutation。
- 每個 mutation 名稱帶版本（例如 `logs.add@1`）。Worker 同時支援目前版和前一版。
- `/sync/pull` 回傳 `minClientVersion`。太舊的前端顯示「有新版本」，按一下重新載入。
- D1 migration 用 expand → contract：先加新欄或新表，等舊前端都更新後才移除舊的。

### 5.8 本機儲存

- 第一次登入後呼叫 `navigator.storage.persist()`。
- 登出時清空 Dexie。如果還有沒送出的 mutations，先提示使用者。

## 6. 資料模型（D1）

### 6.1 共同原則

- 業務表都有這幾欄：
  - `user_id`（目前只有 Brian，保留給 sicily-care 的模式）
  - `version INTEGER NOT NULL`
  - `deleted_at TEXT NULL`
  - `created_by TEXT CHECK (created_by IN ('app','kyujin'))`
- 時間：`ts` 是含 `+08:00` 的 ISO 字串，`day` 是 `YYYY-MM-DD`。兩者都用 CHECK 檢查格式，而且 `day` 必須等於 `ts` 的台北日期。
- 選項值沿用現在的中文：`src IN ('7-11','全家','其他')`、`kind IN ('自建','補填')`，匯出的檔案人看得懂。
- 用 `STRICT` 表。schema 和 migration 由 Drizzle 管理，放在 `workers/api/migrations/`，資料庫可以從空的狀態重建。

### 6.2 表

| 表 | 主要欄位 | 規則 |
|---|---|---|
| `items` | `id pk, kind, base_id, src, name, serving, serving_g, kcal, protein, fat, carb, store_id, created_by, ts` | `ov:` 必須 `kind=補填`、`base_id` 等於官方 id；`u:` 必須 `kind=自建`；店家品項 `src=其他`；營養素是 ≥ 0 的有限數字 |
| `stores` | `id pk, name, last_eaten_at, created_by, ts` | 未刪除的店名經 NFKC 正規化後唯一（`duplicate_name`） |
| `logs` | `id pk, day, ts, item_id, name, src, qty, grams, kcal, protein, fat, carb, source, store_id` | `source IN ('app','quick','kyujin')`；快速記錄 `item_id` 空、`qty=1`、`grams` 空；不能是未來日期 |
| `weights` | `id pk, day, ts, kg` | **部分唯一索引** `unique(user_id, day) where deleted_at is null`；`kg` 30.0–250.0、最多一位小數 |
| `favorites` | `user_id, item_id, pk(user_id,item_id)`，加上共同欄位 `version`、`deleted_at` | 取代 Config `fav_ids` 和 `items.fav`，官方和自建品項用同一張表；取消收藏用 `deleted_at`，pull 才帶得走 |
| `config` | `user_id pk, target_kcal, target_protein, target_fat, target_carb, tdee, remind_meal_times(JSON), remind_weight_time, version` | 有型別的欄位，範圍檢查沿用 `setConfig_` |
| `meta` | `key pk, value` | 全域版本號、epoch |
| `cas_guard` | `ok INTEGER CHECK (ok = 1)` | batch 的樂觀並行比對用（第 5.2 節） |
| `login_codes` | `code_hash pk, user_id, expires_at, used_at` | 一次性登入碼，只存 SHA-256 hash |
| `sync_clients` | `client_id pk, user_id, last_mutation_id, last_seen_at` | push 冪等 |
| `mutation_errors` | `client_id, mutation_id, name, error, message, at` | 業務錯誤留紀錄，前端拿來提示 |
| Better Auth 表 | user、session、passkey、apikey… | 由 Better Auth 產生 |

- 官方品項（`fm:`、`711:`）不進 D1，繼續放在 `catalog-v1.json`。Bot API 需要查官方品項時，Worker 讀同一份靜態檔。

## 7. 認證與安全

### 7.1 Brian 登入

- **Better Auth**，跑在 Worker + D1 上。
- **主要方式**：passkey（WebAuthn）。iPhone 用 Face ID，換手機時透過 iCloud Keychain 同步。
- **一次性登入碼（已定案）**：由 Brian 在電腦上用 `wrangler` 指令產生，15 分鐘有效、只能用一次，D1 只存 hash。不需要寄信服務。
  - Better Auth 的 passkey 只能在已登入時註冊，所以第一次登入一定要用登入碼，之後再註冊 passkey。
  - passkey 遺失、換手機沒同步到時，也用登入碼登入再重新註冊。
- **RP ID**：`workers.dev` 在 Public Suffix List 上，passkey 的 RP ID 是完整的 worker 主機名。
- **允許清單**：只有允許清單上的 email 可以註冊；其他人註冊一律拒絕。
- **Session**：同網域、`HttpOnly`、`Secure`、`SameSite=Lax` 的 cookie。
- **⚠️ 階段 0 的前提**：要先在 iPhone 主畫面 PWA 裡實測 passkey 能不能註冊和登入。不行的話，一次性登入碼改成主要方式。

### 7.2 Kyujin

- 用 Better Auth API key 外掛，給一把帶 scope 的 key：`foodlog:read`、`foodlog:write.kyujin`。
- **存放**：
  - 資料庫只存 hash。
  - key 放在共用電腦的 `~/.config/studio/bots/kyujin.env`，權限 600。
  - 不進 git、不進前端、不貼在聊天裡。
- **撤銷**：撤銷後下一個請求就回 `unauthorized`。輪替時先發新 key，換上之後再撤銷舊的。

### 7.3 機密放在哪裡

| 機密 | 位置 |
|---|---|
| Better Auth secret | `wrangler secret put` |
| Kyujin API key | 共用電腦 600 權限檔；D1 只存 hash |
| Cloudflare API token（部署用，只限 Workers 權限） | Brian 的密碼管理器；CI 用時放 GitHub Actions secret |
| 允許清單 `ALLOWED_EMAILS` | `wrangler secret put`（不寫進 repo） |

- 沿用現有規則：前端和 repo 不放任何密鑰，`security.test.ts` 繼續掃原始碼和 build 產物。

## 8. Bot API

- **Base URL**：`https://<worker>.<account>.workers.dev/bot/v1/...`
- **驗證**：`Authorization: Bearer <api key>`。
- **原則**：
  - 對外語意盡量和 `kyujin-api.md` 一樣，Kyujin 只需要換網址、換 key、換請求格式。
  - 寫入一律走同一份 mutators，actor 是 `kyujin`。
- **錯誤碼**：沿用 `forbidden`、`bad_record`、`duplicate_name`、`not_found`，再加 `unauthorized`。
- **OpenAPI**：由 zod schema 自動產生，放在 `/bot/v1/openapi.json`。
- **MCP**：列為之後再做。

| Endpoint | 說明 |
|---|---|
| `GET /bot/v1/read` | Items、Stores、Config 全給（含已刪除）；Logs 往回 35 天；Weights 往回 90 天 |
| `GET /bot/v1/summary?day=` | totals、targets、remaining（可以是負數），用 `packages/core` 計算 |
| `GET /bot/v1/trends?weekStart=` | 週摘要，必須是週一 |
| `GET /bot/v1/history?table=&before=&limit=` | 語意同現有 `history` |
| `POST /bot/v1/mutate` | `{ name, args }`，例如 `stores.upsert`、`items.upsert`、`logs.add`、`logs.update`、`logs.delete`、`logs.restore`、`weights.upsert` |

## 9. 前端

- **技術**：沿用 React 19、Vite、Tailwind v4、shadcn/ui、vite-plugin-pwa。新增 TanStack Router（型別安全的路由，保留 `#weight` 深連結）和 Dexie。
- **結構**：`App.tsx`（目前 744 行，所有狀態都在這裡）拆成依功能分的資料夾。畫面元件透過 hooks 讀 Dexie，不直接呼叫網路。
- **保留 v1.5 的載入與連線規則**：
  - 有本機資料就直接畫，並顯示同步狀態。
  - 沒有本機資料時用骨架畫面，不顯示 2,000 kcal 這類假數字。
  - 寫入失敗的提示和重試沿用現在的文案。
- **拿掉**：「後端連線設定」畫面、`foodlog.gasUrl`／`foodlog.secret`、55 秒逾時，以及只為 Sheet 存在的轉換（例如 `normalizeSheetSrc`）。
- **新增**：登入畫面、遷移提示、「有新版本」提示。由 Winter 設計，沿用 `docs/design/` 的 token。
- **本機試用模式**：沒有登入時保留，用純本機的 Dexie，不連 Worker。

## 10. 備份與維運

| 項目 | 頻率 | 位置 |
|---|---|---|
| D1 Time Travel | 自動，保留 7 天（免費方案） | Cloudflare |
| 每日匯出（每張表一份 JSON，加一份 CSV） | 每天 04:00 台北時間，由 Cron 執行 | R2 `exports/YYYY-MM-DD/` |
| 異地備份 | 每週 | 待決（第 15 節）：GitHub 私有 repo 或共用電腦 |
| 還原演練 | 每季一次；第一次在切換前完成 | 從匯出檔還原到空的 D1，比對列數和每日加總 |

- **觀測**：
  - Workers Logs。
  - 前端錯誤送到 `/telemetry/error`，只記錯誤碼和版本，不記飲食內容。
  - `mutation_errors` 有新紀錄時，在 App 設定頁顯示。
- **不需要 keep-alive**：D1 不會因為沒活動而暫停。

## 11. 遷移與切換

### 11.1 原則

- 新系統在**長期 `v2` 分支**（用 `git worktree` 開發）、獨立的 `workers.dev` 網址開發。`main` 只放 v1 修正，部署方式不變；v1 修正定期合併進 `v2`。舊系統（GitHub Pages + Apps Script）照常是正式環境，直到切換。
- 切換時 `v2` 合併回 `main`，並打 tag `v1-final` 供回滾。
- 每個階段都要能回滾。舊系統在切換後保留至少 30 天。

### 11.2 從 Sheet 匯入

1. 用現有的 `read` 和 `history` 拉全部資料。不受 35 天和 90 天窗口限制：用 `history` 往回翻到底。
2. 轉換：
   - `deleted` 轉成 `deleted_at`
   - `fav_ids` 和 `items.fav` 轉成 `favorites`
   - Config key/value 轉成有型別的欄位
   - 把 Sheet 自動轉成 Date 的格修回文字
3. 匯入腳本可以重跑（冪等，依 id upsert）。
4. 比對：每張表的列數、每天的熱量和營養素加總、Config 的每個值。

### 11.3 切換

1. **雙軌期**：新系統用匯入的副本，Brian 試用，包括 iPhone 主畫面的 passkey 登入。這段期間可以重複匯入。
2. **切換當天**：
   1. 把 Apps Script 設成唯讀：寫入回 `read_only`。
   2. 確認舊 App 的待送佇列已經清空。
   3. 最後匯入一次並比對。
   4. 把 Kyujin 換到新的 Bot API 和 key，舊的共享密鑰停用。
   5. Brian 打開新網址、登入、重新加到主畫面，確認今天的資料都在。
   6. GitHub Pages 換成提示頁，導向新網址。
   7. Kyujin 提醒裡的 `#weight` 連結改成新網址。
3. 切換後觀察兩週，每天都要匯出成功。

### 11.4 回滾

- **觸發條件**：資料錯誤、無法登入、同步異常，而且當下修不好。
- **步驟**：
  1. Apps Script 改回可寫。
  2. 用反向匯出腳本，把切換後新增或修改的紀錄重播成 Apps Script 的 action。Apps Script 依 id 冪等，所以可以重跑。
  3. GitHub Pages 恢復成舊前端。
  4. Kyujin 換回舊設定。
- **目標**：30 分鐘內回到舊系統（估計）。反向匯出腳本要在雙軌期就寫好、測好。

## 12. 驗收標準

**登入與權限**

1. 沒有「後端連線設定」畫面。在 iPhone 主畫面的 PWA 裡可以用 passkey 登入，並保持登入。實測的過期行為要記錄下來。
2. 不在允許清單上的 email 無法註冊。沒有 session 的 `/sync/*` 一律 401。
3. 第 3.1 節權限矩陣的每一格都有自動化測試，而且結果和 `kyujin-api.md` 的允許、禁止案例一致。
4. 撤銷 Kyujin 的 key 之後，下一個請求就回 `unauthorized`。
5. 前端 bundle 和 git 裡沒有任何密鑰（`security.test.ts` 通過）。

**同步與離線**

6. 記一筆時，畫面在 100 ms 內更新，不必等網路。
7. e2e 測試涵蓋：離線記三筆 → 恢復連線 → 伺服器剛好三筆，不重複、不遺失。
8. 同一個 mutation 送兩次（模擬逾時重送），伺服器只生效一次。
9. 兩台裝置交錯寫入後，兩邊 pull 完的資料一致。
10. 冷啟動時，任何時間點都不會出現和真實資料不一致的數字（v1.5 的驗收標準）。
11. 舊版前端送出前一版的 mutation 仍然成功；更舊的前端看到「有新版本」提示。

**資料與遷移**

12. 匯入後，每張表的列數、每天的營養素加總、每個 Config 值都和 Sheet 一致（排除已知、有記錄的無效列）。
13. 體重同一天只有一筆未刪除的列；刪除後同一天可以再記一筆；復原時如果那天已經有一筆，回 `bad_record`。
14. summary 和 trends 的結果和現有 `trends-parity` 測試案例一致。

**Bot**

15. Kyujin 回答「今天還剩多少」的數字和 App 一致。
16. Kyujin 寫入的列 `created_by=kyujin`、`source=kyujin`。

**維運**

17. 每日匯出連續 14 天成功；至少完成一次從匯出檔還原的演練。
18. 回滾演練在雙軌期完成，30 分鐘內回到舊系統。
19. 部署只需要 `pnpm run deploy`（`pnpm deploy` 是 pnpm 內建指令，不能用），或 CI 上的一個 workflow，不需要 Brian 手動操作 Apps Script。

## 13. 成本

| 項目 | 方案 | 每月費用 |
|---|---|---|
| Workers（含 static assets、Cron） | Free：每天 10 萬次請求、每個請求 10 ms CPU | $0 |
| D1 | Free：每個資料庫 500 MB；每天讀 500 萬列、寫 10 萬列；Time Travel 7 天 | $0 |
| R2 | Free：10 GB 儲存（可能要求綁卡，階段 1 前確認） | $0 |
| 網域 | 先用 `workers.dev` | $0 |
| **合計** | | **$0** |

- **用量（估計）**：每天 10–20 筆紀錄，一年不到 1 萬列、幾 MB。
- **升級到 Workers Paid（$5/月）的條件**（任一成立）：
  - 碰到每日額度
  - CPU 超過 10 ms，分頁和分段匯出也壓不下來
  - 需要 30 天 Time Travel
  - sicily-care 搬進來之後用量明顯上升

## 14. Brian 的前置作業

| # | 事項 | 為什麼一定要本人做 |
|---|---|---|
| 1 | 建立 Cloudflare 帳號；產生一支只限 Workers、D1、R2 權限的 API token | 帳號擁有者 |
| 2 | 交付 token：存進密碼管理器，或設成 GitHub Actions secret。不貼在聊天裡 | 機密 |
| 3 | 決定第 15 節的待決事項 | 產品決定 |
| 4 | 階段 0：在 iPhone 主畫面 PWA 實測 passkey 註冊和登入 | 需要真機和本人的 Face ID |
| 5 | 雙軌期試用；切換當天驗證資料並重新加到主畫面 | 真機驗證 |
| 6 | 確認 30 天後關閉 Apps Script 寫入、封存 Sheet | 擁有者決定 |

## 15. 風險與待決

### 15.1 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| passkey 在 iOS 主畫面 PWA 裡不能用 | 登入卡住 | 階段 0 先實測；不行就把一次性登入碼改成主要方式 |
| 同步層有 bug | 資料重複、遺失或不一致 | 冪等 mutationId、版本號游標、property test（亂序、重送、多裝置）、離線 e2e |
| 舊版 PWA 送出舊格式的 mutation | 寫入失敗 | mutation 帶版本、`minClientVersion`、expand → contract migration |
| iOS 清掉本機儲存 | 沒送出的紀錄遺失 | `storage.persist()`；每次寫入後立刻 push；伺服器才是正本 |
| 之後換成自己的網域 | passkey 綁在 `workers.dev` 的 RP ID 上，要重新註冊 | 換網域後用一次性登入碼登入，再重新註冊 passkey；在設定頁說明這件事 |
| Better Auth 在 D1 上的細節（版本、外掛 API 變動） | 實作卡關 | 階段 0 一起驗證；鎖定版本 |
| D1 沒有互動式交易 | mutator 的讀寫不在同一個交易裡，可能互相覆蓋 | CAS 保護的 batch + 部分唯一索引；階段 0 驗證；退路是 Durable Object SQLite |
| Workers 免費方案 10 ms CPU | 全量 pull、匯出超時 | pull 分頁、匯出分段，階段 0 實測 |
| D1 免費額度或價格變動 | 成本 | 實作前重新查證；資料可以用 `wrangler d1 export` 帶走；Drizzle 保留換到 Postgres 的路 |
| 遷移時資料轉換錯誤 | 歷史資料不正確 | 比對列數和每日加總；舊 Sheet 保留 30 天以上 |

### 15.2 待決問題

1. ~~備援登入方式~~：已定案為一次性登入碼（第 7.1 節）。
2. **每週異地備份放哪裡**：GitHub 私有 repo，還是共用電腦的 600 權限資料夾？
3. **Brian 的 email**：實作時寫進允許清單，不寫進 repo。
4. **切換時間**：由 Brian 決定。
5. **舊系統保留多久**：至少 30 天，到期後是否關閉 Apps Script。
6. **之後要不要買網域**：如果要，越早越好，可以少一次 passkey 重新註冊。

## 16. 里程碑

詳細施工計畫見 [`docs/plans/v2.md`](../plans/v2.md)。

| 階段 | 內容 | 出口條件 |
|---|---|---|
| 0. Spike | iPhone 主畫面 PWA 的 passkey；用體重一張表走通 push → pull → 離線重播 | 第 7.1 節的前提成立，或已改用一次性登入碼為主要方式 |
| 1. 平台 | monorepo、`packages/core`（mutators、權限、計算）、D1 schema、Worker（auth、sync、bot、cron） | 權限矩陣、同步、parity 測試全過 |
| 2. 前端 | Dexie 同步層、登入、拿掉設定畫面、功能資料夾重構 | 第 12 節「同步與離線」驗收通過 |
| 3. 遷移工具 | 匯入、比對、反向匯出腳本；Bot API 和 Kyujin 文件 | 匯入比對全對；回滾演練通過 |
| 4. 切換 | 雙軌試用 → 切換 → 觀察兩週 | 第 12 節全部通過 |
