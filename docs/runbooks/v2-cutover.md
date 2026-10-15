# food-log v2 切換與回滾手冊

| 項目 | 內容 |
|---|---|
| 依據 | [`docs/plans/v2.md`](../plans/v2.md) 第 1 節（`v1-final` tag）、§3.3（D1 schema）、第 4 節階段 1 步驟 5 + 階段 3 + 階段 4、第 6 節（回滾）、第 8 節（Brian 的操作） |
| 執行 | **全部標 ⛔ 的步驟只有 Brian 能做**；agent 只負責寫好指令，不部署、不 push、不碰真實的 D1、R2、Sheet、Apps Script |
| 目標 | 切換當天停機（舊系統唯讀）越短越好；出問題 30 分鐘內回到 v1 |
| 不放什麼 | 真實網址、key、email、登入碼一律不進 repo（repo 是公開的），下面用 `<WORKER_HOST>` 這類佔位符 |

## 佔位符

| 佔位符 | 意思 |
|---|---|
| `<WORKER_HOST>` | Worker 的 workers.dev 主機名（`wrangler deploy` 結束時會印出，也寫在 `workers/api/wrangler.jsonc` 的 `APP_ORIGIN`） |
| `<OWNER_EMAIL>` | Brian 自己的 email（同時要在 `ALLOWED_EMAILS` secret 裡） |
| `<GAS_EXEC_URL>` | 舊 Apps Script 的 `/exec` 網址（不是秘密，但也不寫進 repo） |
| `<GH_PAGES_URL>` | 舊 GitHub Pages 的網址 |
| `<DAY>` | 匯出日期 `YYYY-MM-DD`（台北日） |
| `<DRILL_DIR>` | 本機放下載匯出檔的資料夾，**放在 repo 外**（例如 `~/food-log-drill/<DAY>`），裡面是飲食資料，不能進 git |
| `<V_CUT>` | 切換當天最後一次匯入時記下的 D1 版本號（第 3 步） |

## 指令慣例

pnpm 沒有全域安裝，一律用 `npx -y pnpm@10 …`。要對 Worker 跑 wrangler，用：

```bash
npx -y pnpm@10 --filter @food-log/api exec wrangler <子指令> …
```

下文簡寫成 `WR <子指令>`。D1 資料庫叫 `food-log`，R2 bucket 叫 `food-log-exports`（見 `workers/api/wrangler.jsonc`）。wrangler 的旗標會隨版本變，**每個 wrangler 指令都以 `WR <子指令> --help` 為準**。

`tools/migrate`（套件 `@food-log/migrate`）的 CLI 一律這樣跑，下文簡寫成 `MG <script>`（腳本的工作目錄是 `tools/migrate/`，所以 `out/…` 指的是 `tools/migrate/out/…`）：

```bash
npx -y pnpm@10 --filter @food-log/migrate <script> …
```

| 腳本 | 用途 | 介面 |
|---|---|---|
| `fetch-sheet` | 讀整份 Sheet（只用唯讀的 `read` 與 `history`）寫成 `out/sheet-<時間>.json`（權限 0600） | 環境變數 `GAS_URL`（舊 `/exec` 網址）與 `GAS_SECRET`（舊共享密鑰）；`--out <資料夾>` 可改輸出位置 |
| `emit-sql` | 轉換（`transform`）並產生匯入 SQL | `--sheet <out/sheet-*.json> --user-id <owner user.id> [--reset] [--local] [--max-bytes N] [--db food-log]`；寫出 `out/import-<時間>/import-NNN-of-MMM.sql` 與 `anomalies.json`，並**依序**印出要執行的 `wrangler d1 execute` 指令 |
| `d1-dump-command` | 印出把 D1 傾印成 JSON 的**唯讀**指令（輸出到 `tools/migrate/out/d1-dump.json`） | `[--local]`（預設 `--remote`） |
| `verify` | 比對 Sheet 與 D1 傾印；任何不符結束碼 1 | `--sheet <sheet.json> --dump <d1-dump.json> --user-id <owner user.id>` |
| `reverse-export` | 回滾用：把 `version > V_cut` 的 v2 資料轉成 GAS 動作寫回 Sheet | `--dump <d1-dump.json> --since <V_cut> --user-id <owner user.id> --fetch-base [--dry-run] [--plan-out <檔>]`；實際寫入需要 `GAS_URL`、`GAS_SECRET` |

`gas-client` 與 `transform` 是函式庫，不是獨立的 CLI（`fetch-sheet`、`emit-sql`、`verify`、`reverse-export` 內部呼叫它們）。

- **`GAS_URL`、`GAS_SECRET` 只放環境變數**：用 `read -s` 設在當下的 shell（`read -s GAS_SECRET; export GAS_SECRET`），不寫進 shell history、不貼進聊天、不寫進任何檔案。
- **`--user-id` 是 owner 的 `user.id`**（不是 email）：
  ```bash
  WR d1 execute food-log --remote --command "SELECT id, email FROM user"
  ```
  先完成 1.3 的 bootstrap owner，這個指令才查得到。
- **`--reset` 的規則**：不加 `--reset` 的 `emit-sql` **只用在第一次匯入、而且 D1 是空的**（逐列 upsert，不會刪除 v2 裡已經改掉或刪掉的東西）。之後每一次匯入，**包含切換當天，一律加 `--reset`**：它先刪掉 owner 的六張業務表，再寫入全部資料，並寫入新的 epoch（所有裝置下次 pull 會重置）。
- 輸出的 `out/` 裡全是私人資料：已 gitignore（security test 會檢查它沒被 git 追蹤），不要複製到 repo 以外的共享位置。

---

