# Handoff Result: eventbus-tests-20260521

## 执行时间
2026-05-21

## 状态
✅ 部署完成

## 变更

| 文件 | 变更 |
|------|------|
| `tests/event-bus.test.ts` | 新建，20 tests 覆盖 EventBus 全部方法 |

## 提交
`aa5e1f4` on `main` — working tree clean

## 验证
- Build ✅
- tsc --noEmit ✅
- 319 tests passed (16/17 files, api-smoke EPERM 已知)

## Qoder 执行记录
- 本地 pnpm test ✅（355/355, 17/17 files）
- 顺手修复：`task-ledger.test.ts` 第 73 行改为 async，加 5ms 延时，解决同毫秒 ULID 排序不稳定（第二次复现）
- rsync tests/ → 服务器 ✅（event-bus.test.ts + task-ledger.test.ts）
- 无 src/ 变更，无需重启 bubble ✅
