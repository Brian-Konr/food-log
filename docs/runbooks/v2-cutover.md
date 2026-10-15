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

`tools/migrate` 的各個 CLI（`gas-client`、`fetch-sheet`、`transform`、`emit-sql`、`verify`、`reverse-export`）由階段 3 提供。**這份手冊只寫名稱與計畫裡確定的旗標（`emit-sql --reset`、`reverse-export --since`、`--dry-run`），其他旗標、輸入輸出檔名、需要的環境變數名稱一律以各 CLI 的 `--help` 為準。** `gas-client` 需要的 `/exec` 網址與共享密鑰從環境變數讀：用 `read -s` 設在當下的 shell，不寫進 shell history，不貼進聊天。匯入的中間檔放 `tools/migrate/out/`（已 gitignore，security test 會檢查它沒被 git 追蹤）。

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
   把印出的 `wrangler d1 execute … --command '…'` 貼上執行。
2. 發一次性登入碼（15 分鐘，單次有效；計時從「印出的指令實際執行」開始）：
   ```bash
   node workers/api/scripts/login-code.ts --email <OWNER_EMAIL> --remote
   ```
   登入碼只會印一次，不要存檔、不要貼進聊天；執行印出的指令把雜湊寫進 D1，然後在新 App 的登入畫面輸入。
3. 登入後，在設定裡**註冊 passkey**（用 iPhone 主畫面 PWA 的環境註冊，因為 iOS 主畫面 PWA 與 Safari 的 cookie／passkey 是分開的，計畫第 9 節）。註冊完登出再用 passkey 登入一次，確認可用。登入碼只當備援。

### 1.4 ⛔ Brian-only：可重複的匯入（從舊 Sheet 到 D1）

用真實資料匯入前確認 `tools/migrate/out/` 沒被 git 追蹤（`git status` 看不到它）。流程（旗標以各 CLI 的 `--help` 為準）：

```text
gas-client / fetch-sheet   →  抓整份 Sheet（read，再用 history 往回翻到底）
transform                  →  純函式轉換，anomalies[] 列出所有調整
emit-sql                   →  產生 SQL（依 id upsert）
wrangler d1 execute --remote --file <emit-sql 的輸出檔>
verify                     →  比對兩邊
```

- 雙軌期用不加 `--reset` 的 `emit-sql`（依 id upsert，可以重複跑，結果相同）。
- 仔細讀 `transform` 的 `anomalies[]`（體重同一天多筆保留最新一筆、`day` 修正等）；有看不懂的調整，先問再切換。
- `verify` 要全對：每張表未刪除／已刪除的列數、每日營養素加總、Config 每個值、收藏集合、每日體重。有差異不進入切換日。
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

### 步驟 3　⛔ 最後一次匯入（fetch → transform → `emit-sql --reset` → 套用 → verify），記下 `V_cut`

旗標以各 CLI 的 `--help` 為準：

```text
fetch-sheet                 # 此時 GAS 唯讀，抓到的就是最終資料
transform
emit-sql --reset            # 清空 D1 業務表，寫入全部資料，並寫入新的 epoch（所有裝置會重置並重新同步）
wrangler d1 execute --remote --file <emit-sql 的輸出檔>
verify                      # 必須全對
```

套用指令（檔名以 `emit-sql` 的輸出為準）：

```bash
WR d1 execute food-log --remote --file <emit-sql 的輸出檔>
```

- `--reset` 會改 epoch，已登入的裝置會被要求重置本機資料再 pull；匯入前先確認第 2 步已完成。
- `verify` 有任何差異就**停下**，不要繼續；差異排除前保持 GAS 唯讀（唯讀期間舊資料不會再變，可以安心重來）。
- **記下 `V_cut`**：套用完成後，D1 `meta` 的 `version`（以 `verify` 的輸出為準，也用下面的 SQL 交叉確認）。回滾時 `reverse-export --since <V_cut>` 靠它找出「切換之後 v2 才有的寫入」。
  ```bash
  WR d1 execute food-log --remote --command "SELECT key, value FROM meta WHERE key IN ('version', 'epoch')"
  ```
  把數字寫在這裡（只寫數字，可以 commit 也可以不 commit）：`V_cut = ______`　`epoch = ______`

### 步驟 4　⛔ 發 Kyujin key，切換 Kyujin 設定，輪替舊的共享密鑰

1. 發新 key（寫到 `~/.config/studio/bots/kyujin.env`，權限 600，腳本不會印出 key，也不會連 Cloudflare）：
   ```bash
   node workers/api/scripts/bot-key.ts --email <OWNER_EMAIL> --origin https://<WORKER_HOST> --remote
   ```
   把印出的 `wrangler d1 execute … --command '…'` 貼上執行，才算寫進 D1。
2. 切換 Kyujin 的設定：Base URL 改成 `https://<WORKER_HOST>/bot/v1`，key 從 `kyujin.env` 讀（`FOODLOG_API_BASE`、`FOODLOG_API_KEY`），請求格式與欄位名照 [`docs/kyujin-api-v2.md`](../kyujin-api-v2.md)。用一個讀取請求（`read`）確認通了。
3. **輪替舊的共享密鑰**：把 GAS Script Property `SHARED_SECRET` 換成新的隨機值（舊的作廢）。這樣即使舊設定還留在某處，也無法再打舊 `/exec`。新值不用記，回滾時要用再換（見第四節）。
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