## 一、雙軌期（舊的 v1 照常使用，v2 平行建好）

目標：切換當天只剩「最後一次匯入 + 驗證 + 換網址」。這一節的步驟可以重複做。

### 1.1 ⛔ Brian-only：建立資源（只做一次）

見計畫第 8 節。

1. 建 Cloudflare 帳號與 API token（只放在 Brian 的本機環境，不進 repo）。
2. 建 D1 與 R2：
   ```bash
   WR d1 create food-log
   WR r2 bucket create food-log-exports
   ```
   `d1 create` 印出的 `database_id` 填進 `workers/api/wrangler.jsonc`（不是秘密，要 commit）。R2 如果要求綁卡，是第 8 節的待決定事項。
3. 設定 secrets（值不進 repo，不要貼在聊天）：
   ```bash
   WR secret put BETTER_AUTH_SECRET     # 貼 `openssl rand -base64 32` 的輸出
   WR secret put ALLOWED_EMAILS         # 貼 <OWNER_EMAIL>（多個用逗號隔開）
   ```

### 1.2 ⛔ Brian-only：部署 API

```bash
npx -y pnpm@10 --filter @food-log/api run deploy
```

這會依序跑：`pnpm -r typecheck` → `pnpm -r test` → `wrangler d1 migrations apply food-log --remote` → `wrangler deploy`。**只部署 API，沒有靜態檔**（`wrangler.jsonc` 沒有 assets）。

- 腳本內用的是裸 `pnpm`；用 `npx` 啟動時 PATH 會帶著它。若出現 `pnpm: command not found`，改在有安裝 pnpm 的環境（例如 CI）跑，不要為了這個裝全域 pnpm 到共用電腦。
- 部署完成後記下 `<WORKER_HOST>`，確認 `workers/api/wrangler.jsonc` 的 `APP_ORIGIN` 與它一致（passkey 的 RP ID 就是這個主機名；之後換網域＝所有 passkey 要重新註冊）。
- 驗證：
  ```bash
  curl -s https://<WORKER_HOST>/api/health
  ```
  回應的 `authPrewarm` 必須是 `"ok"`（計畫第 8 節）。再開 `WR tail`，用手機打幾個請求，看每個請求的 CPU time（免費方案每個請求 10 ms）。
- **帶前端的部署**（`deploy:with-app`）要等階段 2 完成（`apps/food-log` 改接 `/sync`，`src/api/gas.ts` 刪除）之後才能做；守門腳本在 `gas.ts` 還存在時會拒絕：
  ```bash
  npx -y pnpm@10 --filter @food-log/api run deploy:with-app
  ```
  在那之前，雙軌期只有 API，PWA 仍是 v1。

### 1.3 ⛔ Brian-only：建立 owner、用登入碼登入、註冊 passkey

`workers/api/scripts/*` 只印出要執行的指令，不會自己連 Cloudflare。

1. 建 owner（每個資料庫只做一次）：
   ```bash
   node workers/api/scripts/bootstrap-owner.ts --email <OWNER_EMAIL> --name <顯示名稱> --remote
   ```
   把印出的整行指令貼上執行（它已經是 `npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --command '…'` 的完整形式，也就是 `WR d1 execute food-log --remote --command '…'`）。
2. 發一次性登入碼（15 分鐘，單次有效；計時從「印出的指令實際執行」開始）：
   ```bash
   node workers/api/scripts/login-code.ts --email <OWNER_EMAIL> --remote
   ```
   登入碼只會印一次，不要存檔、不要貼進聊天；執行印出的指令把雜湊寫進 D1，然後在新 App 的登入畫面輸入。
3. 登入後，在設定裡**註冊 passkey**（用 iPhone 主畫面 PWA 的環境註冊，因為 iOS 主畫面 PWA 與 Safari 的 cookie／passkey 是分開的，計畫第 9 節）。註冊完登出再用 passkey 登入一次，確認可用。登入碼只當備援。

### 1.4 ⛔ Brian-only：可重複的匯入（從舊 Sheet 到 D1）

用真實資料匯入前確認 `tools/migrate/out/` 沒被 git 追蹤（`git status` 看不到它）。工具見「指令慣例」的 `MG` 表。

```bash
# 1. 抓整份 Sheet（read，再用 history 往回翻到底）
read -s GAS_SECRET; export GAS_SECRET            # 貼舊共享密鑰，不會顯示
export GAS_URL=<GAS_EXEC_URL>
MG fetch-sheet                                    # 寫出 out/sheet-<時間>.json（0600），印出抓到幾列

# 2. 產生 SQL（transform 在裡面）
MG emit-sql --sheet out/sheet-<時間>.json --user-id <OWNER_USER_ID> [--reset]
#   寫出 out/import-<時間>/import-NNN-of-MMM.sql 與 anomalies.json，
#   並依序印出要執行的指令（⛔ 遠端 D1）：
#   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --file '<…/import-001-of-00M.sql>'
#   …（照印出的順序，一個一個執行）

# 3. 傾印 D1 並比對
MG d1-dump-command                                # 印出唯讀指令；貼上執行，得到 out/d1-dump.json
MG verify --sheet out/sheet-<時間>.json --dump out/d1-dump.json --user-id <OWNER_USER_ID>   # 不符就結束碼 1
```

