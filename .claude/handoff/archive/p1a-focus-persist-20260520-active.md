# Handoff: P1-a FocusTracker 持久化

## Handoff-ID
p1a-focus-persist-20260520

## 分支
p1a/focus-persist

## 状态
已自检（build + test 通过）

## 变更文件
- `src/memory/focus-tracker.ts` — 新增 persistToDatabase / loadFromDatabase 方法
- `src/memory/manager.ts` — 启动时加载持久化，每次 recordFocus 后自动保存
- `src/storage/database.ts` — 新增 focus_messages 表迁移

## 执行步骤
1. `git push origin p1a/focus-persist` — 推送分支
2. `rsync -avz --delete -e "ssh -p 22622" src/ root@101.34.243.245:/opt/bubble-agent-os/src/` — 同步后端源码
3. `ssh -p 22622 root@101.34.243.245 "cd /opt/bubble-agent-os && pnpm build"` — 远程构建
4. `ssh -p 22622 root@101.34.243.245 "pm2 restart bubble"` — 重启
5. `sleep 5 && ssh -p 22622 root@101.34.243.245 "curl -s http://localhost:3000/health"` — 健康检查
6. `ssh -p 22622 root@101.34.243.245 "bash /opt/bubble-agent-os/scripts/gen-module-state.sh"` — 状态锚点

## 约束
- 只重启 bubble (id=0)，不动 bobi (id=1)
- 不同步 data/ 目录
- 不同步 dist/ 目录
- 不同步 web/ 目录（前端无变更）
- 无 package.json 变更，不需要 pnpm install
- 远程 build 会自动创建 focus_messages 表（迁移在 runMigrations 中）

## 验证方式
- 健康检查返回 200
- pm2 logs 无 Error/Fatal
- 启动日志包含 "Migration: focus_messages table created for FocusTracker persistence"
- 发一条消息后，focus_messages 表有数据写入

## 回滚方案
`git checkout main && rsync src/ && pm2 restart bubble`
