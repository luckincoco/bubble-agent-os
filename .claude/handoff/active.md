# Handoff: B-1 Phase 2 — EventGate 认知路由激活

## Handoff-ID
event-gate-phase2-20260521

## 分支
main (3e9aa7d, working tree clean)

## 状态
✅ Build 通过（tsup 263ms + DTS 8.9s）
✅ TypeScript 类型检查通过（tsc --noEmit 0 errors）
✅ 测试通过（299 passed, 15/16 files, 1 api-smoke EPERM 是沙箱问题）

---

## 变更内容

### 1. 事件类型扩展 — `src/event/event-types.ts`

**`conversation.turn.completed` payload 增加 `insightScore`**：
```
insightCount, hasInsight, insightScore: number (新增), responseLength, spaceId?
```

**新增 `knowledge.event.gated` 事件**（审计跟踪）：
```typescript
interface KnowledgeEventGated {
  type: 'knowledge.event.gated'
  payload: {
    sourceEvent: string    // eg. 'conversation.turn.completed'
    insightCount: number
    insightScore: number
    action: 'route' | 'discard' | 'defer'
    spaceId?: string
  }
}
```
已加入 `BubbleEventData` 联合类型。

### 2. Evaluator 计算 insightScore — `src/memory/conversation-insight-evaluator.ts`

按 sourceType 加权聚合：
- `synthesis` = 1.0（综合洞察，最高价值）
- `observation` = 0.7（观察发现）
- `question` = 0.5（问题/疑问）

在 emit `conversation.turn.completed` 时传入 insightScore。

### 3. EventGate 路由激活 — `src/cognition/event-gate.ts`

Phase 1 空壳（仅日志）→ Phase 2 激活：

| insightScore | 行为 |
|-------------|------|
| 0 | skip（不处理） |
| < 2.0 | defer（低价值，仅审计日志） |
| >= 2.0 | route（高价值，info 日志 + 路由标记） |

始终发射 `knowledge.event.gated` 审计事件。

### 4. 新增测试文件

| 文件 | 测试数 | 覆盖内容 |
|------|--------|---------|
| `tests/event-gate.test.ts` | 4 tests | 低分 defer、高分 route、count=0 跳过、边界值 2.0 恰过 |
| `tests/conversation-insight-evaluator.test.ts` | 3 tests | 短回复跳过、无 insight=0、3 候选正确计算 score |

---

## 部署步骤

1. `rsync -avz --delete -e "ssh -p 22622" src/ root@101.34.243.245:/opt/bubble-agent-os/src/`
2. `rsync -avz --delete -e "ssh -p 22622" tests/ root@101.34.243.245:/opt/bubble-agent-os/tests/`
3. `ssh -p 22622 root@101.34.243.245 "cd /opt/bubble-agent-os && pnpm build && pm2 restart bubble"`

## 约束
- 重启 bubble only (id=0)，not bobi (id=1) ✅
- 无需 pnpm install（无 package.json 变更）✅
- 无需数据库迁移（无 schema 变更）✅

## 验证方式
1. 健康检查：`curl -s http://localhost:3000/api/health` → `{"status":"ok","version":"1.1.1"}`
2. 服务器测试：`cd /opt/bubble-agent-os && pnpm test`（跳过 api-smoke）