- **第一次匯入**（D1 還是空的）：不加 `--reset`。**之後每一次重新匯入（含雙軌期反覆匯入）都要加 `--reset`**：先刪掉 owner 的業務表再整批寫入，並換新的 epoch，已經登入 v2 的測試裝置會被重置、重新同步；不加 `--reset` 的 upsert 不會刪掉 v2 裡後來才刪的列。
- SQL 檔要**依序**執行（`import-001-of-…` 先）；中途失敗就修好原因後**從第一個檔重新依序全部跑**（每列是 upsert，可以重跑；用了 `--reset` 時第一個檔會先刪掉 owner 的資料，所以不能只單獨重跑後面或前面的某個檔）。
- 仔細讀 `anomalies.json`（以及 `emit-sql` 印出的 anomalies 統計：體重同一天多筆保留最新一筆、`day` 修正、補 id 等）；有看不懂的調整，先問再切換。
- `verify` 要全對：每張表未刪除／已刪除的列數與 id 集合、每日營養素加總、每日體重、Config 每個值、收藏集合。有差異不進入切換日。`verify` 的預期值是「原始 Sheet 扣掉 `anomalies` 記錄的調整」，所以沒記在 anomalies 裡的差異就是 bug，要回報。
- 匯入完在 D1 確認版本號有動：
  ```bash
  WR d1 execute food-log --remote --command "SELECT key, value FROM meta"
  ```

### 1.5 ⛔ Brian-only：每天匯出要成功（觀察 + 還原演練）

Worker 每天台北 04:00 自動匯出到 R2（cron `0 20 * * *`，04:05–04:55 每 5 分鐘續跑，見 `workers/api/src/cron/export.ts`）。R2 裡的結構：

```text
exports/<DAY>/_ok.json              最後才寫；有它才代表這一天匯完了
exports/<DAY>/<table>.part-N.json   stores / items / logs / weights / favorites / config
exports/<DAY>/logs.part-N.csv       只有 part 1 有 BOM 與表頭
```

**每天（至少雙軌期前幾天）檢查：**

1. 隔天 04:55 之後，`_ok.json` 要存在，而且 `consistent` 是 `true`：
   ```bash
   mkdir -p <DRILL_DIR>
   WR r2 object get food-log-exports/exports/<DAY>/_ok.json --file <DRILL_DIR>/_ok.json --remote
   grep -E '"(consistent|attempts|versionAtStart|versionAtEnd)"' <DRILL_DIR>/_ok.json
   ```
   （`--file` 用絕對路徑，因為 `WR` 會切到 `workers/api` 執行。）取不到物件就是那天沒有匯完；也可以在 Cloudflare 儀表板的 R2 bucket 裡看 `exports/` 資料夾。
2. `consistent: false`（匯出期間資料一直在變，重來一次仍變動）的那天不能當備份用；`restore-drill` 會直接拒絕它。
3. 匯出進度表應該是空的（匯完會刪）：
   ```bash
   WR d1 execute food-log --remote --command "SELECT day, table_idx, part, attempt FROM export_progress"
   ```
   有列留著超過 04:55 台北，代表那天卡住了。`WR tail` 可看到每次排程的 `{"type":"export",…}` 日誌。

**還原演練（切換前至少做一次，切換後每週做一次）：**

1. 下載一整天的匯出到 `<DRILL_DIR>`（repo 外）。先下載 `_ok.json`（上面第 1 點），再依它列出的 part 清單逐個下載。下面的迴圈由 `_ok.json` 產生所有下載指令，先看輸出，沒問題再執行：
   ```bash
   DIR=<DRILL_DIR>      # 絕對路徑
   DAY=<DAY>
   node -e '
     const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
     for (const t of Object.values(m.tables)) for (const p of t.parts) console.log(p.key);
   ' "$DIR/_ok.json" | while read -r key; do
     echo npx -y pnpm@10 --filter @food-log/api exec wrangler r2 object get "food-log-exports/$key" --file "$DIR/$(basename "$key")" --remote
   done
   ```
   確認輸出後，把 `echo` 拿掉再跑一次（或把輸出貼進 shell）。part 的檔名就是 `_ok.json` 裡每個 `key` 的最後一段；下載後的資料夾裡應該有 `_ok.json`、各表 `*.part-N.json`、`logs.part-N.csv`。
2. 跑演練（不碰 R2、不碰 D1，只讀本機資料夾）：
   ```bash
   cd tools/ops
   node src/restore-drill.ts --dir <DRILL_DIR> [--db <DRILL_DIR>/drill.sqlite]
   ```
   - 沒有 `--db` 就在記憶體裡跑；有 `--db` 會建一個全新的 SQLite 檔（已存在會拒絕，避免蓋掉東西）。
   - 它先套用 `workers/api/migrations/*.sql`（依序），再載入每張表的 part 檔，然後輸出：每張表的「manifest 列數／part 內列數／未刪除／已刪除」、logs 每日 kcal／protein／fat／carb 加總、每日體重筆數。加總會在 part 檔、`logs.csv`、還原後的資料庫三方互相比對。
   - 結束碼：`0` 全部相符；`1` 有不符（列數、加總、part 檔遺失或位元組數不對、schema 拒收某列）；`2` 拒絕執行（沒有 `_ok.json`、`consistent` 不是 `true`、`--db` 檔已存在）。最後一行印出耗時。
   - 演練還會檢查每一列的 `version` 是否為整數且不大於 `_ok.json` 的 `versionAtEnd`。**不檢查版本號是否唯一**：一個 mutation 寫的每一列都蓋同一個版本號（可能跨好幾張表，`(user_id, version)` 索引也不是唯一索引，見 `d1-store.ts`），pull 是依 (version, 表順序, 主鍵) 分頁，所以重複是正常的。
   - 加 `--emit-sql <檔案>`（演練 OK 才會寫，且不覆蓋既有檔案）會另外產生還原到 D1 的 SQL，用在第五節的災難還原。
   - 需要 Node 22.18 以上（`node:sqlite` 不用旗標，且 `node` 能直接執行 `.ts`；本機以 Node 25 驗證過）。第一次執行可能印出 `ExperimentalWarning: SQLite is an experimental feature`，不影響結果。目前的 migrations（STRICT 表、`ANY` 型別、部分唯一索引、CHECK 裡的 `date()`／`strftime()`、`json_valid`）在 `node:sqlite` 內建的 SQLite 上都能直接套用，沒有需要繞過的語法；wrangler 自己的 `d1_migrations` 記錄表不會建，演練用不到。若之後某個 migration 在 `node:sqlite` 失敗，錯誤訊息會指出是哪一個檔案；在 `src/drill-lib.ts` 的 `applyMigrations` 處理，並把解法補在這裡。
