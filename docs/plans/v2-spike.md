# v2 階段 0 Spike 報告

| 項目 | 內容 |
|---|---|
| 分支 | `spike/v2-auth-sync`（拋棄式；從含 `docs/plans/v2.md` 的 `main` 開出） |
| 對應 | [`v2.md`](v2.md) 第 4 節「階段 0」、[`backend-v2-PRD.md`](../architecture/backend-v2-PRD.md) §5.2、§7.1 |
| 狀態 | 程式、自動化測試與 iPhone 真機清單（第 7 節，2026-10-15）完成；**4a（24 小時後）、4b（7 天後）待測**：2026-10-16 23:30、2026-10-22 23:30 之後。**在 4b 結果出來前，不可以刪除 spike Worker `food-log-spike` 與 D1 `food-log-spike`（第 7 節第 9 項）** |
| 沒有做 | 沒有部署、沒有碰真實 Cloudflare、沒有打真實 `/exec`；`app/`（v1）和 `docs/architecture/` 完全沒動 |

## 1. 做了什麼

| 位置 | 內容 |
|---|---|
| 根目錄 | pnpm 工作區（`packages/* workers/* apps/*`，**不含 `app/`**）、`tsconfig.base.json`（strict、ES2022）、`packageManager: pnpm@10.34.7` |
| `packages/core` | 台北時間（複製自 `app/src/lib/day.ts`）、`Tx`/`Ctx`、`BufferedTx`（執行期擋「寫了再讀」）、`MutationError`、zod args、`weights.upsert/delete/restore@1`（規則逐條對 `Code.gs` 的 `upsertWeight_`／`softDelete_`／`restore_`）、registry、協定型別、與儲存無關的 `server/process-push.ts`／`pull.ts`（對 `ServerStore` 介面）、記憶體實作 `MemoryTx`／`MemoryServer` |
| `workers/api` | Hono；D1 migration `0001_init.sql`（全部 STRICT）；`D1Store`（CAS batch；`weights` 主鍵 `(user_id, id)`）；Better Auth + passkey + 一次性登入碼；`POST /sync/push`、`GET /sync/pull`；`scripts/bootstrap-owner.ts`、`login-code.ts`、`seed-weights.ts` |
| `apps/spike` | React + Dexie + vite-plugin-pwa（standalone）：登入（登入碼 → 註冊 passkey／用 passkey 登入）、體重表單（日期＋kg）與清單、同步徽章（待送數／狀態／cookie／最後錯誤）、失敗清單；開啟／`visibilitychange`／`online`／每次 mutate 之後／前景每 60 秒同步；由 Worker static assets 提供（SPA fallback，`run_worker_first` 只有 `/sync/*`、`/api/*`） |

### 同步與 CAS 的實作

- `begin()`：一個 batch 讀 `version`、`epoch`、這台裝置的 cursor；mutator 的讀取各是一次 D1 查詢，寫入進 `BufferedTx` 緩衝區。
- `commit()`：**一個** `db.batch`：
  1. `INSERT INTO cas_guard … CASE WHEN version = V`（`CHECK ok=1`，失敗整個 batch 回滾）
  2. 第二個 guard：`sync_clients.last_mutation_id = 先前讀到的值`
  3. `DELETE FROM cas_guard`
  4. 有寫入才 `UPDATE meta SET value = value + 1`，列寫入用 `(SELECT value FROM meta WHERE key='version')` 當 `version`
  5. `INSERT mutation_outcomes`（成功的結果或業務錯誤，重送時原樣回傳）＋刪掉這台裝置早於 `mutationId - 200` 的舊紀錄
  6. upsert `sync_clients`
