# Handoff: Phase D 集成测试 + A-4 合并 main

## Handoff-ID
phase-d-merge-20260521

## 分支
p1b-p4-batch (working tree clean)

## 状态
✅ Build 通过（tsup 225ms + DTS 8.3s）
✅ TypeScript 类型检查通过（tsc --noEmit 0 errors）
✅ 测试通过（292 passed, 13/14 files, 1 api-smoke EPERM 是沙箱问题）

---

## 第一部分：Phase D — 新增 3 个测试文件

### 新增文件

| 文件 | 测试数 | 覆盖内容 |
|------|--------|---------|
| `tests/boundary-checker.test.ts` | 18 tests | 白名单放行、deny 规则、confirm 规则、工具可逆性、白名单管理、未匹配放行 |
| `tests/task-ledger.test.ts` | 18 tests | 创建/查询、状态管理（active→paused→completed→expired）、Checkpoint、PendingAction、EpisodeWindow、PlanSteps 更新、恢复检测（detectResumption）、上下文注入（buildLedgerContext） |
| `tests/action-planner.test.ts` | 18 tests | shouldUsePlanMode（多步骤/动词计数/边界）、classifyFailure（retry/halt_report/halt_absolute）、generatePlan fixture stub 降级、startPlan、formatExecutorReport |

### 测试设计要点
- **boundary-checker**：纯逻辑，无 DB 依赖，快速执行
- **task-ledger**：有 DB 依赖，遵循 database.test.ts 的 mkdtempSync + initDatabase + 手动 seed 模式
- **action-planner**：纯函数（shouldUsePlanMode/classifyFailure）无 DB 依赖；含 DB 的测试（startPlan）用独立 seed；generatePlan 用 fixture-llm stub 模式（回退为单步计划）

---

## 第二部分：A-4 — 合并 p1b-p4-batch → main

### 合并准备
- 9 commits ahead of main
- 117 文件变更（+12,834 / -2,140）
- **无冲突**（git merge-tree 无 "changed in both" 输出）

### 合并步骤
1. `git checkout main && git pull origin main` — 确认 main 最新
2. `git merge p1b-p4-batch` — 合并（预期无冲突）
3. `pnpm build && pnpm test` — 验证
4. `git push origin main` — 推送 main

### 回滚方案
```bash
git push origin main --force-with-lease HEAD~1:main  # 回退 main
```

---

## 执行步骤
1. 合并 main（按上述合并步骤 1-3）
2. `rsync -avz --delete -e "ssh -p 22622" src/ root@101.34.243.245:/opt/bubble-agent-os/src/`
3. `rsync -avz --delete -e "ssh -p 22622" tests/ root@101.34.243.245:/opt/bubble-agent-os/tests/`
4. `ssh -p 22622 root@101.34.243.245 "cd /opt/bubble-agent-os && pnpm build && pm2 restart bubble"`

## 约束
- 重启 bubble only (id=0)，not bobi (id=1) ✅
- 无需 pnpm install（无 package.json 变更）✅
- 无需数据库迁移（无 schema 变更）✅
- rsync 排除 `.env` ✅

## 验证方式
1. 健康检查：`curl -s http://localhost:3000/api/health` → `{"status":"ok","version":"1.1.1"}`
2. 测试：服务器 `cd /opt/bubble-agent-os && pnpm test`（跳过 api-smoke）

## 需要 Qoder 确认
1. 合并 main 的顺序是否 OK？
2. 是否先合 main 再 rsync，还是先 rsync 测试文件再合 main？