3. 把演練的耗時、版本號（`version a..b`）記在下面的「演練紀錄」：

| 日期 | 匯出日 `<DAY>` | 結果（OK／MISMATCH／refused） | 耗時 | 備註 |
|---|---|---|---|---|
| | | | | |

---

## 二、切換當天（⛔ 每一步都由 Brian 執行）

前置條件（沒全部打勾就不要開始）：

- [ ] 雙軌期的 `verify` 至少連續幾天全對，`anomalies[]` 都看過
- [ ] 至少一次還原演練 OK，每日匯出連續成功
- [ ] 已用 `deploy:with-app` 部署帶前端的版本，新網址登入、passkey、離線記錄、同步都試過
- [ ] 回滾演練做過一次並計時（第四節），知道 30 分鐘怎麼分配
- [ ] `v1-final` 要打 tag 的 `main` 已含 v1 唯讀開關（`READ_ONLY`，且已部署到 GAS，預設關閉）
- [ ] 導向版本（第 6 步）已在 `main` 衍生的暫時分支上備妥並審過
- [ ] Kyujin 的新設定（新網址、新 key 的存放位置）已準備好

### 步驟 1　⛔ GAS 設為唯讀

Apps Script 編輯器 → 專案設定 → 指令碼屬性，新增或修改 `READ_ONLY` = `1`。之後所有寫入（`append`、`update`、`softDelete`、`restore`、`upsertItem`、`upsertStore`、`upsertWeight`、`setConfig`）都回 `read_only`，`read`／`history`／`summary`／`trends` 仍可讀。舊 App 把 `read_only` 當永久錯誤，顯示「已搬到新網址」。

驗證：用舊 App 記一筆，應該被擋下並顯示搬家提示；Sheet 沒有新列。

### 步驟 2　⛔ 確認舊 App 的待送佇列與失敗清單都是空的

在每一台還裝著舊 App 的裝置（iPhone、其他瀏覽器）打開舊 App，看「待送佇列」與「失敗清單」。**兩個都必須是空的**；有東西就先讓它送完（此時 GAS 已唯讀，送不出去就會變失敗清單）。這時要處理：

- 失敗清單裡的項目：手動在新 App 補記，或確認不需要，**不要直接略過**，因為切換後舊 App 的待送資料就永遠送不出去。
- 全部清空後再進入下一步。

### 步驟 3　⛔ 最後一次匯入（fetch-sheet → emit-sql --reset → 套用 → verify），記下 `V_cut`

此時 GAS 已唯讀，抓到的就是最終資料。**切換當天一律加 `--reset`**（即使雙軌期已經匯入過）：

```bash
read -s GAS_SECRET; export GAS_SECRET             # 舊共享密鑰（此時還沒輪替，步驟 4 才換）
export GAS_URL=<GAS_EXEC_URL>
WR d1 execute food-log --remote --command "SELECT id, email FROM user"      # 記下 owner 的 id → <OWNER_USER_ID>

MG fetch-sheet                                    # → out/sheet-<時間>.json
MG emit-sql --sheet out/sheet-<時間>.json --user-id <OWNER_USER_ID> --reset
#   → out/import-<時間>/import-NNN-of-MMM.sql + anomalies.json；印出的 wrangler 指令「依序」全部執行
#   （第一個檔先刪掉 owner 的六張業務表並寫入新 epoch，所有裝置會重置並重新同步）

MG d1-dump-command                                # 貼上印出的唯讀指令 → out/d1-dump.json
MG verify --sheet out/sheet-<時間>.json --dump out/d1-dump.json --user-id <OWNER_USER_ID>   # 必須結束碼 0
```

- `--reset` 會改 epoch，已登入的裝置會被要求重置本機資料再 pull；匯入前先確認第 2 步已完成。
- 中途失敗就**從第一個檔重新依序全部跑**。
- `verify` 有任何差異（結束碼 1）就**停下**，不要繼續；差異排除前保持 GAS 唯讀（唯讀期間舊資料不會再變，可以安心重來整個步驟）。
- **記下 `V_cut`**：全部 SQL 套用完成後，D1 `meta` 的 `version`（`verify` 的輸出也會列出 meta 版本，兩邊要一致）。回滾時 `reverse-export --since <V_cut>` 靠它找出「切換之後 v2 才有的寫入」。
  ```bash
  WR d1 execute food-log --remote --command "SELECT key, value FROM meta WHERE key IN ('version', 'epoch')"
  ```
  把數字寫在這裡（只寫數字，可以 commit 也可以不 commit）：`V_cut = ______`　`epoch = ______`

### 步驟 4　⛔ 發 Kyujin key，切換 Kyujin 設定，輪替舊的共享密鑰

1. 發新 key（寫到 `~/.config/studio/bots/kyujin.env`，權限 600，腳本不會印出 key，也不會連 Cloudflare）：
   ```bash
   node workers/api/scripts/bot-key.ts --email <OWNER_EMAIL> --origin https://<WORKER_HOST> --remote
   ```
   把印出的整行指令（同樣是 `WR d1 execute food-log --remote --command '…'`）貼上執行，才算寫進 D1。