- 只有 `cas_ok` guard 失敗才是 CAS 衝突 → 重讀重試，最多 5 次，之後回 503。唯一索引（`weights.user_id, weights.day`）擋下寫入時，重讀 `version` 與 cursor：都沒變就是確定性的錯誤（mutator 有 bug），記成 `bad_record`「這天已經有一筆體重」並推進 cursor，不重試；有變才當衝突。
- pull：先讀 cursor、再讀 head、最後讀列（回報的 `lastMutationId` 不會比列領先）；每頁 2,000 列，只在版本號之間切；cookie `<epoch>:<version>`；epoch 不同回 `reset:true` 並從 0 重送。

## 2. 固定的版本

| 套件 | 版本 |
|---|---|
| `better-auth` | **1.7.10**（精確） |
| `@better-auth/passkey` | **1.7.10**（精確；passkey 在 1.7 是獨立套件，不在 `better-auth` 內）。依賴 `@simplewebauthn/server` 13.3.3 |
| `hono` | 4.13.13 |
| `drizzle-orm` | 0.45.4（Better Auth 的 Drizzle adapter 用；D1 沒有 Better Auth 內建 adapter） |
| `wrangler` | 4.151.0（devDependency，用 `pnpm exec wrangler`） |
| `@cloudflare/vitest-pool-workers` | 0.23.0（已**棄用**，見第 5 節）；自帶 wrangler 4.124.0／workerd 1.20260815 |
| `vitest` | 4.1.11（pool 要求 `^4.1`，所以三個套件都用 4.x；`app/` 仍是 vitest 5，互不影響） |
| `zod` 4.6.7、`dexie` 4.4.6、`react` 19.3.1、`vite` 8.3.4、`vite-plugin-pwa` 2.0.0、`typescript` 7.0.2 | 和 `app/` 同一代 |
| Node | `>=22`；`scripts/*.ts` 直接用 Node 執行（要 22.18 以上，免 tsx）；本機跑在 25.7 |

## 3. 測試結果

`npx -y pnpm@10 -r typecheck` 與 `npx -y pnpm@10 -r test` 全過（`app/` 沒動，沒跑）。

| 套件 | 測試數 | 涵蓋 |
|---|---|---|
| `packages/core` | 52 | weights 三個 mutator 的每條規則（30–250、一位小數、day = 台北日、未來日、重複 id、同日覆寫保留 id 並回 `prevKg`、restore 衝突 `bad_record`、bot 可 upsert 不可 delete/restore 且先判權限）；`MemoryTx` 寫後讀會丟錯；`processPush`（冪等、錯誤紀錄、CAS 重試與 5 次後 503、寫後讀的 mutator 變 503）；`processPull`（分頁、版本邊界、epoch reset、tombstone） |
| `workers/api`（vitest-pool-workers，Miniflare D1） | 78 | **schema**：每張表 STRICT、部分唯一索引存在、`CHECK(day = date(ts,'+8 hours'))` 擋掉不一致與格式錯誤、kg 範圍與一位小數（30.0–250.0 每 0.1 都能寫入）、STRICT 擋文字 kg、同日兩筆 live 被索引擋下、`cas_ok`。**sync**：同一個 push 送兩次只生效一次；兩個並行同日 upsert → 恰一筆 live、兩個都有回應（一筆 `overwritten`）；8 路並行（斷言 CAS 真的觸發過）；過期的 commit 整批回滾（無列、無版本號、無 cursor）；cursor guard；錯誤 commit 也有 guard；唯一索引當最後防線；分頁 2000/2000/500、不切開同一版本、epoch reset、tombstone；沒 session／亂湊 cookie 回 401；409 `client_too_old`。**auth**：登入碼單次使用（含 3 個並行兌換只有 1 個成功）、過期、只存 SHA-256 hash、不在 `ALLOWED_EMAILS` 的人拿到有效碼也進不來、cookie `HttpOnly; Secure; SameSite=Lax; 90 天`、sign-up 關閉、**passkey 註冊→登出→passkey 登入→打 `/sync/pull` 全流程**（用測試內的軟體 authenticator）、簽章錯誤被拒。**budget**：見第 4 節。**review 後新增**：唯一索引違規 → `bad_record` 且後面的 mutation 照常處理、版本變動後的唯一衝突仍是重試、`(user_id, id)` 主鍵與兩使用者同 id、重送回原本結果與 outcomes 修剪（保留 200 筆）、`APP_ORIGIN` 缺少時 500／localhost 可省略／auth 單一快取、cookieCache（有快取 cookie 不查 D1、過期／刪除／竄改／格式錯誤仍 401） |
| `apps/spike`（fake-indexeddb + `MemoryServer`） | 10 | 離線記 3 筆 → 恢復連線 → 伺服器剛好 3 筆；回應遺失後重送仍只生效一次；本機立即丟業務錯誤；伺服器拒絕 → `failed` 表且樂觀列消失；兩台裝置同日交錯寫入收斂成一筆；tombstone 傳播；401 保留待送；1 萬列分頁與 epoch reset；view 不變式 |

