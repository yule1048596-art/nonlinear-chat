#!/usr/bin/env bash
#
# 构建并把 dist/ 推到 gh-pages 分支。
#
# 为什么不用 GitHub Actions：创建 .github/workflows/ 下的文件需要令牌带
# workflow scope，而 gh CLI 默认不给。跑一次
#     gh auth refresh -h github.com -s workflow
# 授权之后就可以改用仓库里的 .github/workflows/deploy.yml 全自动部署，
# 那时这个脚本就不需要了。
#
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
REPO_URL=$(git -C "$ROOT" remote get-url origin)
NAME=$(git -C "$ROOT" config user.name || echo "deploy")
EMAIL=$(git -C "$ROOT" config user.email || echo "deploy@local")

npm --prefix "$ROOT" run build

cd "$ROOT/dist"
# dist 已被 .gitignore 忽略，这里建一个一次性仓库推上去，推完即删，
# 不会影响主仓库的 git 状态
rm -rf .git
git init -q
git checkout -qB gh-pages
git add -A
git -c user.name="$NAME" -c user.email="$EMAIL" \
  commit -qm "deploy $(date '+%Y-%m-%d %H:%M')"
git push -qf "$REPO_URL" gh-pages
rm -rf .git

echo "已部署 → gh-pages 分支"
