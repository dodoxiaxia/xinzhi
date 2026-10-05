#!/usr/bin/env bash
# 把本地代码改动推到 GitHub main(之后下一次自动任务会用新代码构建并发布)。
# 用法(Mac 终端,xinzhi 目录):
#   read -s "GH_TOKEN?粘贴 GitHub 令牌后回车: "; echo; export GH_TOKEN
#   bash scripts/push_code.sh "改动说明"
set -euo pipefail
cd "$(dirname "$0")/.."
: "${GH_TOKEN:?请先 export GH_TOKEN}"
GH_TOKEN="$(printf '%s' "$GH_TOKEN" | tr -d '[:space:]')"
REPO="${REPO:-dodoxiaxia/xinzhi}"
[ -d .git ] || { echo "没有 .git,请先运行 scripts/publish_repo.sh"; exit 1; }
git add -A
git -c user.name="xinzhi" -c user.email="xinzhi@users.noreply.github.com" commit -qm "${1:-update}" || echo "没有新改动可提交"
git -c credential.helper= push "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" main
echo "已推送到 main。"