另外手動（不進 repo）用 `wrangler dev --local` + 真的 Chrome（CDP 虛擬 authenticator）跑過整條流程：登入碼登入 → 記體重 → 註冊 passkey → 登出 → passkey 登入 → 重新整理仍在登入 → 離線記 3 天 → 恢復連線 → 待送 0、伺服器剛好多 3 筆。修正登出競態後連續 3 次都過。

## 4. 量測

> ⚠️ **以下全是本機 `wrangler dev --local` 的牆鐘時間（wall-clock），不是 Workers 的 CPU 時間。** 本機的 workerd 不回報 CPU，`performance.now()` 在 Worker 內只在 I/O 時前進。真正的 CPU 要部署後用 `wrangler tail`（第 7 節）。

測試資料：本機 D1 灌 10,000 列合成體重（`scripts/seed-weights.ts`，版本 1..10000）。

| 項目 | 結果（macOS、curl 對 localhost） |
|---|---|
| 全量 pull（`cookie=` 空）：5 頁 × 2,000 列，每頁約 312 KB | 每頁 9.0–14.3 ms，平均約 11 ms；5 頁合計約 55 ms（含 session 檢查、D1 查詢、JSON） |
| 單筆 push（新的一天） | 5.5–6.8 ms |
| pull（沒有新資料） | 4.1–5.1 ms |
| 沒 session 的 401 | 2.1–2.8 ms |
| 冷啟動：Worker 重啟後第一個請求 vs 之後 | `/api/health` 6.7 ms vs 2.8 ms；第一個需要 Better Auth 的請求約 8.7 ms vs 2.4–2.8 ms（多出的約 6 ms 是 `betterAuth()` 建構，已按 isolate 記憶化） |
| JS 部分的 CPU 代理值（Node、暖機後） | 2,000 列「映射＋`JSON.stringify`」約 0.2 ms／頁 |
| passkey 呼叫（Chrome 量到的牆鐘） | `generate-*-options` 5–6 ms、`verify-registration` 7 ms、`verify-authentication` 10 ms |
| Chrome（headless）從按下登入到 1 萬列進 Dexie（兩張表）完成 | 540–600 ms |
| D1 查詢數（`test/budget.test.ts`） | 10 筆 upsert 的 push：**41 次呼叫**（1 次 cursor＋每筆 4 次：begin batch、2 次讀、commit batch），batch 內共 121 條語句（含每筆的 outcome 寫入與修剪）；pull：4 次 |
| 打包 | `wrangler deploy --dry-run`：含靜態檔 3.5 MiB／gzip 605 KiB（Worker 免費方案上限壓縮後 3 MB）；前端 JS 465 kB／146 kB gzip |

判讀：本機牆鐘遠低於 10 ms／頁，JS 本身不是瓶頸，但 **D1 解碼與冷啟動的真實 CPU 沒量到**，不能就此宣告通過。出口條件「CPU 在限制內」待第 7 節。

## 5. 偏離計畫之處與意外發現