2. 切換 Kyujin 的設定：Base URL 改成 `https://<WORKER_HOST>/bot/v1`，key 從 `kyujin.env` 讀（`FOODLOG_API_BASE`、`FOODLOG_API_KEY`），請求格式與欄位名照 [`docs/kyujin-api-v2.md`](../kyujin-api-v2.md)。用一個讀取請求（`read`）確認通了。
3. **輪替舊的共享密鑰**：把 GAS Script Property `SHARED_SECRET` 換成新的隨機值（舊的作廢）。這樣即使舊設定還留在某處，也無法再打舊 `/exec`。**新值要存進密碼管理員**：回滾時 `reverse-export` 要用它當 `GAS_SECRET`（它讀的是 GAS 目前的值），舊 App 與舊 Kyujin 設定回滾後也要用它（或換回舊值，見第四節 B、F）。
4. 之後若要輪替 Kyujin 的 key：用 `--key-file` 發第二把、切過去，再 `node workers/api/scripts/bot-key.ts --revoke <key id> --remote`（`--list` 可查 key id）撤銷舊的；撤銷後下一個請求就是 401。

### 步驟 5　⛔ 打開新網址、登入、加到主畫面、確認今天的資料

1. iPhone Safari 開 `https://<WORKER_HOST>/`，用 passkey 登入（備援：`login-code.ts` 發一次性登入碼）。
2. 加到主畫面，從主畫面圖示開啟再登入一次（主畫面 PWA 與 Safari 的儲存空間是分開的）。
3. 確認：今天的紀錄、體重、目標、收藏都在；記一筆、改一筆、離線記一筆再恢復網路，都同步成功。
4. D1 版本號已在動：
   ```bash
   WR d1 execute food-log --remote --command "SELECT key, value FROM meta WHERE key = 'version'"
   ```

### 步驟 6　⛔ 先打 tag `v1-final`，再部署 GitHub Pages 的導向版本

**順序不能反**：tag 要指向「還是 v1、已含唯讀開關」的 `main`，之後回滾要靠它。

1. 打 tag 並推送（在 `main` 還沒合併 `v2` 之前）：
   ```bash
   git fetch origin
   git tag -a v1-final origin/main -m "v1 final: last commit before the v2 cutover"
   git push origin v1-final
   ```
2. 導向版本（`vite-plugin-pwa` 的 `selfDestroying: true`，加上一個導向 `https://<WORKER_HOST>/` 的 `index.html`，讓舊主畫面上的 PWA 自己移除 Service Worker 並跳轉）。v1 的部署**只能從 `main` 的 `app/` 做**：
   ```bash
   git worktree add ../food-log-redirect -b redirect/v1-gh-pages v1-final
   cd ../food-log-redirect/app
   # 在這個暫時分支改好導向版本（selfDestroying、導向用的 index.html），本機 build 確認，再：
   npm ci && ./scripts/deploy-gh-pages.sh
   ```
   - 這個暫時分支**不要合併回任何分支**，部署完就刪（`git worktree remove`、`git branch -D redirect/v1-gh-pages`）。回滾時從 tag `v1-final` 重新部署，會用正常版本蓋掉它（第四節）。
   - 導向版本的內容目前不在 repo 裡；要在切換日前先寫好並測過（備妥後把差異記在 `docs/` 的某處，方便回滾時對照）。
3. 驗證：開 `<GH_PAGES_URL>`，舊 App 應跳到新網址；已安裝的舊主畫面圖示開啟後也會跳轉並移除舊 Service Worker。

### 步驟 7　⛔ 改 Kyujin 提醒裡的 `#weight` 連結

把 Kyujin 的提醒訊息裡原本指向舊 GitHub Pages 的 `#weight` 連結（舊網址 `<GH_PAGES_URL>#weight`）改成新網址：`https://<WORKER_HOST>/#weight`。改完先讓它發一則測試提醒，點連結確認直接進記體重畫面（新 App 的 hash 路由是否仍是 `#weight`，以 `apps/food-log` 為準）。

### 步驟 8　⛔ `v2` 合併回 `main`

`main` 從此就是 v2。`v2` 分支是長期分支，合併前依 [`AGENTS.md`](../../AGENTS.md) 的規則先把 `main` 的新改動合進 `v2`，並通過檢查：

```bash
git checkout v2 && git merge main        # 依 AGENTS.md 的對照表處理 app/** 衝突
test ! -e app
npx -y pnpm@10 install --frozen-lockfile
npx -y pnpm@10 -r typecheck
npx -y pnpm@10 -r test
npx -y pnpm@10 --filter @food-log/app build
```

通過後把 `v2` 合進 `main`（走 PR 或 fast-forward，依 Brian 當天決定）。**合併前確認 `v1-final` tag 已推送且指向正確的 commit**（`git show v1-final`）。合併後，v1 的部署腳本（`app/scripts/deploy-*.sh`）只存在於 `v1-final` tag 以前的歷史，回滾時從 tag 取用。

---

## 三、觀察兩週

每天花 2 分鐘檢查（做完在日期後打勾）：

- [ ] **`_ok.json` 每天都有**，且 `consistent` 是 `true`（第 1.5 節的檢查）
- [ ] **`mutation_outcomes` 的 `ok=0` 列是空的**（沒有被擋下的業務錯誤）：
  ```bash
  WR d1 execute food-log --remote --command "SELECT client_id, mutation_id, name, error, message, at FROM mutation_outcomes WHERE ok = 0 ORDER BY at DESC LIMIT 20"
  ```
  有列就逐筆查原因（裝置版本太舊、Kyujin 權限、重複店名等），不能放著。
