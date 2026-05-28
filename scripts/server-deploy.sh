#!/bin/bash
set -e

# Bubble 服务端自部署脚本
# 放在服务器上，ssh 上去跑：bash /opt/bubble-agent-os/scripts/server-deploy.sh
# 或者设别名：alias bubble-deploy='bash /opt/bubble-agent-os/scripts/server-deploy.sh'

DIR="${1:-/opt/bubble-agent-os}"
cd "$DIR"

echo "  ➜ git fetch + reset --hard origin/main..."
git fetch origin
git reset --hard origin/main

echo "  ➜ pnpm install..."
pnpm install

echo "  ➜ pnpm build..."
pnpm build

echo "  ➜ pm2 restart bubble..."
pm2 restart bubble

echo "  ✓ 部署完成"