1. **起點**：原本的 worktree 是舊的 main（還沒有 `docs/plans/v2.md`）。我在還沒有任何 commit 的新分支上 `git reset --hard main`，再開始做。
2. **`MAX_PUSH` 50 → 10**。免費方案每次呼叫最多 50 次 D1 查詢，一筆 mutation 要 4 次（上表），50 筆會超過。若 D1 把 batch 內每條語句都算一次（官方文件沒講清楚），連 10 筆也太多（121 條語句），要降到 4–5。**待部署後驗證。** 解法方向：把 mutator 的讀取併進 `begin()` 的 batch。
3. **`@cloudflare/vitest-pool-workers` 已棄用**，改名 `@cloudflare/vitest-plugin`（1.4.3，支援 vitest 4／5，wrangler 4.151.0）。依指示用 pool 0.23.0（可用、只是每次印棄用警告）；階段 1 建議換成 plugin。
4. **D1 的 `GLOB`／`LIKE` 樣式上限 50 bytes**（`LIKE or GLOB pattern too complex`），原本的 `ts GLOB '…+08:00'` 建表就失敗。改用 `date()`／`strftime()` 檢查格式：`ts = strftime('%Y-%m-%dT%H:%M:%S', ts, '+8 hours') || '+08:00'`。
5. **`CHECK` 遇到 NULL 會通過**，`date('垃圾')` 回 NULL，所以 `day = date(ts,…)` 單獨用擋不住壞 `ts`；每條都補 `… IS NOT NULL AND …`，測試覆蓋。
6. **第二個 guard**：計畫寫「更新 `sync_clients`（條件：`last_mutation_id` 還是先前讀到的值）」。錯誤／ignored 路徑版本號不變，只靠條件式 UPDATE 擋不住重複寫 `mutation_outcomes`（當時還叫 `mutation_errors`），所以改成第二個 `cas_guard` 語句，所有 commit 一律走兩個 guard。
7. **重送已處理的 mutation**：每筆結果（成功的 `result` 或業務錯誤）都存在 `mutation_outcomes`，重送時原樣回傳（例如 `{overwritten:true, prevKg}`）；每次 commit 刪掉這台裝置早於 `mutationId - 200` 的紀錄，只有被刪掉的才退回 `{replayed:true}`。（初版只存錯誤，review 後修正。）
8. **Better Auth 在 D1**：1.7.10 沒有內建 D1 adapter，用 Drizzle adapter（`drizzle-orm/d1`），auth 表的 SQL 手寫（STRICT）並用測試驗證各流程。`ctx.json(body, {status})` 不會改狀態碼，要 `throw new APIError(...)`。
9. **sign-up 關閉**：沒有 email／密碼／social，所以沒有任何註冊路徑；`user` 列只能由 `bootstrap-owner.ts` 產生的 SQL 建立。`ALLOWED_EMAILS` 另外在 `databaseHooks.user.create`、`session.create` 和登入碼兌換時各擋一次。
10. **weights.delete／restore** 對已刪除／已 live 的列回 `{ignored}`（冪等，不丟錯）。
11. **rebase 的坑（前端）**：確認或失敗的 pending 的 `touched` 鍵也必須算「髒鍵」，否則伺服器改寫（同日覆寫保留舊 id）後，本機樂觀列會殘留。已修並有測試。登出前要先 `halt()` 同步迴圈，否則會和進行中的 pull 搶 Dexie。
12. **Code review 後的修正**（2026-10-15）：
    - 唯一索引違規不再被當成 CAS 衝突（否則確定性的錯誤會重試 5 次後永遠 503），見第 1 節。
    - `weights` 主鍵由 `id` 改為 `(user_id, id)`，upsert 不再需要 `WHERE weights.user_id = excluded.user_id`；兩個使用者可以用同一個 id（有測試）。
    - `APP_ORIGIN` 在 localhost 以外**必填**：沒設就對 `/api/auth/*`、`/sync/*` 回 500 `APP_ORIGIN not configured`（不再從 Host 推導）。auth 實例改成單一快取，鍵為 `(APP_ORIGIN, ALLOWED_EMAILS, BETTER_AUTH_SECRET 的雜湊)`，不會隨 Host 增長。
    - 開啟 Better Auth `session.cookieCache`（5 分鐘）：`/sync/*` 平常只驗簽章、不打 D1；代價是登出／撤銷／從 `ALLOWED_EMAILS` 移除最多 5 分鐘後才生效。過期、被竄改或格式錯誤的 cookie 仍回 401（格式錯誤的 `session_data` 會退回查 D1，不會變成 500）。`/sync/*` 用 `returnHeaders` 把 Set-Cookie 帶回回應，快取才會被補上。