- [ ] **沒有 5xx**：`WR tail --status error`（或儀表板的 Workers 指標），以及每日一次 `curl -s https://<WORKER_HOST>/api/health` 的 `authPrewarm` 是 `"ok"`
- [ ] Kyujin 的讀取與 `mutate` 正常（`created_by=kyujin` 的列有出現）
- [ ] CPU 時間沒有逼近免費方案的 10 ms 上限（`WR tail`；常超過就評估升級 $5 方案，計畫第 9 節）
- [ ] 每週做一次還原演練（第 1.5 節），耗時與結果記在演練紀錄
- [ ] 每週異地備份（放哪裡是第 8 節的待決定事項）

兩週內任何一天不通過，就停下來查；查不出或資料有疑慮就走第四節回滾。兩週全過才進入第六節。

---

## 四、回滾（⛔ Brian，目標 30 分鐘內）

觸發條件：資料對不上、持續 5xx、passkey／同步無法使用，而且當下修不好。**回滾之前，v2 裡切換後的新資料靠 `reverse-export` 寫回舊 Sheet，所以不要先清空或重建 D1。**

### 計時表（回滾演練與正式回滾都填）

階段 3 的回滾演練要計時；正式回滾也填同一張表。目標 30 分鐘。

| # | 步驟（對應計畫第 6 節） | 指令／動作 | 目標（分） | 開始 | 結束 | 實際（分） |
|---|---|---|---|---|---|---|
| 0 | 決定回滾，記下時間 T0 | | 0 | | | |
| A | 第 5 項：v2 停止收新資料（擋 `/sync` + 撤銷 Kyujin v2 key） | `WR deploy --var …`、`bot-key.ts --revoke` | 4 | | | |
| B | 第 1 項：GAS `READ_ONLY=0` | 指令碼屬性 | 2 | | | |
| C | 第 2 項：`reverse-export --since <V_cut> --dry-run`，確認 | 見下 | 5 | | | |
| D | 第 2 項：`reverse-export --since <V_cut>` 正式執行 | 見下 | 5 | | | |
| E | 第 3 項：從 `v1-final` 重新部署 GitHub Pages | 見下 | 8 | | | |
| F | 第 4 項：Kyujin 換回舊設定 | 見下 | 4 | | | |
| G | 驗證：舊 App 記一筆、Sheet 有列、Kyujin 讀得到 | | 2 | | | |
| | **合計** | | **30** | | | |

順序說明：計畫第 6 節的順序是 1→2→3→4→5。上表把第 5 項（A）提前，是因為 `reverse-export` 要讀的是 v2 的最終資料：先讓所有 push 回 409、並撤銷 Kyujin 的 v2 key（`MIN_CLIENT_VERSION` 擋不到 Kyujin），才不會在匯出之後又有新寫入而遺漏。如果當下不想先擋 v2（例如只是演練），照計畫原順序也可以，但 5 要在 2 之前至少「確認沒有新寫入」。實際順序以填表為準。

### 步驟

**A（第 5 項）v2 停止收新資料：兩件事都要做**

1. **擋住裝置的 push**：所有 `/sync` push 都回 409 `client_too_old`：

   ```bash
   WR deploy --var MIN_CLIENT_VERSION:9999
   ```

   語法已用 `WR deploy --help` 核對（`--var` 是 `KEY:VALUE` 陣列，可重複；加 `--dry-run` 試過會被接受，沒有部署）。`wrangler deploy` 是**從目前這份工作目錄的程式碼**建置並上傳，所以：
   - **必須在「正式環境現在跑的那個 commit」上執行。** 先 `git log -1 --format=%H`，對照你的部署紀錄（建議每次 `run deploy` 後把當時的 `git rev-parse HEAD` 記在切換日筆記裡；緊急部署時加 `--message "<短 SHA>"`，`WR deployments list` 才看得到）。不一致就先 `git checkout` 到正式環境的那個 commit 再部署；否則這次「只想改一個變數」的部署會把別的程式碼一起換上去。
   - `--var` 只覆蓋這個變數；其他 vars 仍來自 `wrangler.jsonc`，secrets 不受影響。
   - 回滾結束、要重新開放 v2 時，用正常的 `run deploy` 部署回 `"1"`（`wrangler.jsonc` 裡的值沒有被改）。
2. **撤銷 Kyujin 的 v2 key**：`MIN_CLIENT_VERSION` 只擋 `/sync`（`workers/api/src/routes/sync.ts`），**不擋 `/bot/v1/mutate`**，所以 Kyujin 仍可以寫進 v2，而這些寫入會發生在 `reverse-export` 之後，永遠不會回到 Sheet。先列出 key，再逐把撤銷（兩個指令都只印出 `WR d1 execute food-log --remote --command '…'`，貼上執行才生效；`--remote` 是 `bot-key.ts` 的旗標）：

   ```bash
   node workers/api/scripts/bot-key.ts --list --remote
   node workers/api/scripts/bot-key.ts --revoke <key id> --remote     # 列表裡每一把 key 都撤銷
   ```

   撤銷沒有快取，下一個請求就是 401（`docs/kyujin-api-v2.md`：Kyujin 收到 401 不重試，會通知 Brian）。**步驟 F 仍然成立**：F 是把 Kyujin 的設定改回舊 GAS（`<GAS_EXEC_URL>` + 共享密鑰），那是另一條路；撤銷 v2 key 只是在 F 完成前擋住它對 v2 的寫入，並保證 `reverse-export` 看到的是最終資料。之後若重新切到 v2，要再發新 key（切換步驟 4）。

