#!/usr/bin/env bash
# 把 dist/ 發佈到 gh-pages 分支（GitHub Pages 來源：gh-pages / root）。
# 用法：./scripts/deploy-gh-pages.sh
#   有設 FOOD_LOG_GITHUB_TOKEN 就用它推（只透過 credential helper，不寫進 remote URL 或檔案）；
#   沒設就用這台電腦本來的 git 認證。
# 遠端頁面：https://brian-konr.github.io/food-log/
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${REPO:-Brian-Konr/food-log}"
if [ -z "${VITE_GAS_URL:-}" ] && [ -s deploy/gas-url ]; then VITE_GAS_URL="$(tr -d '[:space:]' < deploy/gas-url)"; fi
if [ -z "${VITE_GAS_URL:-}" ]; then
  VITE_GAS_URL="$(GH_TOKEN="${FOOD_LOG_GITHUB_TOKEN:-${GH_TOKEN:-}}" gh api "repos/$REPO/actions/variables/VITE_GAS_URL" --jq .value 2>/dev/null)" || VITE_GAS_URL=""
fi
if [ -n "$VITE_GAS_URL" ] && ! [[ "$VITE_GAS_URL" =~ ^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$ ]]; then
  echo "[deploy] VITE_GAS_URL 格式不對（應為 https://script.google.com/macros/s/…/exec），停止" >&2; exit 1
fi
export VITE_GAS_URL BASE="/food-log/"
echo "[deploy] BASE=$BASE  模式：$([ -n "$VITE_GAS_URL" ] && echo 連線 Apps Script || echo 本機試用)"
npm test
npm run build
npx vitest run test/security.test.ts
touch dist/.nojekyll
SHA="$(git rev-parse --short HEAD)"
TMP="$(mktemp -d)"
cp -r dist/. "$TMP"
cd "$TMP"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="$(git -C "$OLDPWD" config user.email)" commit -qm "deploy $SHA"
if [ -n "${FOOD_LOG_GITHUB_TOKEN:-}" ]; then
  git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$FOOD_LOG_GITHUB_TOKEN"; }; f' \
    push -f "https://github.com/$REPO.git" gh-pages
else
  git push -f "$(git -C "$OLDPWD" remote get-url origin)" gh-pages
fi
rm -rf "$TMP"
echo "[deploy] 已推到 gh-pages（$SHA）"