13. 體重表單多了日期欄（≤ 今天），因為清單第 5 項要離線記 3 **筆**，同一天只會覆寫成 1 筆。

## 6. 還開著的風險

| 風險 | 說明 |
|---|---|
| 真實 CPU 未知 | 冷啟動 Better Auth 建構約 +6 ms 牆鐘，離 10 ms 不遠。若 `wrangler tail` 顯示冷請求 > 10 ms：第一個請求只做 session（不建 passkey 外掛）、或升級 $5 方案 |
| D1 查詢計數方式 | 見上第 2 點 |
| passkey 在 iPhone 主畫面 PWA | 只在 Chrome 虛擬 authenticator 驗證過；Safari／主畫面是不同的儲存空間，要在主畫面 App **裡面**登入。⛔ |
| 新增 passkey 需要「新鮮」session | Better Auth 預設 `freshAge` 1 天：用 passkey 登入超過一天後再註冊第二把會被拒，要先重新登入（或用登入碼）。設定頁文案要說明 |
| 登入碼暴力猜測 | 12 字元（約 59 bits）、15 分鐘、單次，只靠 Better Auth 內建的速率限制（isolate 內記憶體）。夠用，但階段 1 可加 D1 計數 |
| Service Worker 快取 | 已把 `/sync`、`/api` 排除在 `navigateFallbackDenylist`；iOS 更新 SW 的實際行為要在清單第 4 項一併觀察 |
| 只有 weights | `logs`／`items` 等有更多 CHECK 與關聯，`BufferedTx` 的先讀後寫規則在複雜 mutator（`logs.add` 同時建品項）上還沒驗證 |

## 7. ⛔ Brian 要親自做的步驟

