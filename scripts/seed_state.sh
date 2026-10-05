#!/usr/bin/env bash
# 一次性:把本地 data/ 与 public/ 推到私有仓库的 state 分支,供每日工作流读取。
# 用法(在 xinzhi 目录):bash scripts/seed_state.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE="${PUSH_URL:-$(git remote get-url origin)}"
T=$(mktemp -d)
mkdir -p "$T/s/docs"
cp -r data public "$T/s/"
cp docs/public-manifest.json "$T/s/docs/" 2>/dev/null || true
cd "$T/s"
git init -q -b state
git add -A
git commit -qm "seed state $(date -u +%F)"
git push -f "$REMOTE" state
echo "已推送 state 分支。"
