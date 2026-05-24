#!/bin/bash
set -e

DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_HOST="${DEPLOY_HOST:-101.34.243.245}"
SSH_PORT="${SSH_PORT:-22622}"
REMOTE_DIR="/opt/bubble-agent-os"
SSH_CMD="ssh -p $SSH_PORT $DEPLOY_USER@$DEPLOY_HOST"
RSYNC_OPTS="-avz --delete -e \"ssh -p $SSH_PORT\" --exclude='node_modules' --exclude='.env' --exclude='.git' --exclude='.claude'"

echo "=== Build ==="
cd "$(dirname "$0")/.."
pnpm build:all

echo "=== Sync dist/ ==="
eval rsync $RSYNC_OPTS ./dist/ $DEPLOY_USER@$DEPLOY_HOST:$REMOTE_DIR/dist/

echo "=== Sync scripts/ ==="
eval rsync $RSYNC_OPTS ./scripts/ $DEPLOY_USER@$DEPLOY_HOST:$REMOTE_DIR/scripts/

echo "=== Sync web/ ==="
eval rsync $RSYNC_OPTS --delete ./web/dist/ $DEPLOY_USER@$DEPLOY_HOST:$REMOTE_DIR/web/dist/

echo "=== Restart ==="
$SSH_CMD "pm2 restart bubble"

echo "=== Health check ==="
sleep 3
curl -s http://$DEPLOY_HOST:3000/api/health || echo "⚠️ Health check failed"
echo ""
echo "=== Done ==="
