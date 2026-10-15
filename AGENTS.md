# AGENTS.md（v2 分支）

這是長期分支 **`v2`**（food-log 後端 v2：Cloudflare Worker + D1 + 本機優先 PWA）。`main` 放 v1（Apps Script + GitHub Pages）。施工計畫：[`docs/plans/v2.md`](docs/plans/v2.md)；需求：[`docs/architecture/backend-v2-PRD.md`](docs/architecture/backend-v2-PRD.md)（衝突時以 PRD 為準）。

## 目錄

- `apps/food-log/`：前端 PWA（由 v1 的 `app/` 搬來）。細節見 [`apps/food-log/AGENTS.md`](apps/food-log/AGENTS.md)，其中的路徑要照下面的對照改。
- `legacy/`：v1 的 Apps Script（`legacy/gas/`）、GAS 測試（`legacy/test/`）、合併檔產生腳本（`legacy/scripts/build-gas.mjs`）。**沒有任何部署腳本**。切換滿 30 天後刪除。
- `packages/*`、`workers/*`、`tools/*`：v2 新增（見計畫第 2 節）。
- 舊路徑對照：`app/` → `apps/food-log/`；`app/gas/` → `legacy/gas/`；`app/test/gas-*` → `legacy/test/`；`app/scripts/build-gas.mjs` → `legacy/scripts/build-gas.mjs`。
- **v1 的部署（GitHub Pages、Apps Script）只能從 `main` 做**（`main` 的 `app/scripts/deploy-*.sh`、`app/deploy/`）。`v2` 分支刻意不放 `deploy-gh-pages.sh`、`deploy-gas.sh`、`deploy/gas-url`，以免從 `v2` 蓋掉正式的 v1。合併 `main` 時這些檔案一律忽略（見下方合併規則）。

## 指令

pnpm 沒有全域安裝，本機一律用 `npx -y pnpm@10 …`（版本鎖在根 `package.json` 的 `packageManager`）。要寫成 `npx -y pnpm@10 -r test`，不要寫 `npx pnpm test`（沒釘版本，也沒有 `-r` 就只會在根目錄跑，根目錄沒有 test）；也不要裝全域 pnpm。

```bash
npx -y pnpm@10 install
npx -y pnpm@10 -r typecheck
npx -y pnpm@10 -r test
npx -y pnpm@10 -r build                       # 或只建前端：--filter @food-log/app build
```

根 `package.json` 的 scripts（`pnpm -r test` 等）寫的是裸 `pnpm`：CI 有 pnpm（`pnpm/action-setup`），照用；本機沒有 `pnpm` 在 PATH，所以本機不要跑 `npm test` / `npm run test` 這類會呼叫裸 `pnpm` 的根 scripts，直接用上面的 `npx -y pnpm@10 -r …`。

## 合併規則（`main` → `v2`）

每個階段結束、以及 `main` 有 v1 修正時，在 `v2` 執行 `git merge main`。`main` 的目錄是 `app/`，`v2` 沒有 `app/`，所以 git 會把 `app/**` 的新增、修改當成要在原路徑處理的衝突或新檔。**合併後逐項照下表處理**：

| `main` 上的路徑 | 在 `v2` 的處理 |
|---|---|
| `app/gas/**` | 搬到 `legacy/gas/**`；改完重新產生合併檔：`npx -y pnpm@10 --filter @food-log/legacy build:gas` |
| `app/test/gas-*.test.ts`、`app/test/gas-fakes.ts` | 搬到 `legacy/test/` |
| 其他 `app/test/**`（含 `fixtures/`） | 搬到 `apps/food-log/test/`（`defaults.test.ts`、`trends-parity.test.ts` 在 `v2` 已改名為 `legacy/test/gas-defaults.test.ts`、`gas-trends-parity.test.ts`，`main` 對它們的修改要套到這兩個檔） |
| `app/src/**` | **手動移植**到 `apps/food-log/src/**`；被 v2 重寫的檔案以 v2 為準 |
| `app/e2e/**` | 搬到 `apps/food-log/e2e/` |
| `app/package.json` 的依賴變動 | 套到 `apps/food-log/package.json`，再跑 `npx -y pnpm@10 install` 更新 `pnpm-lock.yaml`（不要手改 lock；`workbox-window` 維持釘在 `7.4.1`） |
| `app/package-lock.json` | 忽略（v2 用 `pnpm-lock.yaml`） |
| `app/scripts/deploy-*`、`app/deploy/**` | **一律忽略**：v1 部署只能從 `main` 做，`v2` 不放這些檔案 |
| `app/scripts/build-gas.mjs` | 搬到 `legacy/scripts/build-gas.mjs` |
| 其他 `app/scripts/**`、`app/{index.html,public,components.json,tsconfig*,vite.config.ts,README.md,AGENTS.md}` | 搬到 `apps/food-log/` 同名路徑（`AGENTS.md`、`README.md` 的 v2 路徑改寫要保留） |
| `docs/**` | 照 `main` 原樣合併 |

其他要求：

- 每次合併都在 merge commit message 列出移植清單（哪些 v1 改動移植到哪裡、哪些捨棄）。
- GAS 對照測試（`gas-defaults`、`gas-trends-parity`）放在 `legacy/test/`，由 legacy 單向引用前端（`@` → `apps/food-log/src`；黃金案例 `apps/food-log/test/fixtures/trends-cases.json`）。**`apps/food-log` 不得 import `legacy/` 的任何東西**；不要刪這些測試。
- v1 唯讀開關等 v1 改動做在 `main`，再合併進 `v2`。
- **合併後必做檢查（缺一不可，通過才能 commit merge）：**
  1. `test ! -e app`：`v2` 上不得出現 `app/` 目錄（出現就代表有 `app/**` 檔案沒搬走，逐一處理後刪掉 `app/`）。
  2. `npx -y pnpm@10 install --frozen-lockfile`、`npx -y pnpm@10 -r typecheck`、`npx -y pnpm@10 -r test` 全綠，`npx -y pnpm@10 --filter @food-log/app build` 成功。

## 紅線

- **絕對不要部署**（GitHub Pages、Apps Script、Cloudflare）。部署是 Brian 的操作，標 ⛔ 的步驟寫好指令後停下。
- **不放任何秘密**：token、API key、共享密鑰、`.dev.vars`、登入碼都不進 repo（repo 是公開的）。`/exec` 網址不是秘密。
- 沒有 Brian 同意，不要對真實 Google Sheet 或正式 D1 寫入。
- 其餘規則（冪等寫入、台北日界線、繁體中文介面等）沿用 `apps/food-log/AGENTS.md`，除非計畫另有說明。