沒有全域 pnpm 時，把下面的 `pnpm` 換成 `npx -y pnpm@10`。以下都在 repo 根目錄，在 `spike/v2-auth-sync` 分支上。email、token、secret **不要貼進聊天或 commit**。

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r test          # 先確認你的機器上也全過
```

1. ⛔ **建 Cloudflare 帳號**（若還沒有）。在 Dashboard 建 **API token**，權限只給 `Account → Workers Scripts: Edit`、`D1: Edit`、`Workers R2 Storage: Edit`，資源只選這個帳號。放進密碼管理器，只在當前 shell 設定：
   ```sh
   export CLOUDFLARE_API_TOKEN=…        # 不要寫進任何檔案
   ```
   第一次部署時 wrangler 會要你註冊 `workers.dev` 子網域。R2 在這個 spike 用不到。
2. ⛔ **建 D1**，把輸出的 `database_id` 貼到 `workers/api/wrangler.jsonc`（取代全 0 的佔位值；這不是機密）：
   ```sh
   pnpm --filter @food-log/api exec wrangler d1 create food-log-spike
   ```
3. ⛔ **套 migration 到遠端**：
   ```sh
   pnpm --filter @food-log/api exec wrangler d1 migrations apply food-log-spike --remote
   ```
4. ⛔ **設定 secret**（Worker 還不存在時 wrangler 會問要不要先建一個空的，答 yes）：
   ```sh
   openssl rand -base64 32                                                        # 產生值
   pnpm --filter @food-log/api exec wrangler secret put BETTER_AUTH_SECRET        # 貼上面的值
   pnpm --filter @food-log/api exec wrangler secret put ALLOWED_EMAILS            # 你的 email（多個用逗號）
   ```
5. ⛔ **部署，然後設定 `APP_ORIGIN`（必填）**。Worker 在 localhost 以外沒有 `APP_ORIGIN` 就會對 `/api/auth/*`、`/sync/*` 回 500 `APP_ORIGIN not configured`（fail closed，不會從 Host 推導），所以要部署兩次：
   ```sh
   pnpm --filter @food-log/api run deploy      # 第一次：會先 build apps/spike 再 wrangler deploy；輸出 https://food-log-spike.<你的子網域>.workers.dev
   ```
   把輸出的網址（只要 origin，不含路徑）填進 `workers/api/wrangler.jsonc` 的 `vars`（不是機密，可以進 git；子網域已註冊後也可在第一次部署前就填好）：
   ```jsonc
   "vars": { "MIN_CLIENT_VERSION": "1", "APP_ORIGIN": "https://food-log-spike.<你的子網域>.workers.dev" }
   ```
   ```sh
   pnpm --filter @food-log/api run deploy      # 第二次：APP_ORIGIN 生效
   curl -s https://food-log-spike.<你的子網域>.workers.dev/sync/pull?clientId=x     # 應該是 401 {"error":"unauthorized"}，不是 500
   ```
   passkey 的 RP ID 就是這個完整主機名（`workers.dev` 在 Public Suffix List 上，不能用上層網域）；之後改網域要同時改 `APP_ORIGIN`，既有的 passkey 會失效。
6. ⛔ **建立 owner、產生登入碼**（腳本只印出 SQL／指令，不會連線；各複製印出的 `pnpm … wrangler d1 execute …` 那一行執行）：
   ```sh
   cd workers/api
   node scripts/bootstrap-owner.ts --email <你的 email> --name Brian --remote
   node scripts/login-code.ts      --email <你的 email> --remote
   ```
   登入碼從「印出的指令執行」那一刻起 15 分鐘有效、只能用一次。要再登入就重跑 `login-code.ts`。
7. ⛔ **iPhone 清單**（plan §4 階段 0 第 7 項）。先用 Safari 開上面的網址 →「加入主畫面」，之後**只從主畫面圖示開**，在主畫面 App 裡登入（Safari 與主畫面 App 的儲存空間是分開的）。把結果填在下面的表。

   | # | 項目 | 結果 | 備註 |
   |---|---|---|---|
   | 1 | 用登入碼登入主畫面 PWA，按「註冊 passkey」成功 | ✅ 2026-10-15 | Face ID 跳出，註冊成功 |
   | 2 | 強制關閉 App 後重開，仍在登入狀態 | ✅ 2026-10-15 | 不需要再輸入登入碼 |
   | 3 | 按「登出」，再按「用 passkey 登入」成功 | ✅ 2026-10-15 | Face ID 登入成功 |
   | 4a | 24 小時後打開，仍在登入狀態？ | 待測 | 時間：2026-10-16 23:30 之後 |
   | 4b | 7 天後打開，仍在登入狀態？ | 待測 | 時間：2026-10-22 23:30 之後 |
   | 5 | 飛航模式下記 3 筆（**日期欄選 3 個不同的日子**）→ 強制關閉 App → 重開 → 關飛航模式 → 電腦上剛好 3 筆 | ✅ 2026-10-15 | 驗證：`pnpm --filter @food-log/api exec wrangler d1 execute food-log-spike --remote --command "SELECT day, kg, deleted_at FROM weights ORDER BY day"` |

   passkey 在主畫面 PWA 失敗（1 或 3）→ 依計畫把一次性登入碼升為主要方式（階段 1 設計會改，不影響 `core`／同步）。第 4 項若 session 被清掉，記下是 24 小時還是 7 天（Safari 對網站資料的清除規則），這決定登入碼要多常用。
8. ⛔（建議）**量真實 CPU**。另開一個終端機：
   ```sh
   pnpm --filter @food-log/api exec wrangler tail food-log-spike --format json
   ```
   在 iPhone 上登出再用 passkey 登入（觸發 passkey 驗證和一次 pull），看每個事件的 `cpuTime`／`wallTime`（毫秒）。也看**剛部署完的第一個請求**（冷啟動，Better Auth 建構）。要測 1 萬列的全量 pull：
   ```sh
   pnpm --filter @food-log/api exec wrangler d1 execute food-log-spike --remote --command "SELECT id FROM user"
   node scripts/seed-weights.ts --user <上面的 id> --count 10000 > /tmp/seed.sql     # 合成資料，在 workers/api 下執行
   pnpm --filter @food-log/api exec wrangler d1 execute food-log-spike --remote --file /tmp/seed.sql
   ```
   然後在 iPhone 登出再登入（等於從 `cookie=` 空的狀態重拉 5 頁），記下每頁的 `cpuTime`。再送一次 push，看 10 筆的 push 有沒有出現 D1 查詢數過多的錯誤（第 5 節第 2 點）。結果寫在這裡：

   | 事件 | cpuTime | wallTime |
   |---|---|---|
   | 冷啟動第一個請求 | 28 ms（之後其他新 isolate：33、18 ms） | 28 ms |
   | `/sync/pull` 熱（auth 實例已建好，401） | 0–1 ms | 1–2 ms |
   | `/api/health`（不建 Better Auth） | 冷 2–4 ms、熱 0 ms | 0–4 ms |
   | pull 一頁 2,000 列（×5） | 10、9、7、7、6 ms（貼著 10 ms；需要餘裕時把頁大小降到 1,000） | 454–939 ms |
   | passkey `verify-authentication` | 23 ms（generate-options 9 ms；sign-out 18 ms 疑似新 isolate） | 867 ms |
   | `/sync/pull`（少量資料，iPhone 實際請求） | 4 ms | 418–427 ms（4 次 D1 讀取依序來回；階段 1 改成一個 `db.batch`） |
   | 10 筆 push | 略過（2026-10-15；本機量過 41 次 D1 呼叫 < 50，真實環境未驗） | — |

   跑完用 `DELETE FROM weights;` 清掉合成資料。
9. ⛔ **結束後清掉**。**4b（2026-10-22 23:30 之後的 7 天 session 測試）出結果之前不要執行這一步**：spike Worker／D1 刪掉，4a／4b 就沒有東西可以測了。

   ```sh
   pnpm --filter @food-log/api exec wrangler delete food-log-spike
   pnpm --filter @food-log/api exec wrangler d1 delete food-log-spike
   ```
   然後到 Dashboard 撤銷（或縮權／輪替）這支 spike 用的 API token。iPhone 上刪掉主畫面圖示。

## 8. 出口條件對照

| 條件 | 狀態 |
|---|---|
| passkey 在主畫面 PWA 可用（否則登入碼升為主要方式） | ✅ 2026-10-15 iPhone 主畫面 PWA 實測：登入碼登入、註冊 passkey、重開仍登入、登出後 passkey 登入、離線 3 筆同步全部通過。session 保存（第 4a／4b 項）待 24 小時與 7 天後確認 |
| CAS 做法成立 | ✅ D1 batch + guard + 部分唯一索引，並行測試與回滾測試通過；退路（SQLite DO）暫不需要 |
| CPU 在限制內 | ⚠️ 2026-10-15 `wrangler tail` 實測：熱請求 0–1 ms；但每個新 isolate 第一次建立 Better Auth 要 18–33 ms CPU（超過免費方案 10 ms，目前 outcome 仍是 ok，有偶發 1102 風險）。階段 1 要把 `betterAuth()` 移到 global scope（`import { env } from "cloudflare:workers"`），讓它算在 Worker 啟動時間而不是請求 CPU；改了仍超過才升級 $5 |
| Better Auth 版本已鎖定 | ✅ 1.7.10 + `@better-auth/passkey` 1.7.10 |
