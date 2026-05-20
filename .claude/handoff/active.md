# Handoff: P1-b → P2-b → P3 → P4 批量

## Handoff-ID
p1b-p4-batch-20260520

## 分支
p1b-p4-batch

## 状态
已自检（build + test 通过，仅有 excel-translator 日期序列预存失败 + api-smoke sandbox 失败）

## 变更文件
- `src/kernel/prompts.ts` — **新增** — 提取 BASE_SYSTEM_PROMPT / CRITIQUE_PROMPT / COMPACTION_PROMPT + buildSystemPrompt()
- `src/kernel/brain.ts` — 重构：使用 prompts.ts，提取 postProcessResponse() 方法
- `src/bubble/model.ts` — 新增 BubbleRow 类型，消除 8 处 `as any` 强制转换
- `src/shared/tokens.ts` — 移除未使用的 HISTORY_BUDGET 常量
- `tests/tokens.test.ts` — 同步测试（移除 HISTORY_BUDGET 断言）
- `docs/adr/002-module-lifecycle.md` — **新增** — 模块生命周期 ADR

## 执行步骤
1. `git push origin p1b-p4-batch` — 推送分支
2. `rsync -avz --delete -e "ssh -p 22622" src/ root@101.34.243.245:/opt/bubble-agent-os/src/` — 同步后端源码
3. `rsync -avz --delete -e "ssh -p 22622" docs/ root@101.34.243.245:/opt/bubble-agent-os/docs/` — 同步文档
4. `ssh -p 22622 root@101.34.243.245 "cd /opt/bubble-agent-os && pnpm build"` — 远程构建
5. `ssh -p 22622 root@101.34.243.245 "pm2 restart bubble"` — 重启
6. `sleep 5 && ssh -p 22622 root@101.34.243.245 "curl -s http://localhost:3000/health"` — 健康检查

## 约束
- 只重启 bubble (id=0)，不动 bobi (id=1)
- 不同步 data/ 目录
- 不同步 dist/ 目录
- 不同步 web/ 目录（前端无变更）
- 无 package.json 变更，不需要 pnpm install
- 无数据库迁移（本次无 schema 变更）

## 验证方式
- 健康检查返回 200
- pm2 logs 无 Error/Fatal
- 发送消息正常回复（验证 prompts 模块正常工作）
- 数据库路径 `/root/.bubble-agent/data/bubble.db`（与 P1-a 相同）

## 回滚方案
`git checkout main && rsync src/ && rsync docs/ && pnpm build && pm2 restart bubble`
