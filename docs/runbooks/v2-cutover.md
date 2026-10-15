# food-log v2 切換與回滾手冊

| 項目 | 內容 |
|---|---|
| 依據 | [`docs/plans/v2.md`](../plans/v2.md) 第 1 節（`v1-final` tag）、§3.3（D1 schema）、第 4 節階段 1 步驟 5 + 階段 3 + 階段 4、第 6 節（回滾）、第 8 節（Brian 的操作） |
| 執行 | **全部標 ⛔ 的步驟只有 Brian 能做**；agent 只負責寫好指令，不部署、不碰真實的 D1、R2、Sheet、Apps Script |
| 目標 | 切換當天停機（舊系統唯讀）越短越好；出問題 30 分鐘內回到 v1 |
| 不放什麼 | key、共享密鑰、email、登入碼一律不進 repo（repo 是公開的）。Worker 網址 `food-log.brian-konr.workers.dev` 與 `/exec` 網址不是秘密（前者在 `workers/api/wrangler.jsonc`，後者在 `main` 的 `app/deploy/gas-url`） |

## 現在要做的 vs 之後才做的

| 時間 | 章節 | 內容 |
|---|---|---|
| **現在**（雙軌期，v1 照常用） | [一、雙軌期](#一雙軌期舊的-v1-照常使用v2-平行建好) | 1.1 建 Cloudflare 資源 → 1.2 第一次部署（含前端，`deploy:with-app`）與 secrets → 1.3 bootstrap owner、登入碼登入、iPhone 加主畫面並註冊 passkey → 1.4 用真實資料試匯入一次並 `verify` → 1.5 確認每日匯出、做一次還原演練 |
| 之後 | [二、切換當天](#二切換當天-每一步都由-brian-執行) | 雙軌期的檢查全過、選好日子才做 |
| 之後 | [三、觀察兩週](#三觀察兩週) | 切換後每天 2 分鐘 |
| 之後（需要時） | [四、回滾](#四回滾-brian目標-30-分鐘內) | 切換後出問題才做 |
| 之後（需要時） | [五、災難還原](#五災難還原d1-遺失或損毀-brian) | D1 壞掉才做 |
| 之後 | [六、30 天後清理](#六30-天後清理-brian) | 切換滿 30 天 |

**不要刪除 spike**：Worker 與 D1 `food-log-spike` 要保留到 iPhone 7 天檢查（[`v2-spike.md`](../plans/v2-spike.md) 的 4b，2026-10-22 23:30 之後）做完。

## 零、指令慣例與終端機準備

- **所有指令都從 v2 checkout 的根目錄執行**（Brian 的電腦上是 `~/Documents/personal/GitHub/food-log-v2`）。需要別的目錄時，區塊裡會自己寫 `cd`。
- 一個區塊一個指令（或一組必須一起跑的指令），原樣貼上即可。區塊裡**沒有 `#` 註解**：zsh 預設不把貼上的 `#` 當註解，會變成指令的參數。
- pnpm 沒有全域安裝，一律 `npx -y pnpm@10 …`；wrangler 一律 `npx -y pnpm@10 --filter @food-log/api exec wrangler …`（它會在 `workers/api/` 執行，讀那裡的 `wrangler.jsonc`，所以檔案路徑一律用絕對路徑）。D1 叫 `food-log`、R2 bucket 叫 `food-log-exports`。
- **部署一律用 `deploy:with-app`**（Worker + 前端）。**不要再用 `run deploy`**：它只部署 API、不帶靜態檔，會把已經上線的前端拿掉。
- 秘密只用互動輸入（`read -rs`）或用管線直接送進 `wrangler secret put`，不寫進檔案、不貼進聊天。
- 下文用到的 shell 變數（`OWNER_EMAIL`、`OWNER_USER_ID`、`GAS_URL`、`GAS_SECRET`、`DAY`、`DRILL_DIR`）**只在當下這個終端機視窗有效**；開新視窗要重新設定（照下面 0.1–0.3 或該步驟的指令）。

### 0.1 每次開新終端機：進到 repo 根目錄

```bash
cd ~/Documents/personal/GitHub/food-log-v2
```

### 0.2 每次開新終端機：設定 owner email（只存在這個 shell，不進任何檔案）

```bash
printf 'Owner email: '; read -r OWNER_EMAIL
```

這個 email 也必須是 `ALLOWED_EMAILS` secret 的值（1.2 會設定）。

### 0.3 取得 owner 的 user id（1.3 建好 owner 之後才查得到）

`--user-id` 要的是 owner 的 `user.id`（不是 email）。這個指令從正式 D1 讀出來（唯讀），存進 `OWNER_USER_ID`：

```bash
OWNER_USER_ID="$(npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --json --command "SELECT id FROM user" | node -e 'const ids = JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results.map((r) => r.id); if (ids.length === 1) console.log(ids[0]); else { console.error("expected 1 user, got " + ids.length); process.exit(1) }')" && echo "OWNER_USER_ID=$OWNER_USER_ID"
```

應該印出 `OWNER_USER_ID=` 加一個 UUID。

### 遷移工具（`tools/migrate`，套件 `@food-log/migrate`）

| 腳本 | 用途 |
|---|---|
| `fetch-sheet` | 讀整份 Sheet（只用唯讀的 `read` 與 `history`），寫成 `tools/migrate/out/sheet-<時間>.json`（權限 0600）。需要環境變數 `GAS_URL`、`GAS_SECRET` |
| `emit-sql` | 轉換並產生匯入 SQL：`tools/migrate/out/import-<時間>/import-NNN-of-MMM.sql` 與 `anomalies.json` |
| `d1-dump-command` | 印出把 D1 傾印成 JSON 的唯讀指令（下文直接寫出那個指令） |
| `verify` | 比對 Sheet 與 D1 傾印；任何不符結束碼 1 |
| `reverse-export` | 回滾用：把 `version > V_cut` 的 v2 資料寫回 Sheet |

- 這些腳本的工作目錄是 `tools/migrate/`，所以下文傳給它們的路徑一律是絕對路徑（`"$PWD/…"` 或變數）。
- **`--reset` 一律加**：先刪掉 owner 的六張業務表再整批寫入，並換新的 epoch（已登入的裝置下次 pull 會重置並重新同步）。不加 `--reset` 只適用於「完全空的 D1」，而 1.3 登入、試用後 D1 就不一定是空的，所以這份手冊每一次匯入都加。
- `tools/migrate/out/` 裡全是私人資料：已 gitignore（security test 會檢查它沒被 git 追蹤），不要複製到 repo 以外的共享位置。

---

## 一、雙軌期（舊的 v1 照常使用，v2 平行建好）

目標：切換當天只剩「最後一次匯入 + 驗證 + 換網址」。1.4、1.5 可以重複做。

### 1.0 ⛔ Brian-only：準備

1. 安裝依賴（v2 checkout 第一次用、或 `pnpm-lock.yaml` 有變時）：

   ```bash
   npx -y pnpm@10 install --frozen-lockfile
   ```

2. 確認 wrangler 已登入、是對的帳號：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler whoami
   ```

   沒登入就先跑下面這個（會開瀏覽器授權），再跑一次 `whoami`：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler login
   ```

### 1.1 ⛔ Brian-only：建立 Cloudflare 資源（只做一次）

1. 建 D1：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 create food-log
   ```

   輸出會有 `"database_id": "…"`（UUID，不是秘密）。把它填進 `workers/api/wrangler.jsonc` 的 `d1_databases[0].database_id`（取代 `00000000-0000-0000-0000-000000000000`）並 commit 到 `v2`，**部署前一定要先做**。

2. 建 R2 bucket（帳號第一次用 R2 時，要先在 Cloudflare 儀表板啟用 R2；若要求綁卡，是計畫第 8 節的待決定事項）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler r2 bucket create food-log-exports
   ```

3. Rate limit（`TELEMETRY_LIMITER`）**不用建**：`wrangler.jsonc` 的 `namespace_id` `"1001"` 是自己挑的數字，只要在帳號內不和別的 Worker 重複即可（spike 沒有用 rate limit）。

### 1.2 ⛔ Brian-only：第一次部署（Worker + 前端）與 secrets

1. 確認 `database_id` 已經不是全 0：

   ```bash
   grep -n '"database_id"' workers/api/wrangler.jsonc
   ```

2. 部署（依序跑 typecheck → 測試 → build 前端 → `wrangler d1 migrations apply food-log --remote` → `wrangler deploy` 帶 assets；migrations 會問是否繼續，答 yes）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api run deploy:with-app
   ```

   最後應印出 `https://food-log.brian-konr.workers.dev`。passkey 的 RP ID 就是這個主機名；之後換網域＝所有 passkey 要重新註冊。

3. 設定 `BETTER_AUTH_SECRET`（隨機值直接用管線送進 wrangler，不會顯示在畫面上，也不用貼）：

   ```bash
   openssl rand -base64 32 | npx -y pnpm@10 --filter @food-log/api exec wrangler secret put BETTER_AUTH_SECRET
   ```

4. 設定 `ALLOWED_EMAILS`（用 0.2 設好的 `OWNER_EMAIL`）：

   ```bash
   printf '%s' "$OWNER_EMAIL" | npx -y pnpm@10 --filter @food-log/api exec wrangler secret put ALLOWED_EMAILS
   ```

5. 確認兩個 secret 都在（只列名稱，不顯示值）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler secret list
   ```

6. 健康檢查：

   ```bash
   curl -s https://food-log.brian-konr.workers.dev/api/health
   ```

   應該是 `{"ok":true,"clientVersion":…,"authPrewarm":"ok"}`。`authPrewarm` 不是 `"ok"`（例如 `"skipped"`）就是 secret 還沒生效，等幾秒再試。

7. （可選）看即時日誌與每個請求的 CPU time（免費方案每個請求 10 ms），Ctrl+C 結束：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler tail --format pretty
   ```

### 1.3 ⛔ Brian-only：建立 owner、用登入碼登入、iPhone 註冊 passkey

`workers/api/scripts/*` 只印出要執行的 SQL 指令；下面的寫法會把印出的內容顯示在畫面上，同時執行其中那一行 `wrangler d1 execute … --remote`。需要 0.2 的 `OWNER_EMAIL`。

1. 建 owner（每個資料庫只做一次）：

   ```bash
   sh -c "$(node workers/api/scripts/bootstrap-owner.ts --email "$OWNER_EMAIL" --name Brian --remote | tee /dev/stderr | grep -v '^#')"
   ```

   最後應看到 `1 command executed successfully` 之類的訊息。接著照 0.3 取得 `OWNER_USER_ID`，確認剛好一個 user。

2. iPhone：Safari 打開 `https://food-log.brian-konr.workers.dev/` → 分享 → 加入主畫面 → **從主畫面圖示開啟**（iOS 主畫面 PWA 與 Safari 的 cookie／passkey 是分開的，登入與註冊都要在主畫面 PWA 裡做，計畫第 9 節）。

3. 發一次性登入碼（15 分鐘，單次有效；計時從指令執行時開始）。登入碼印在 `# login code` 下一行，只會出現這一次，不要存檔、不要貼進聊天：

   ```bash
   sh -c "$(node workers/api/scripts/login-code.ts --email "$OWNER_EMAIL" --remote | tee /dev/stderr | grep -v '^#')"
   ```

   在主畫面 PWA 的登入畫面選登入碼，輸入 email 與登入碼。

4. 登入後：設定 → 帳號 →「新增 passkey」。完成後登出，再用 passkey 登入一次，確認可用。登入碼只當備援（過期或用過就重跑第 3 步）。

### 1.4 ⛔ Brian-only：用真實資料匯入（從舊 Sheet 到 D1），可重複

需要 0.3 的 `OWNER_USER_ID`。

1. 確認 `tools/migrate/out/` 沒被 git 追蹤（輸出應該是空的）：

   ```bash
   git ls-files tools/migrate/out
   ```

2. 設定舊 Apps Script 的網址（從 `main` 的 `app/deploy/gas-url` 取得）：

   ```bash
   git fetch origin main && export GAS_URL="$(git show origin/main:app/deploy/gas-url)" && echo "$GAS_URL"
   ```

3. 輸入舊的共享密鑰（v1 App 設定裡用的那個；不會顯示）：

   ```bash
   printf 'GAS_SECRET: '; read -rs GAS_SECRET; echo; export GAS_SECRET
   ```

4. 抓整份 Sheet（只讀）：

   ```bash
   npx -y pnpm@10 --filter @food-log/migrate run fetch-sheet
   ```

   最後一行是 `wrote …/tools/migrate/out/sheet-<時間>.json`，前面印出每張表抓到幾列。

5. 選最新的 Sheet 快照：

   ```bash
   SHEET="$(ls -t "$PWD"/tools/migrate/out/sheet-*.json | head -1)" && echo "$SHEET"
   ```

6. 產生匯入 SQL（`--reset`，見「指令慣例」）：

   ```bash
   npx -y pnpm@10 --filter @food-log/migrate run emit-sql --sheet "$SHEET" --user-id "$OWNER_USER_ID" --reset
   ```

   印出每張表列數（`in -> out`）、anomalies 統計、`wrote N file(s) and anomalies.json to …/import-<時間>`，以及要依序執行的指令（下一步的迴圈會照同樣順序執行，不用一個一個貼）。

7. 仔細讀 `anomalies.json`（體重同一天多筆保留最新一筆、`day` 修正、補 id 等）；有看不懂的調整，先問再切換：

   ```bash
   IMPORT_DIR="$(ls -td "$PWD"/tools/migrate/out/import-*/ | head -1)" && echo "$IMPORT_DIR" && ls "$IMPORT_DIR"
   ```

   ```bash
   less "${IMPORT_DIR}anomalies.json"
   ```

8. 依序套用到正式 D1（第一個檔先刪掉 owner 的業務表並寫入新 epoch；任何一個檔失敗就停下）：

   ```bash
   for f in "$IMPORT_DIR"import-*.sql; do echo "== $f"; npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --yes --file "$f" || break; done
   ```

   中途失敗：修好原因後**從第一個檔重新全部跑**（重跑同一個迴圈即可；每列是 upsert，第一個檔會先清掉 owner 的資料，所以不能只跑後面某個檔）。

9. 傾印 D1（唯讀）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --json --command 'SELECT '\''meta'\'' AS _t, key, value FROM meta; SELECT '\''stores'\'' AS _t, * FROM stores; SELECT '\''items'\'' AS _t, * FROM items; SELECT '\''logs'\'' AS _t, * FROM logs; SELECT '\''weights'\'' AS _t, * FROM weights; SELECT '\''favorites'\'' AS _t, * FROM favorites; SELECT '\''config'\'' AS _t, * FROM config' > tools/migrate/out/d1-dump.json
   ```

   （這就是 `npx -y pnpm@10 --filter @food-log/migrate run d1-dump-command` 印出的指令。）

10. 比對（必須結束碼 0）：

    ```bash
    npx -y pnpm@10 --filter @food-log/migrate run verify --sheet "$SHEET" --dump "$PWD/tools/migrate/out/d1-dump.json" --user-id "$OWNER_USER_ID"
    ```

    `verify` 要全對：每張表未刪除／已刪除的列數與 id 集合、每日營養素加總、每日體重、Config 每個值、收藏集合。預期值是「原始 Sheet 扣掉 `anomalies` 記錄的調整」，所以沒記在 anomalies 裡的差異就是 bug，要回報。

11. 確認 D1 的版本號有動：

    ```bash
    npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --command "SELECT key, value FROM meta"
    ```

12. iPhone 主畫面 PWA 重新打開：因為 epoch 換了，App 會重置本機資料並重新同步，之後應該看得到舊 Sheet 的紀錄、體重、目標、收藏。

### 1.5 ⛔ Brian-only：每天匯出要成功（觀察 + 還原演練）

Worker 每天台北 04:00 自動匯出到 R2（cron `0 20 * * *`，04:05–04:55 每 5 分鐘續跑，見 `workers/api/src/cron/export.ts`）。匯出日 `DAY` 是**執行當天的台北日期**（例如 10/17 04:00 跑的是 `exports/2026-10-17/`）。R2 裡的結構：

```text
exports/<DAY>/_ok.json              最後才寫；有它才代表這一天匯完了
exports/<DAY>/<table>.part-N.json   stores / items / logs / weights / favorites / config
exports/<DAY>/logs.part-N.csv       只有 part 1 有 BOM 與表頭
```

**每天（至少雙軌期前幾天）04:55 之後檢查：**

1. 設定今天的匯出日與本機資料夾（放在 repo 外，裡面是飲食資料，不能進 git）：

   ```bash
   DAY="$(TZ=Asia/Taipei date +%F)" && DRILL_DIR="$HOME/food-log-drill/$DAY" && mkdir -p "$DRILL_DIR" && echo "$DAY $DRILL_DIR"
   ```

2. 下載 `_ok.json`（取不到物件＝那天沒有匯完；也可以在 Cloudflare 儀表板的 R2 bucket 裡看 `exports/`）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler r2 object get "food-log-exports/exports/$DAY/_ok.json" --remote --file "$DRILL_DIR/_ok.json"
   ```

3. 看重點欄位，`consistent` 必須是 `true`：

   ```bash
   grep -E '"(day|consistent|attempts|versionAtStart|versionAtEnd)"' "$DRILL_DIR/_ok.json"
   ```

   `consistent: false`（匯出期間資料一直在變，重來一次仍變動）的那天不能當備份用；`restore-drill` 會直接拒絕它。

4. 匯出進度表應該是空的（匯完會刪）；有列留著超過 04:55 台北，代表那天卡住了：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --command "SELECT day, table_idx, part, attempt FROM export_progress"
   ```

   排程的日誌（`{"type":"export",…}`）可以在 04:00–04:55 之間用 `wrangler tail` 看：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler tail --format pretty --search export
   ```

**還原演練（切換前至少做一次，切換後每週做一次）**：需要上面第 1、2 步的 `DAY`、`DRILL_DIR` 與 `_ok.json`。

1. 依 `_ok.json` 列出的 part 清單，下載這一天的所有檔案到 `DRILL_DIR`（只讀 R2）：

   ```bash
   node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const t of Object.values(m.tables)) for (const p of t.parts) console.log(p.key)' "$DRILL_DIR/_ok.json" | while read -r key; do npx -y pnpm@10 --filter @food-log/api exec wrangler r2 object get "food-log-exports/$key" --remote --file "$DRILL_DIR/$(basename "$key")" || break; done
   ```

   完成後確認資料夾裡有 `_ok.json`、各表 `*.part-N.json`、`logs.part-N.csv`：

   ```bash
   ls -l "$DRILL_DIR"
   ```

2. 跑演練（不碰 R2、不碰 D1，只讀本機資料夾，在記憶體裡還原）：

   ```bash
   node tools/ops/src/restore-drill.ts --dir "$DRILL_DIR"
   ```

   - 想留下還原後的 SQLite 檔檢查，就加 `--db "$DRILL_DIR/drill.sqlite"`（檔案已存在會拒絕，避免蓋掉東西）。
   - 它先套用 `workers/api/migrations/*.sql`（依序），再載入每張表的 part 檔，然後輸出：每張表的「manifest 列數／part 內列數／未刪除／已刪除」、logs 每日 kcal／protein／fat／carb 加總、每日體重筆數。加總會在 part 檔、`logs.csv`、還原後的資料庫三方互相比對。
   - 結束碼：`0` 全部相符；`1` 有不符（列數、加總、part 檔遺失或位元組數不對、schema 拒收某列）；`2` 拒絕執行（沒有 `_ok.json`、`consistent` 不是 `true`、`--db` 檔已存在）。最後一行印出耗時。
   - 演練還會檢查每一列的 `version` 是否為整數且不大於 `_ok.json` 的 `versionAtEnd`。**不檢查版本號是否唯一**：一個 mutation 寫的每一列都蓋同一個版本號（可能跨好幾張表，`(user_id, version)` 索引也不是唯一索引，見 `d1-store.ts`），pull 是依 (version, 表順序, 主鍵) 分頁，所以重複是正常的。
   - 加 `--emit-sql <檔案>`（演練 OK 才會寫，且不覆蓋既有檔案）會另外產生還原到 D1 的 SQL，用在第五節的災難還原。
   - 需要 Node 22.18 以上（`node:sqlite` 不用旗標，且 `node` 能直接執行 `.ts`；本機以 Node 25 驗證過）。第一次執行可能印出 `ExperimentalWarning: SQLite is an experimental feature`，不影響結果。若之後某個 migration 在 `node:sqlite` 失敗，錯誤訊息會指出是哪一個檔案；在 `tools/ops/src/drill-lib.ts` 的 `applyMigrations` 處理，並把解法補在這裡。

3. 把演練的耗時、版本號（`version a..b`）記在下面的「演練紀錄」：

| 日期 | 匯出日 `DAY` | 結果（OK／MISMATCH／refused） | 耗時 | 備註 |
|---|---|---|---|---|
| | | | | |

---

## 二、切換當天（⛔ 每一步都由 Brian 執行）

前置條件（沒全部打勾就不要開始）：

- [ ] 雙軌期的 `verify` 至少連續幾天全對，`anomalies.json` 都看過
- [ ] 至少一次還原演練 OK，每日匯出連續成功
- [ ] 新網址的登入、passkey、離線記錄、同步都在 iPhone 主畫面 PWA 試過
- [ ] 回滾演練做過一次並計時（第四節），知道 30 分鐘怎麼分配
- [ ] `v1-final` 要打 tag 的 `main` 已含 v1 唯讀開關（`READ_ONLY`，且已部署到 GAS，預設關閉）
- [ ] 導向版本（第 6 步）已在 `main` 衍生的暫時分支上備妥並審過
- [ ] Kyujin 的新設定（新網址、新 key 的存放位置）已準備好
- [ ] 記下正式環境現在跑的 commit（回滾步驟 A 要在同一個 commit 上部署）：每次部署後跑 `git rev-parse HEAD` 記在切換日筆記

### 步驟 1　⛔ GAS 設為唯讀

Apps Script 編輯器 → 專案設定 → 指令碼屬性，新增或修改 `READ_ONLY` = `1`。之後所有寫入（`append`、`update`、`softDelete`、`restore`、`upsertItem`、`upsertStore`、`upsertWeight`、`setConfig`）都回 `read_only`，`read`／`history`／`summary`／`trends` 仍可讀。舊 App 把 `read_only` 當永久錯誤，顯示「已搬到新網址」。

驗證：用舊 App 記一筆，應該被擋下並顯示搬家提示；Sheet 沒有新列。

### 步驟 2　⛔ 確認舊 App 的待送佇列與失敗清單都是空的

在每一台還裝著舊 App 的裝置（iPhone、其他瀏覽器）打開舊 App，看「待送佇列」與「失敗清單」。**兩個都必須是空的**；有東西就先讓它送完（此時 GAS 已唯讀，送不出去就會變失敗清單）。這時要處理：

- 失敗清單裡的項目：手動在新 App 補記，或確認不需要，**不要直接略過**，因為切換後舊 App 的待送資料就永遠送不出去。
- 全部清空後再進入下一步。

### 步驟 3　⛔ 最後一次匯入，記下 `V_cut`

此時 GAS 已唯讀，抓到的就是最終資料。在新開的終端機依序執行：

1. 第零節的 0.1、0.2、0.3（`cd`、`OWNER_EMAIL`、`OWNER_USER_ID`）。
2. 第 1.4 節的第 2–11 步，全部照做（`GAS_SECRET` 用舊共享密鑰，此時還沒輪替，步驟 4 才換；`emit-sql` 一定有 `--reset`）。
   - `--reset` 會改 epoch，已登入的裝置會被要求重置本機資料再 pull；匯入前先確認第 2 步已完成。
   - 中途失敗就**從第一個檔重新依序全部跑**。
   - `verify` 有任何差異（結束碼 1）就**停下**，不要繼續；差異排除前保持 GAS 唯讀（唯讀期間舊資料不會再變，可以安心重來整個步驟）。
3. **記下 `V_cut`**：全部 SQL 套用完成後，D1 `meta` 的 `version`（`verify` 的輸出也會列出 meta 版本，兩邊要一致）。回滾時 `reverse-export --since` 靠它找出「切換之後 v2 才有的寫入」：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --command "SELECT key, value FROM meta WHERE key IN ('version', 'epoch')"
   ```

   把數字寫在這裡（只寫數字，可以 commit 也可以不 commit）：`V_cut = ______`　`epoch = ______`

### 步驟 4　⛔ 發 Kyujin key，切換 Kyujin 設定，輪替舊的共享密鑰

1. 發新 key：寫到 `~/.config/studio/bots/kyujin.env`（權限 600），畫面上只顯示 key id，不顯示 key；同時把 key 的雜湊寫進 D1：

   ```bash
   sh -c "$(node workers/api/scripts/bot-key.ts --email "$OWNER_EMAIL" --origin https://food-log.brian-konr.workers.dev --remote | tee /dev/stderr | grep -v '^#')"
   ```

   `kyujin.env` 已存在時腳本會拒絕（不會覆蓋）；輪替見第 4 點。
2. 切換 Kyujin 的設定：Base URL 改成 `https://food-log.brian-konr.workers.dev/bot/v1`，key 從 `kyujin.env` 讀（`FOODLOG_API_BASE`、`FOODLOG_API_KEY`），請求格式與欄位名照 [`docs/kyujin-api-v2.md`](../kyujin-api-v2.md)。用一個讀取請求（`read`）確認通了。
3. **輪替舊的共享密鑰**：把 GAS Script Property `SHARED_SECRET` 換成新的隨機值（舊的作廢）。這樣即使舊設定還留在某處，也無法再打舊 `/exec`。**新值要存進密碼管理員**：回滾時 `reverse-export` 要用它當 `GAS_SECRET`（它讀的是 GAS 目前的值），舊 App 與舊 Kyujin 設定回滾後也要用它（或換回舊值，見第四節 B、F）。
4. 之後若要輪替 Kyujin 的 key：發第二把到另一個檔案、切過去，再撤銷舊的（撤銷後下一個請求就是 401）。發第二把：

   ```bash
   sh -c "$(node workers/api/scripts/bot-key.ts --email "$OWNER_EMAIL" --origin https://food-log.brian-konr.workers.dev --key-file "$HOME/.config/studio/bots/kyujin-new.env" --remote | tee /dev/stderr | grep -v '^#')"
   ```

   列出 key id：

   ```bash
   sh -c "$(node workers/api/scripts/bot-key.ts --list --remote | grep -v '^#')"
   ```

   撤銷舊的：把 `<KEY_ID>` 換成上一個指令列出的舊 key 的 `id`：

   ```bash
   sh -c "$(node workers/api/scripts/bot-key.ts --revoke <KEY_ID> --remote | tee /dev/stderr | grep -v '^#')"
   ```

### 步驟 5　⛔ 打開新網址、登入、確認今天的資料

1. 從 iPhone 主畫面的 v2 圖示開啟（雙軌期已加過、已註冊 passkey），用 passkey 登入（備援：1.3 第 3 步的登入碼）。
2. 確認：今天的紀錄、體重、目標、收藏都在；記一筆、改一筆、離線記一筆再恢復網路，都同步成功。
3. D1 版本號已在動：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --command "SELECT key, value FROM meta WHERE key = 'version'"
   ```

### 步驟 6　⛔ 先打 tag `v1-final`，再部署 GitHub Pages 的導向版本

**順序不能反**：tag 要指向「還是 v1、已含唯讀開關」的 `main`，之後回滾要靠它。

1. 打 tag 並推送（在 `main` 還沒合併 `v2` 之前）：

   ```bash
   git fetch origin && git tag -a v1-final origin/main -m "v1 final: last commit before the v2 cutover" && git push origin v1-final
   ```

2. 導向版本（`vite-plugin-pwa` 的 `selfDestroying: true`，加上一個導向 `https://food-log.brian-konr.workers.dev/` 的 `index.html`，讓舊主畫面上的 PWA 自己移除 Service Worker 並跳轉）。v1 的部署**只能從 `main` 的 `app/` 做**。建暫時的 worktree：

   ```bash
   git worktree add ../food-log-redirect -b redirect/v1-gh-pages v1-final
   ```

   在 `../food-log-redirect/app` 改好導向版本（selfDestroying、導向用的 index.html），本機 build 確認，再部署：

   ```bash
   cd ../food-log-redirect/app && npm ci && ./scripts/deploy-gh-pages.sh
   ```

   - 這個暫時分支**不要合併回任何分支**，部署完就刪（從 v2 checkout 根目錄）：

     ```bash
     git worktree remove ../food-log-redirect && git branch -D redirect/v1-gh-pages
     ```

     回滾時從 tag `v1-final` 重新部署，會用正常版本蓋掉它（第四節）。
   - 導向版本的內容目前不在 repo 裡；要在切換日前先寫好並測過（備妥後把差異記在 `docs/` 的某處，方便回滾時對照）。
3. 驗證：開舊的 GitHub Pages 網址，舊 App 應跳到新網址；已安裝的舊主畫面圖示開啟後也會跳轉並移除舊 Service Worker。

### 步驟 7　⛔ 改 Kyujin 提醒裡的 `#weight` 連結

把 Kyujin 的提醒訊息裡原本指向舊 GitHub Pages 的 `#weight` 連結改成新網址：`https://food-log.brian-konr.workers.dev/#weight`。改完先讓它發一則測試提醒，點連結確認直接進記體重畫面（新 App 的 hash 路由是否仍是 `#weight`，以 `apps/food-log` 為準）。

### 步驟 8　⛔ `v2` 合併回 `main`

`main` 從此就是 v2。`v2` 分支是長期分支，合併前依 [`AGENTS.md`](../../AGENTS.md) 的規則先把 `main` 的新改動合進 `v2`，並通過檢查（每個區塊在 v2 checkout 根目錄執行）：

```bash
git checkout v2 && git merge main
```

依 `AGENTS.md` 的對照表處理 `app/**` 衝突後：

```bash
test ! -e app && echo "OK: no app/"
```

```bash
npx -y pnpm@10 install --frozen-lockfile && npx -y pnpm@10 -r typecheck && npx -y pnpm@10 -r test && npx -y pnpm@10 --filter @food-log/app build
```

合併前確認 `v1-final` tag 已推送且指向正確的 commit：

```bash
git show --no-patch v1-final
```

通過後把 `v2` 合進 `main`（走 PR 或 fast-forward，依 Brian 當天決定）。合併後，v1 的部署腳本（`app/scripts/deploy-*.sh`）只存在於 `v1-final` tag 以前的歷史，回滾時從 tag 取用。

---

## 三、觀察兩週

每天花 2 分鐘檢查（做完在日期後打勾）：

- [ ] **`_ok.json` 每天都有**，且 `consistent` 是 `true`（第 1.5 節「每天檢查」的第 1–3 步）
- [ ] **`mutation_outcomes` 的 `ok=0` 列是空的**（沒有被擋下的業務錯誤）；有列就逐筆查原因（裝置版本太舊、Kyujin 權限、重複店名等），不能放著：

  ```bash
  npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --command "SELECT client_id, mutation_id, name, error, message, at FROM mutation_outcomes WHERE ok = 0 ORDER BY at DESC LIMIT 20"
  ```

- [ ] **沒有 5xx**：儀表板的 Workers 指標，或即時看錯誤（Ctrl+C 結束）：

  ```bash
  npx -y pnpm@10 --filter @food-log/api exec wrangler tail --format pretty --status error
  ```

  以及每日一次健康檢查，`authPrewarm` 是 `"ok"`：

  ```bash
  curl -s https://food-log.brian-konr.workers.dev/api/health
  ```

- [ ] Kyujin 的讀取與 `mutate` 正常（`created_by=kyujin` 的列有出現）
- [ ] CPU 時間沒有逼近免費方案的 10 ms 上限（`wrangler tail --format pretty`；常超過就評估升級 $5 方案，計畫第 9 節）
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
| A | 第 5 項：v2 停止收新資料（擋 `/sync` + 撤銷 Kyujin v2 key） | `deploy:with-app --var …`、`bot-key.ts --revoke` | 4 | | | |
| B | 第 1 項：GAS `READ_ONLY=0` | 指令碼屬性 | 2 | | | |
| C | 第 2 項：`reverse-export --dry-run`，確認 | 步驟 C | 5 | | | |
| D | 第 2 項：`reverse-export` 正式執行 | 步驟 D | 5 | | | |
| E | 第 3 項：從 `v1-final` 重新部署 GitHub Pages | 步驟 E | 8 | | | |
| F | 第 4 項：Kyujin 換回舊設定 | 步驟 F | 4 | | | |
| G | 驗證：舊 App 記一筆、Sheet 有列、Kyujin 讀得到 | | 2 | | | |
| | **合計** | | **30** | | | |

順序說明：計畫第 6 節的順序是 1→2→3→4→5。上表把第 5 項（A）提前，是因為 `reverse-export` 要讀的是 v2 的最終資料：先讓所有 push 回 409、並撤銷 Kyujin 的 v2 key（`MIN_CLIENT_VERSION` 擋不到 Kyujin），才不會在匯出之後又有新寫入而遺漏。如果當下不想先擋 v2（例如只是演練），照計畫原順序也可以，但 5 要在 2 之前至少「確認沒有新寫入」。實際順序以填表為準。

開始前，在新終端機做第零節的 0.1、0.2、0.3。

### 步驟

**A（第 5 項）v2 停止收新資料：兩件事都要做**

1. **擋住裝置的 push**（所有 `/sync` push 都回 409 `client_too_old`）。`deploy:with-app` 是**從目前這份工作目錄的程式碼**建置並上傳，所以必須在「正式環境現在跑的那個 commit」上執行。先看目前的 commit，對照切換日筆記：

   ```bash
   git log -1 --format='%H %s'
   ```

   不一致就先切到正式環境的那個 commit（把 `<PROD_SHA>` 換成筆記裡的 SHA；`wrangler deployments list` 也看得到每次部署的 message）：

   ```bash
   git checkout <PROD_SHA>
   ```

   然後部署（`--var` 只覆蓋這個變數；其他 vars 仍來自 `wrangler.jsonc`，secrets 不受影響，前端照樣帶上）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api run deploy:with-app --var MIN_CLIENT_VERSION:9999 --message "rollback: block push"
   ```

   回滾結束、要重新開放 v2 時，用正常的部署回到 `"1"`（`wrangler.jsonc` 裡的值沒有被改）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api run deploy:with-app
   ```

2. **撤銷 Kyujin 的 v2 key**：`MIN_CLIENT_VERSION` 只擋 `/sync`（`workers/api/src/routes/sync.ts`），**不擋 `/bot/v1/mutate`**，所以 Kyujin 仍可以寫進 v2，而這些寫入會發生在 `reverse-export` 之後，永遠不會回到 Sheet。先列出 key：

   ```bash
   sh -c "$(node workers/api/scripts/bot-key.ts --list --remote | grep -v '^#')"
   ```

   列表裡每一把 key 都撤銷（把 `<KEY_ID>` 換成列表的 `id`，每把跑一次）：

   ```bash
   sh -c "$(node workers/api/scripts/bot-key.ts --revoke <KEY_ID> --remote | tee /dev/stderr | grep -v '^#')"
   ```

   撤銷沒有快取，下一個請求就是 401（`docs/kyujin-api-v2.md`：Kyujin 收到 401 不重試，會通知 Brian）。**步驟 F 仍然成立**：F 是把 Kyujin 的設定改回舊 GAS（`/exec` 網址 + 共享密鑰），那是另一條路；撤銷 v2 key 只是在 F 完成前擋住它對 v2 的寫入，並保證 `reverse-export` 看到的是最終資料。之後若重新切到 v2，要再發新 key（切換步驟 4）。

**B（第 1 項）GAS `READ_ONLY=0`**：Apps Script 編輯器 → 專案設定 → 指令碼屬性，把 `READ_ONLY` 改成 `0`（或刪除）。**先不要動 `SHARED_SECRET`**：`reverse-export` 要用它當 `GAS_SECRET`（第二節步驟 4 輪替後的新值，在密碼管理員裡；也可以從指令碼屬性複製）。舊 App 與舊 Kyujin 設定要用哪個值，在步驟 F 處理。

**C、D（第 2 項）把切換之後 v2 的寫入反向寫回 Sheet。** 先把 v2 的最終狀態傾印下來（A 已擋住所有寫入，所以這份就是最終資料），再 dry-run，確認後正式執行。

1. 傾印 D1（唯讀）：

   ```bash
   mkdir -p tools/migrate/out && npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --json --command 'SELECT '\''meta'\'' AS _t, key, value FROM meta; SELECT '\''stores'\'' AS _t, * FROM stores; SELECT '\''items'\'' AS _t, * FROM items; SELECT '\''logs'\'' AS _t, * FROM logs; SELECT '\''weights'\'' AS _t, * FROM weights; SELECT '\''favorites'\'' AS _t, * FROM favorites; SELECT '\''config'\'' AS _t, * FROM config' > tools/migrate/out/d1-dump.json
   ```

2. 舊 `/exec` 網址（切換後 `main` 已是 v2，所以從 tag `v1-final` 取）：

   ```bash
   git fetch origin --tags && export GAS_URL="$(git show v1-final:app/deploy/gas-url)" && echo "$GAS_URL"
   ```

3. GAS 目前的 `SHARED_SECRET`（不會顯示）：

   ```bash
   printf 'GAS_SECRET: '; read -rs GAS_SECRET; echo; export GAS_SECRET
   ```

4. 設定 `V_CUT`（把 `<V_CUT>` 換成切換步驟 3 記下的數字）：

   ```bash
   V_CUT=<V_CUT>
   ```

5. **C：dry-run**（`--fetch-base` 用唯讀的 `read`／`history` 抓 Sheet 現況，計畫只包含真的有差別的步驟）：

   ```bash
   npx -y pnpm@10 --filter @food-log/migrate run reverse-export --dump "$PWD/tools/migrate/out/d1-dump.json" --since "$V_CUT" --user-id "$OWNER_USER_ID" --fetch-base --dry-run --plan-out "$PWD/tools/migrate/out/rollback-plan.json"
   ```

6. **D：正式寫入**（確認計畫看得懂每一步、數量合理之後）：

   ```bash
   npx -y pnpm@10 --filter @food-log/migrate run reverse-export --dump "$PWD/tools/migrate/out/d1-dump.json" --since "$V_CUT" --user-id "$OWNER_USER_ID" --fetch-base
   ```

- 轉成的 GAS 動作：`upsertStore`、`upsertItem`、`setConfig`、`append`／`update`、`upsertWeight`、`softDelete`。
- **重複執行 D（同一個指令），直到它回報 0 steps**：每次只送 Sheet 上還有差別的步驟，所以失敗後重跑、或跑兩次都是安全的；0 steps 就等於「Sheet 已經和 v2 一致」，這是這一步的驗證。有步驟失敗時結束碼是 1，輸出會列出失敗的步驟。
- 舊 Sheet 上沒有 id 的體重列無法用 id 定位刪除（`reverse-export` 的已知限制，輸出會標示）。

**E（第 3 項）從 tag `v1-final` 重新部署 GitHub Pages**，取代「會自我移除的 Service Worker」導向版本。建 worktree：

```bash
git worktree add ../food-log-rollback v1-final
```

部署：

```bash
cd ../food-log-rollback/app && npm ci && ./scripts/deploy-gh-pages.sh
```

若 GAS 的程式本身也要回到 `v1-final` 的版本（一般情況 GAS 沒改過，不需要）：

```bash
cd ../food-log-rollback/app && npm run deploy:gas
```

部署完用舊主畫面圖示開啟，確認 Service Worker 已被新的取代、App 載入舊版，並能連到 GAS。已被導向版本清掉 Service Worker 的裝置重新開舊的 GitHub Pages 網址即可。

**F（第 4 項）Kyujin 換回舊設定**：`reverse-export` 跑完（D 回報 0 steps）之後，才處理共享密鑰：舊 App 與舊 Kyujin 設定原本是用輪替前的舊值，二選一，**不要兩邊值不一致**：（1）把 GAS 的 `SHARED_SECRET` 改回輪替前的舊值（若還留著），或（2）把 GAS 目前的 `SHARED_SECRET` 貼進舊 App 與 Kyujin 的設定。然後把 Kyujin 的設定改回舊 `/exec` 網址，請求格式回到 [`docs/kyujin-api.md`](../kyujin-api.md)。提醒裡的 `#weight` 連結也改回舊 GitHub Pages 網址加 `#weight`。

**G 驗證**：舊 App 記一筆、重新整理仍在；Sheet 有那一列；Kyujin 的讀取與一個 `append` 都正常。

回滾完成後：把計時表、遇到的問題與 `V_cut` 寫成事後檢討，再決定 v2 要修什麼才重新切換。

---

## 五、災難還原（D1 遺失或損毀）⛔ Brian

這一節是「v2 自己的資料壞了或不見了」，從 R2 的每日匯出把資料放回 D1。和第四節不同：第四節是退回 v1（舊 Sheet），這一節是留在 v2。**能還原到的最新狀態是「最後一份 `consistent: true` 的匯出」，那之後的寫入會遺失**（最壞約 24 小時）。裝置本機若有較新的資料，見第 8 步。

匯出檔不含登入資料（`user`、`session`、`account`、`passkey`、`apikey`、`verification`、`login_codes` 都不匯出，見 `cron/export.ts`），產生的還原 SQL 也**永遠不會動這些表和 `export_progress`**；它清掉並重建的是：六張業務表（`stores`、`items`、`logs`、`weights`、`favorites`、`config`）、`sync_clients`、`mutation_outcomes`，並把 `meta.version` 設成「列版本號最大值與 `versionAtEnd` 較大者」、`meta.epoch` 設成**新的隨機值**（所有裝置下次 pull 都會得到 `reset:true`，從伺服器重建本機資料）。

開始前，在新終端機做第零節的 0.1、0.2。

1. **擋住寫入**（還原期間不能有人寫）：照第四節步驟 A（`deploy:with-app --var MIN_CLIENT_VERSION:9999`，在正式環境那個 commit 上執行），並撤銷 Kyujin 的 key。
2. **找最近一份可用的匯出並下載**：從最新的日期往回找，第一份 `_ok.json` 存在且 `"consistent": true` 的就是了。設定要用的日期（把 `<DAY>` 換成 `YYYY-MM-DD`）：

   ```bash
   DAY=<DAY> && DRILL_DIR="$HOME/food-log-drill/$DAY" && mkdir -p "$DRILL_DIR" && echo "$DAY $DRILL_DIR"
   ```

   然後照第 1.5 節「每天檢查」第 2、3 步下載並確認 `_ok.json`，再照「還原演練」第 1 步下載所有 part（`restore-drill` 會拒絕 `consistent: false`）。
3. **D1 的狀況決定要不要 `--user-id`**：
   - **(a) D1 還在、只有業務資料壞了**：登入資料沒事，owner 的 `user.id` 沒變，**不用 `--user-id`**。
   - **(b) D1 整個重建**：登入資料是空的，要重新建 owner，而新 owner 的 `user.id` 是新的隨機值，和匯出檔裡的 `user_id` 不同。依序：
     1. 建新 D1：

        ```bash
        npx -y pnpm@10 --filter @food-log/api exec wrangler d1 create food-log
        ```

        把新的 `database_id` 填進 `workers/api/wrangler.jsonc` 並 commit。
     2. 部署並套用 migrations（此時仍要擋寫入，所以帶 `--var`）：

        ```bash
        npx -y pnpm@10 --filter @food-log/api run deploy:with-app --var MIN_CLIENT_VERSION:9999 --message "disaster recovery: new D1"
        ```

        secrets 若是新 Worker 要照 1.2 第 3、4 步重新設定。
     3. 建 owner：

        ```bash
        sh -c "$(node workers/api/scripts/bootstrap-owner.ts --email "$OWNER_EMAIL" --name Brian --remote | tee /dev/stderr | grep -v '^#')"
        ```

     4. 照 0.3 取得新的 `OWNER_USER_ID`。匯出檔只有單一使用者，所以下一步帶 `--user-id "$OWNER_USER_ID"`，所有列的 `user_id` 會改成新 id。
4. **產生還原 SQL**（只讀本機資料夾，不碰 R2、D1；演練不是 OK 就不會產生檔案，已存在的檔案不會被覆蓋）。輸出會列出每張表的列數、每日加總與耗時，最後印出 `SQL written: …`（含新的 epoch 與 version）。`restore.sql` 的第一組語句會確認目標資料庫裡真的有要寫入的 `user.id`：沒有就在刪除任何東西之前整批中止（所以 (b) 一定要先建 owner）。

   (a) D1 還在：

   ```bash
   node tools/ops/src/restore-drill.ts --dir "$DRILL_DIR" --emit-sql "$DRILL_DIR/restore.sql"
   ```

   (b) D1 重建：

   ```bash
   node tools/ops/src/restore-drill.ts --dir "$DRILL_DIR" --emit-sql "$DRILL_DIR/restore.sql" --user-id "$OWNER_USER_ID"
   ```

   可先在本機 D1 預演（本機要先有同 id 的 `user` 列，否則守門會擋下；這是預期的）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 migrations apply food-log --local && npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --local --file "$DRILL_DIR/restore.sql"
   ```

5. **⛔ 套用到正式 D1**。檔案以刪除開頭、沒有 BEGIN／COMMIT（D1 不接受），所以**中途失敗就原檔再套一次**。每條語句都不超過 D1 的語句大小上限（每個 INSERT 最多 100 列且約 50 KB 以內）：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --yes --file "$DRILL_DIR/restore.sql"
   ```

6. **驗證**：`meta.version` 應等於演練輸出的 version，`meta.epoch` 應等於 `SQL written` 那行的新 epoch：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --command "SELECT key, value FROM meta"
   ```

   各表列數（含已刪除）應等於演練輸出的「expected」欄：

   ```bash
   npx -y pnpm@10 --filter @food-log/api exec wrangler d1 execute food-log --remote --command "SELECT (SELECT COUNT(*) FROM stores) AS stores, (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM logs) AS logs, (SELECT COUNT(*) FROM weights) AS weights, (SELECT COUNT(*) FROM favorites) AS favorites, (SELECT COUNT(*) FROM config) AS config"
   ```

7. **重新開放**：正常部署回 `MIN_CLIENT_VERSION` `"1"`：

   ```bash
   npx -y pnpm@10 --filter @food-log/api run deploy:with-app
   ```

   用新發的 key 重新設定 Kyujin（切換步驟 4）。(b) 的情況 passkey 也不見了：照 1.3 第 3、4 步用登入碼登入並重新新增 passkey。用手機開 App，確認它重置後今天（匯出日之前）的資料都在。
8. **裝置本機比匯出新的資料**：匯出日之後才記的資料如果還在某台裝置的本機（尚未同步或已同步但還原後遺失），重置時是否保留待送變更，以 sync client 的實作為準；還原前先到各裝置確認有沒有待送／失敗清單，必要時手動補記。Sheet（舊 v1）只到切換日，不是這份資料的來源。

---

## 六、30 天後清理（⛔ Brian）

**條件**：切換滿 30 天、觀察兩週的檢查全過、近期每週的還原演練都 OK、確認不再需要回滾（`v1-final` tag 會保留，永遠可以從它重建 v1）。

1. **封存 Sheet**：在 Google Drive 複製一份存檔（檔名加上日期），原 Sheet 改為唯讀／移到封存資料夾。Sheet 內有個人飲食資料，不要公開分享。
2. **關閉 GAS**：把 `/exec` 的 Web App 部署停用（Apps Script 編輯器 → 部署 → 管理部署作業 → 封存），並刪除 `SHARED_SECRET`。
3. **刪除 `legacy/`**（在現在的 `main` 上，走一般 PR）：

   ```bash
   git rm -r legacy
   ```

   同時移除只服務 `legacy/` 的東西：CI 裡的 legacy 對照測試、`packages/core/test/gas-parity.test.ts`（計畫第 5 節：「保留到切換」）、`AGENTS.md` 的 `legacy/` 說明與合併規則（`main` 上不再有 v1 熱修）。移除後跑：

   ```bash
   npx -y pnpm@10 -r typecheck && npx -y pnpm@10 -r test
   ```

4. **停掉導向版本**：GitHub Pages 導向頁可以再保留一陣子（舊書籤、舊主畫面圖示），確認沒有流量後再關閉 Pages。
5. 確認每日匯出與每週異地備份已成為例行；R2 `exports/` 的保留天數另行決定（第 8 節）。
6. spike（`food-log-spike`）若還沒刪：4b 已過、確認不需要後再刪（[`v2-spike.md`](../plans/v2-spike.md) 第 7 節）。