兩週內任何一天不通過，就停下來查；查不出或資料有疑慮就走第四節回滾。兩週全過才進入第五節。

---

## 四、回滾（⛔ Brian，目標 30 分鐘內）

觸發條件：資料對不上、持續 5xx、passkey／同步無法使用，而且當下修不好。**回滾之前，v2 裡切換後的新資料靠 `reverse-export` 寫回舊 Sheet，所以不要先清空或重建 D1。**

### 計時表（回滾演練與正式回滾都填）

階段 3 的回滾演練要計時；正式回滾也填同一張表。目標 30 分鐘。

| # | 步驟（對應計畫第 6 節） | 指令／動作 | 目標（分） | 開始 | 結束 | 實際（分） |
|---|---|---|---|---|---|---|
| 0 | 決定回滾，記下時間 T0 | | 0 | | | |
| A | 第 5 項：v2 停止收新資料 | `MIN_CLIENT_VERSION=9999` | 2 | | | |
| B | 第 1 項：GAS `READ_ONLY=0` | 指令碼屬性 | 2 | | | |
| C | 第 2 項：`reverse-export --since <V_cut> --dry-run`，確認 | 見下 | 6 | | | |
| D | 第 2 項：`reverse-export --since <V_cut>` 正式執行 | 見下 | 6 | | | |
| E | 第 3 項：從 `v1-final` 重新部署 GitHub Pages | 見下 | 8 | | | |
| F | 第 4 項：Kyujin 換回舊設定 | 見下 | 4 | | | |
| G | 驗證：舊 App 記一筆、Sheet 有列、Kyujin 讀得到 | | 2 | | | |
| | **合計** | | **30** | | | |

順序說明：計畫第 6 節的順序是 1→2→3→4→5。上表把第 5 項（A）提前，是因為 `reverse-export` 要讀的是 v2 的最終資料：先讓所有 push 回 409，才不會在匯出之後又有新寫入而遺漏。如果當下不想先擋 v2（例如只是演練），照計畫原順序也可以，但 5 要在 2 之前至少「確認沒有新寫入」。實際順序以填表為準。

### 步驟

**A（第 5 項）v2 停止收新資料**：所有 push 都回 409 `client_too_old`，不再收新資料：

```bash
WR deploy --var MIN_CLIENT_VERSION:9999
```

（旗標以 `WR deploy --help` 為準；也可以改 `workers/api/wrangler.jsonc` 的 `MIN_CLIENT_VERSION` 後重新 `run deploy`，但比較慢。）回滾結束、要重新開放 v2 時，用正常的 `run deploy` 部署回 `"1"`。

**B（第 1 項）GAS `READ_ONLY=0`**：Apps Script 編輯器 → 專案設定 → 指令碼屬性，把 `READ_ONLY` 改成 `0`（或刪除）。同時**把 `SHARED_SECRET` 換回舊 Kyujin 設定與舊 App 要用的值**（第二節步驟 4 輪替過它；舊值若已不可得，就產生新值，並在 F 步驟更新所有舊設定，舊 App 的共享密鑰要重新貼）。

**C、D（第 2 項）把切換之後 v2 的寫入反向寫回 Sheet**（旗標以 `--help` 為準）：

```text
reverse-export --since <V_cut> --dry-run     # 先看會寫什麼：讀 version > V_cut 的列，依版本順序轉成 GAS action
reverse-export --since <V_cut>               # 確認無誤後正式執行
```

轉成的 GAS action 有：`upsertStore`、`upsertItem`、`setConfig`、`append`／`update`、`upsertWeight`、`softDelete`。`--dry-run` 可以重跑；正式執行失敗可以重跑（冪等）。完成後用 `verify`（或人工抽查幾天的加總）確認 Sheet 與 v2 一致。

**E（第 3 項）從 tag `v1-final` 重新部署 GitHub Pages**，取代「會自我移除的 Service Worker」導向版本：

```bash
git worktree add ../food-log-rollback v1-final
cd ../food-log-rollback/app
npm ci && ./scripts/deploy-gh-pages.sh
```

（若 GAS 的程式本身也要回到 `v1-final` 的版本：`npm run deploy:gas`，在同一個 `app/` 下。一般情況 GAS 沒改過，不需要。）部署完用舊主畫面圖示開啟，確認 Service Worker 已被新的取代、App 載入舊版，並能連到 GAS。已被導向版本清掉 Service Worker 的裝置重新開 `<GH_PAGES_URL>` 即可。

**F（第 4 項）Kyujin 換回舊設定**：把 Kyujin 的設定改回舊 `<GAS_EXEC_URL>` 與（B 步驟處理過的）共享密鑰，請求格式回到 [`docs/kyujin-api.md`](../kyujin-api.md)。提醒裡的 `#weight` 連結也改回 `<GH_PAGES_URL>#weight`。

**G 驗證**：舊 App 記一筆、重新整理仍在；Sheet 有那一列；Kyujin 的讀取與一個 `append` 都正常。

回滾完成後：把計時表、遇到的問題與 `V_cut` 寫成事後檢討，再決定 v2 要修什麼才重新切換。

---

## 五、30 天後清理（⛔ Brian）

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