**B（第 1 項）GAS `READ_ONLY=0`**：Apps Script 編輯器 → 專案設定 → 指令碼屬性，把 `READ_ONLY` 改成 `0`（或刪除）。**先不要動 `SHARED_SECRET`**：`reverse-export` 要用它當 `GAS_SECRET`（第二節步驟 4 輪替後的新值，在密碼管理員裡；也可以從指令碼屬性複製）。舊 App 與舊 Kyujin 設定要用哪個值，在步驟 F 處理。

**C、D（第 2 項）把切換之後 v2 的寫入反向寫回 Sheet。** 先把 v2 的最終狀態傾印下來（A 已擋住所有寫入，所以這份就是最終資料），再 dry-run，確認後正式執行：

```bash
mkdir -p tools/migrate/out
MG d1-dump-command                                # 印出唯讀指令；貼上執行 → tools/migrate/out/d1-dump.json
export GAS_URL=<GAS_EXEC_URL>
read -s GAS_SECRET; export GAS_SECRET             # GAS 目前的 SHARED_SECRET

# C：dry-run。--fetch-base 用唯讀的 read / history 抓 Sheet 現況，計畫只包含真的有差別的步驟
MG reverse-export --dump out/d1-dump.json --since <V_CUT> --user-id <OWNER_USER_ID> --fetch-base --dry-run --plan-out out/rollback-plan.json

# D：確認計畫（看得懂每一步、數量合理）後，同一個指令拿掉 --dry-run，正式寫入
MG reverse-export --dump out/d1-dump.json --since <V_CUT> --user-id <OWNER_USER_ID> --fetch-base
```

- `<OWNER_USER_ID>` 用 `WR d1 execute food-log --remote --command "SELECT id, email FROM user"` 查（`<V_CUT>` 是切換步驟 3 記下的數字）。
- 轉成的 GAS 動作：`upsertStore`、`upsertItem`、`setConfig`、`append`／`update`、`upsertWeight`、`softDelete`。
- **重複執行 D（含 `--fetch-base`），直到它回報 0 steps**：每次只送 Sheet 上還有差別的步驟，所以失敗後重跑、或跑兩次都是安全的；0 steps 就等於「Sheet 已經和 v2 一致」，這是這一步的驗證。有步驟失敗時結束碼是 1，輸出會列出失敗的步驟。
- 舊 Sheet 上沒有 id 的體重列無法用 id 定位刪除（`reverse-export` 的已知限制，輸出會標示）。
**E（第 3 項）從 tag `v1-final` 重新部署 GitHub Pages**，取代「會自我移除的 Service Worker」導向版本：

```bash
git worktree add ../food-log-rollback v1-final
cd ../food-log-rollback/app
npm ci && ./scripts/deploy-gh-pages.sh
```

（若 GAS 的程式本身也要回到 `v1-final` 的版本：`npm run deploy:gas`，在同一個 `app/` 下。一般情況 GAS 沒改過，不需要。）部署完用舊主畫面圖示開啟，確認 Service Worker 已被新的取代、App 載入舊版，並能連到 GAS。已被導向版本清掉 Service Worker 的裝置重新開 `<GH_PAGES_URL>` 即可。

**F（第 4 項）Kyujin 換回舊設定**：`reverse-export` 跑完（D 回報 0 steps）之後，才處理共享密鑰：舊 App 與舊 Kyujin 設定原本是用輪替前的舊值，二選一，**不要兩邊值不一致**：（1）把 GAS 的 `SHARED_SECRET` 改回輪替前的舊值（若還留著），或（2）把 GAS 目前的 `SHARED_SECRET` 貼進舊 App 與 Kyujin 的設定。然後把 Kyujin 的設定改回舊 `<GAS_EXEC_URL>`，請求格式回到 [`docs/kyujin-api.md`](../kyujin-api.md)。提醒裡的 `#weight` 連結也改回 `<GH_PAGES_URL>#weight`。

**G 驗證**：舊 App 記一筆、重新整理仍在；Sheet 有那一列；Kyujin 的讀取與一個 `append` 都正常。

回滾完成後：把計時表、遇到的問題與 `V_cut` 寫成事後檢討，再決定 v2 要修什麼才重新切換。

---

## 五、災難還原（D1 遺失或損毀）⛔ Brian

這一節是「v2 自己的資料壞了或不見了」，從 R2 的每日匯出把資料放回 D1。和第四節不同：第四節是退回 v1（舊 Sheet），這一節是留在 v2。**能還原到的最新狀態是「最後一份 `consistent: true` 的匯出」，那之後的寫入會遺失**（最壞約 24 小時）。裝置本機若有較新的資料，見第 6 步。

匯出檔不含登入資料（`user`、`session`、`account`、`passkey`、`apikey`、`verification`、`login_codes` 都不匯出，見 `cron/export.ts`），產生的還原 SQL 也**永遠不會動這些表和 `export_progress`**；它清掉並重建的是：六張業務表（`stores`、`items`、`logs`、`weights`、`favorites`、`config`）、`sync_clients`、`mutation_outcomes`，並把 `meta.version` 設成「列版本號最大值與 `versionAtEnd` 較大者」、`meta.epoch` 設成**新的隨機值**（所有裝置下次 pull 都會得到 `reset:true`，從伺服器重建本機資料）。

