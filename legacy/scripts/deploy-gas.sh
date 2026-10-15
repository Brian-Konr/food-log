#!/usr/bin/env bash
# 把 legacy/gas 合併檔推到正式綁定的 clasp 專案，並把現有正式 /exec 部署更新到新版本。
# 正式專案在 repo 根目錄的 clasp/（.clasp.json 的 rootDir 是 src），不在 legacy/。
# 需要本機已 clasp login。不要 commit .clasprc.json。
# 用法：在 legacy/ 執行 npm run deploy:gas
# 這次實作不要執行。
set -euo pipefail

LEGACY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$LEGACY_DIR/.." && pwd)"
CLASP_DIR="$ROOT_DIR/clasp"
CLASP_BIN="${CLASP_BIN:-/home/box/.local/bin/clasp}"
SRC="$CLASP_DIR/src"
MERGED="$LEGACY_DIR/gas/FoodLog-AppsScript.gs"

if [ ! -f "$CLASP_DIR/.clasp.json" ]; then
  echo "[deploy:gas] 找不到 $CLASP_DIR/.clasp.json" >&2
  exit 1
fi
if [ ! -x "${CLASP_BIN}" ] && ! command -v "${CLASP_BIN}" >/dev/null 2>&1; then
  echo "[deploy:gas] 找不到 clasp：$CLASP_BIN" >&2
  exit 1
fi

echo "[deploy:gas] npm run build:gas"
(
  cd "$LEGACY_DIR"
  npm run build:gas
)
if [ ! -f "$MERGED" ]; then
  echo "[deploy:gas] 沒有產生 $MERGED" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d%H%M%S)"
BAK="$CLASP_DIR/src-bak-$STAMP"
echo "[deploy:gas] 備份 $SRC → $BAK"
cp -a "$SRC" "$BAK"

echo "[deploy:gas] 複製合併檔 → $SRC/Code.js（保留 appsscript.json）"
cp "$MERGED" "$SRC/Code.js"
if [ ! -f "$SRC/appsscript.json" ]; then
  echo "[deploy:gas] $SRC/appsscript.json 不見了，從備份還原" >&2
  cp "$BAK/appsscript.json" "$SRC/appsscript.json"
fi

# 任何 clasp 指令都必須先 cd "$CLASP_DIR"。
echo "[deploy:gas] clasp push"
(
  cd "$CLASP_DIR"
  "$CLASP_BIN" push
)

echo "[deploy:gas] update-deployment"
(
  cd "$CLASP_DIR"
  DEPLOY_ID="${FOODLOG_DEPLOY_ID:-AKfycbzkkNiqeHeFF7i0qgC8V8vTApGuvLgCgobEsDI_63c1ZUpftEf2tqYCjO57L64nlqwffQ}"
  "$CLASP_BIN" update-deployment "$DEPLOY_ID"
)
echo "[deploy:gas] 已更新正式部署（網址不變）"
