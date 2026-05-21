# Bubble Agent OS — Claude Code 项目指南

## 项目定位

通用 AI 记忆学习系统。当前验证场景：钢贸（钢材进销存）。
钢贸是实验田，不是天花板——**架构设计必须领域无关**。
钢贸相关代码只能放 `src/connector/biz/` 或 `skills/`，不能进核心层。

## 构建与测试

```bash
pnpm build          # 编译后端（tsup）
pnpm build:all      # 编译后端 + 构建前端
pnpm test           # vitest 测试套件
pnpm tsc --noEmit   # 纯类型检查（不输出文件）
```

**每次代码变更后必须执行**: `pnpm build && pnpm test`，两者均通过才算完成。

## 文件索引（改代码前必看）

| 模块 | 关键文件 | 职责 |
|------|---------|------|
| 入口 | src/index.ts | 初始化所有模块、EventBus 接线 |
| 路由 | src/connector/router.ts | 三层架构调度（Reflex/Deliberation/Anticipation） |
| 大脑 | src/kernel/brain.ts | LLM 对话 + 记忆注入 + 工具调用 |
| 记忆管理 | src/memory/manager.ts | 提取/存储/检索记忆 |
| 检索引擎 | src/bubble/aggregator.ts | 4-Path Fusion（关键词+向量+图+时间衰减） |
| 反思引擎 | src/memory/reflector.ts | observation discover/validate/suggest 闭环 |
| 接线模块 | src/wiring/action-feedback.ts | State-Action 循环 EventBus wiring |
| 事件类型 | src/event/event-types.ts | 所有事件的 discriminated union |
| 数据模型 | src/shared/types.ts | 所有 TypeScript 类型 |
| 数据库 | src/storage/database.ts | SQLite schema + 迁移 |
| 调度器 | src/scheduler/scheduler.ts | 定时任务注册 |
| 服务器 | src/server/api.ts | HTTP 入口（已拆为 routes/） |

## 架构关键约定

- **EventBus 命名规范**: `domain.entity.action`（例：`action.step.completed`）
- **新事件必须加入** `BubbleEventData` 联合类型（event-types.ts 末尾）
- **新接线逻辑放** `src/wiring/`，不修改已有模块内部
- **Feature Flag 保护**: 所有新模块受 `config.features.*` 开关保护
- **spaceId**: 多租户隔离字段，查询时必须透传，不可遗漏

## 数据类型规范

- `confidence`: `number`，范围 `[0, 1]`，写入前必须 `clamp(0, 1)`
- `urgency`: `'low' | 'medium' | 'high' | 'critical'`（枚举，不用自由字符串）
- `impactType`: `'financial' | 'operational' | 'strategic' | 'compliance'`
- 推导字段（如 `sanitizeVerdict`）在 LLM schema 外生成，不进 prompt

## 开发规范

1. **先读后改** — 修改任何文件前必须先读它，不猜内容
2. **最小改动** — diff 中每一行必须直接追溯到任务要求
3. **类型安全** — 新代码必须有 TypeScript 类型，禁用 `as any`
4. **不顺手重构** — 发现不相关问题提一嘴，不要动它
5. **领域无关** — 核心层不硬编码业务逻辑

## 协作模式：Handoff Protocol

### 角色分工

| 角色 | 职责 | 不做 |
|------|------|------|
| **Claude** | 写代码、本地 build+test 自检、写 handoff | git commit / rsync / ssh / pm2 |
| **Qoder** | 审查代码、执行部署命令、写 result | 设计架构、写业务逻辑 |
| **春雨** | 一句话触发、做决策 | 复制粘贴命令 |

### 工作流

```
handoff 目录: .claude/handoff/
  active.md   ← Claude 写（待办）
  result.md   ← Qoder 写（执行结果）
  archive/    ← 已完成归档
```

1. Claude 写代码 → `pnpm build && pnpm test` 通过 → 写 `active.md`（含 handoff-id、变更摘要、精确执行命令）
2. 春雨说"handoff" → Qoder 读 active.md → 审查 → 执行 → 写 result.md → 归档
3. 失败则 Claude 读 result.md 修复

### active.md 必须包含

- `handoff-id`（格式：`feature-name-YYYYMMDD`）
- 变更文件列表（文件名 + 行数变化）
- 精确执行命令（绝对路径，不用相对路径）
- 约束项（哪个进程不能重启、是否需要 pnpm install 等）

### 版本归档

项目**不走 GitHub PR 工作流**，版本演化归档到 Obsidian `30-Evolution/` 目录。

## 部署配置（只读，不修改）

| 项目 | 值 |
|------|----|
| SSH | `ssh -p 22622 root@101.34.243.245` |
| 项目路径（服务器） | `/opt/bubble-agent-os/` |
| 健康检查 | `http://localhost:3000/api/health` |
| PM2 进程 | `bubble` (id=0)，`bobi` (id=1) 不动 |
| rsync 排除 | `--exclude='.env'`（生产凭据不覆盖） |
