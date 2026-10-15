# AGENTS.md（v2 分支）

這是長期分支 **`v2`**（food-log 後端 v2：Cloudflare Worker + D1 + 本機優先 PWA）。`main` 放 v1（Apps Script + GitHub Pages）。施工計畫：[`docs/plans/v2.md`](docs/plans/v2.md)；需求：[`docs/architecture/backend-v2-PRD.md`](docs/architecture/backend-v2-PRD.md)（衝突時以 PRD 為準）。

## 目錄

- `apps/food-log/`：前端 PWA（由 v1 的 `app/` 搬來）。細節見 [`apps/food-log/AGENTS.md`](apps/food-log/AGENTS.md)，其中的路徑要照下面的對照改。
- `legacy/`：v1 的 Apps Script（`legacy/gas/`）、GAS 測試（`legacy/test/`）、合併檔產生腳本（`legacy/scripts/build-gas.mjs`）。**沒有任何部署腳本**。切換滿 30 天後刪除。
- `packages/*`、`workers/*`、`tools/*`：v2 新增（見計畫第 2 節）。
- 舊路徑對照：`app/` → `apps/food-log/`；`app/gas/` → `legacy/gas/`；`app/test/gas-*` → `legacy/test/`；`app/scripts/build-gas.mjs` → `legacy/scripts/build-gas.mjs`。
- **v1 的部署（GitHub Pages、Apps Script）只能從 `main` 做**（`main` 的 `app/scripts/deploy-*.sh`、`app/deploy/`）。`v2` 分支刻意不放 `deploy-gh-pages.sh`、`deploy-gas.sh`、`deploy/gas-url`，以免從 `v2` 蓋掉正式的 v1。合併 `main` 時這些檔案一律忽略（見下方合併規則）。

## 指令

pnpm 沒有全域安裝，一律用 `npx -y pnpm@10 …`（版本鎖在根 `package.json` 的 `packageManager`）。

```bash
npx -y pnpm@10 install
npx -y pnpm@10 -r typecheck
npx -y pnpm@10 -r test
npx -y pnpm@10 --filter @food-log/app build
```

## 合併規則（`main` → `v2`）

每個階段結束、以及 `main` 有 v1 修正時，在 `v2` 執行 `git merge main`：

- `main` 上 `app/gas/**` 的改動 → 對應到 `legacy/gas/**`（改完要重新產生合併檔 `legacy/gas/FoodLog-AppsScript.gs`：`npx -y pnpm@10 --filter @food-log/legacy build:gas`）。
- `main` 上 `app/src/**` 的改動 → **手動移植**到 `apps/food-log`；被 v2 重寫的檔案以 v2 為準。
- 每次合併都在 merge commit message 列出移植清單（哪些 v1 改動移植到哪裡、哪些捨棄）。
- GAS 對照測試（`gas-defaults`、`gas-trends-parity`）放在 `legacy/test/`，由 legacy 單向引用前端（`@` → `apps/food-log/src`；黃金案例 `apps/food-log/test/fixtures/trends-cases.json`）。**`apps/food-log` 不得 import `legacy/` 的任何東西**；不要刪這些測試。
- v1 唯讀開關等 v1 改動做在 `main`，再合併進 `v2`。

## 紅線

- **絕對不要部署**（GitHub Pages、Apps Script、Cloudflare）。部署是 Brian 的操作，標 ⛔ 的步驟寫好指令後停下。
- **不放任何秘密**：token、API key、共享密鑰、`.dev.vars`、登入碼都不進 repo（repo 是公開的）。`/exec` 網址不是秘密。
- 沒有 Brian 同意，不要對真實 Google Sheet 或正式 D1 寫入。
- 其餘規則（冪等寫入、台北日界線、繁體中文介面等）沿用 `apps/food-log/AGENTS.md`，除非計畫另有說明。