1. **擋住寫入**（還原期間不能有人寫）：照第四節步驟 A，`WR deploy --var MIN_CLIENT_VERSION:9999`（注意要在正式環境那個 commit 上執行），並撤銷 Kyujin 的 key。
2. **找最近一份可用的匯出並下載**：從最新的日期往回找，第一份 `_ok.json` 存在且 `"consistent": true` 的就是了（做法見第 1.5 節；`restore-drill` 會拒絕 `consistent: false`）。下載到 `<DRILL_DIR>`（repo 外）。
3. **D1 的狀況決定要不要 `--user-id`**：
   - **(a) D1 還在、只有業務資料壞了**：登入資料沒事，owner 的 `user.id` 沒變，**不用 `--user-id`**。
   - **(b) D1 整個重建**（`WR d1 create food-log`、把新的 `database_id` 填進 `workers/api/wrangler.jsonc`、`run deploy` 套用 migrations；secrets 若是新 Worker 要重新 `secret put`）：登入資料是空的，要重新建 owner，而新 owner 的 `user.id` 是新的隨機值，和匯出檔裡的 `user_id` 不同。依序：
     ```bash
     node workers/api/scripts/bootstrap-owner.ts --email <OWNER_EMAIL> --name <顯示名稱> --remote     # 貼上執行印出的指令
     WR d1 execute food-log --remote --command "SELECT id FROM user"                                   # 記下新的 id，下面叫 <NEW_USER_ID>
     ```
     匯出檔只有單一使用者，所以下一步帶 `--user-id <NEW_USER_ID>`，所有列的 `user_id` 會改成新 id。
4. **產生還原 SQL**（只讀本機資料夾，不碰 R2、D1；演練不是 OK 就不會產生檔案，已存在的檔案不會被覆蓋）：
   ```bash
   cd tools/ops
   node src/restore-drill.ts --dir <DRILL_DIR> --emit-sql <DRILL_DIR>/restore.sql                          # (a)
   node src/restore-drill.ts --dir <DRILL_DIR> --emit-sql <DRILL_DIR>/restore.sql --user-id <NEW_USER_ID>   # (b)
   ```
   輸出會列出每張表的列數、每日加總與耗時，最後印出 `SQL written: …`（含新的 epoch 與 version）。`restore.sql` 的第一組語句會確認目標資料庫裡真的有要寫入的 `user.id`：沒有就在刪除任何東西之前整批中止（所以 (b) 一定要先建 owner）。
   - 可先在本機 D1 預演：`WR d1 migrations apply food-log --local`，再 `WR d1 execute food-log --local --file <DRILL_DIR>/restore.sql`（本機要先有同 id 的 `user` 列，否則守門會擋下；這是預期的）。
5. **⛔ 套用到正式 D1**：
   ```bash
   WR d1 execute food-log --remote --file <DRILL_DIR>/restore.sql
   ```
   檔案以刪除開頭、沒有 BEGIN／COMMIT（D1 不接受），所以**中途失敗就原檔再套一次**。每條語句都不超過 D1 的語句大小上限（每個 INSERT 最多 100 列且約 50 KB 以內）。
6. **驗證**：
   ```bash
   WR d1 execute food-log --remote --command "SELECT key, value FROM meta"
   WR d1 execute food-log --remote --command "SELECT (SELECT COUNT(*) FROM stores) AS stores, (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM logs) AS logs, (SELECT COUNT(*) FROM weights) AS weights, (SELECT COUNT(*) FROM favorites) AS favorites, (SELECT COUNT(*) FROM config) AS config"
   ```
   `meta.version` 應等於演練輸出的 version，`meta.epoch` 應等於 `SQL written` 那行的新 epoch，各表列數（含已刪除）應等於演練輸出的「expected」欄。
7. **重新開放**：`run deploy` 部署回 `MIN_CLIENT_VERSION` `"1"`；用新發的 key 重新設定 Kyujin（`bot-key.ts`，見切換步驟 4）。用手機開 App，確認它重置後今天（匯出日之前）的資料都在。
8. **裝置本機比匯出新的資料**：匯出日之後才記的資料如果還在某台裝置的本機（尚未同步或已同步但還原後遺失），重置時是否保留待送變更，以 sync client 的實作為準；還原前先到各裝置確認有沒有待送／失敗清單，必要時手動補記。Sheet（舊 v1）只到切換日，不是這份資料的來源。

---

## 六、30 天後清理（⛔ Brian）

**條件**：切換滿 30 天、觀察兩週的檢查全過、近期每週的還原演練都 OK、確認不再需要回滾（`v1-final` tag 會保留，永遠可以從它重建 v1）。

1. **封存 Sheet**：在 Google Drive 複製一份存檔（檔名加上日期），原 Sheet 改為唯讀／移到封存資料夾。Sheet 內有個人飲食資料，不要公開分享。
2. **關閉 GAS**：把 `/exec` 的 Web App 部署停用（Apps Script 編輯器 → 部署 → 管理部署作業 → 封存），並刪除 `SHARED_SECRET`。
3. **刪除 `legacy/`**（在 `v2`／現在的 `main` 上，走一般 PR）：
   ```bash
   git rm -r legacy
   ```
   同時移除只服務 `legacy/` 的東西：CI 裡的 legacy 對照測試、`packages/core/test/gas-parity.test.ts`（計畫第 5 節：「保留到切換」）、`AGENTS.md` 的 `legacy/` 說明與合併規則（`main` 上不再有 v1 熱修）。移除後跑 `npx -y pnpm@10 -r typecheck` 與 `npx -y pnpm@10 -r test`。
4. **停掉導向版本**：GitHub Pages 導向頁可以再保留一陣子（舊書籤、舊主畫面圖示），確認沒有流量後再關閉 Pages。
5. 確認每日匯出與每週異地備份已成為例行；R2 `exports/` 的保留天數另行決定（第 8 節）。
