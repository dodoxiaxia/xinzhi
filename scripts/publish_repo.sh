#!/usr/bin/env bash
# 一次性:把代码推到私有仓库 main,再把数据推到 state 分支。
# 用法(Mac 终端,xinzhi 目录):
#   read -s -p "粘贴 GitHub 令牌: " GH_TOKEN; echo; export GH_TOKEN
#   bash scripts/publish_repo.sh dodoxiaxia/xinzhi
# 令牌只用于这次推送,不会写进 git 配置,也不用钥匙串里旧的登录。
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${1:?请传入 用户名/仓库名,例如 dodoxiaxia/xinzhi}"
: "${GH_TOKEN:?请先 export GH_TOKEN(带 repo 和 workflow 权限的令牌)}"
GH_TOKEN="$(printf '%s' "$GH_TOKEN" | tr -d '[:space:]')"
case "$GH_TOKEN" in ghp_*|github_pat_*|gho_*) ;; *) echo "令牌格式不对:应以 ghp_ 或 github_pat_ 开头,且不含空格。请重新执行第 1 步,只粘贴令牌本身。"; exit 1;; esac
export PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
rm -rf .git
git init -q -b main
git add -A
git -c user.name="xinzhi" -c user.email="xinzhi@users.noreply.github.com" commit -qm "xinzhi v13.2 code"
git remote add origin "https://github.com/${REPO}.git"
git -c credential.helper= push -u "$PUSH_URL" main
bash scripts/seed_state.sh
echo "完成:main(代码)与 state(数据)都已推送。"
