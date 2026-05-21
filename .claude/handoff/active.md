# Handoff: EventBus 单元测试

## Handoff-ID
eventbus-tests-20260521

## 分支
main (aa5e1f4, working tree clean)

## 状态
✅ Build 通过（tsup + DTS）
✅ TypeScript 类型检查通过（tsc --noEmit 0 errors）
✅ 测试通过（319 passed, 16/17 files, 1 api-smoke EPERM 是沙箱问题）

---

## 变更内容

### `tests/event-bus.test.ts` — 新建，20 tests

覆盖 EventBus 全部 7 个公开方法：

| describe | tests | 覆盖内容 |
|----------|-------|---------|
| on / emit | 4 | 基本订阅、EmitOptions 透传、多监听器、未订阅不触发 |
| unsubscribe | 2 | 取消后不收到、重复取消不报错 |
| 数组类型订阅 | 2 | 一次订阅多个类型、取消移除所有 |
| onPrefix 通配符 | 3 | `memory` 匹配、`biz` 不匹配、取消订阅 |
| onAll 全局监听 | 3 | 收所有类型、取消停止、类型+全局都收到 |
| 错误隔离 | 1 | 一个抛错不影响其他 |
| listenerCount | 2 | 类型/全局计数、取消后减少 |
| clear | 1 | 全部清除、计数归零 |
| emitFireAndForget | 2 | 异步调用不阻塞、错误被捕获 |

设计特点：
- 纯逻辑，0 DB 依赖
- 遵循 `event-gate.test.ts` 的 `vi.waitFor` 异步模式
- 使用 `collectEmitted` 辅助函数统一事件捕获

---

## 部署步骤

1. `rsync -avz --delete -e "ssh -p 22622" tests/ root@101.34.243.245:/opt/bubble-agent-os/tests/`
2. `ssh -p 22622 root@101.34.243.245 "cd /opt/bubble-agent-os && pnpm test"`（跳过 api-smoke）

无需重启 bubble（仅测试文件变更，无 src/ 修改）。

## 验证方式
```bash
pnpm build       # 通过
pnpm tsc --noEmit # 通过
pnpm test         # 319 passed, 16/17 files
```
