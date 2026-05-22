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

### active.md rsync 命令注意

rsync 命令**必须**包含 `-e "ssh -p $SSH_PORT"`（服务器 SSH 端口非默认 22），且 web/ 目录同步应加 `--delete` 以清理服务器端已删除的文件。正确模板：

```bash
rsync -avz --delete -e "ssh -p $SSH_PORT" --exclude='node_modules' --exclude='.env' --exclude='.git' --exclude='dist' --exclude='.claude' web/ $DEPLOY_USER@$DEPLOY_HOST:/opt/bubble-agent-os/web/
```

### result.md 编写规范

result.md 由 **Qoder 执行后写入**，Claude 不要预写执行结果。Claude 只需在 result.md 中填写自己能验证的部分：

**Claude 应写的：**
- 变更内容（与 active.md 一致）
- 本地 build + test 结果（Claude 自己跑的）
- 架构决策和技术说明
- 代码审查发现

**Claude 不应写的（Qoder 的职责）：**
- 服务器端 build 时间、远程测试数字 — Qoder 会用实际执行数据覆盖
- PM2 状态、健康检查结果 — Qoder 执行后才知道
- 任何未经验证的"✅" — 如果 Claude 没有跑过服务器命令，不要声称它通过

**为什么这样做：** 此前每个 handoff 都出现 Claude 预写的数字与实际执行不符（build 时间偏差、测试计数过时），Qoder 每次都要纠正。让 Claude 只写自己验证过的内容，Qoder 补充部署结果，避免信息污染。

**关于测试覆盖的价值评估：** result.md 中涉及测试覆盖时，除了报告数量（X tests / Y files），还应评估测试的实际保护范围。纯 mock 单元测试和真实 DB 集成测试提供的信心等级不同，不应等同呈现。

### 版本归档

项目**不走 GitHub PR 工作流**，版本演化归档到 Obsidian `30-Evolution/` 目录。

## Web 端（`web/` 目录）

### 技术栈

| 层 | 选型 |
|----|------|
| 框架 | React 19 + Vite |
| 语言 | TypeScript（严格模式，与后端一致） |
| 样式 | **CSS Modules**（不引入 Tailwind / shadcn/ui，现有 variables.css token 体系已够用） |
| 状态管理 | Zustand |
| API 通信 | `fetch` + WebSocket（对话流式输出） |

### 目录约定

```
web/
  src/
    components/
      layout/       # AppShell、Header、Sidebar 等布局组件
      chat/         # 对话流主区域（ConversationView、MessageBubble、InputBar）
      sidebar/      # 认知状态面板（CognitiveSidebar）
      auth/         # 登录页
      settings/     # 设置面板
    stores/         # Zustand stores
    hooks/          # 自定义 hooks
    services/       # API client、WebSocket 管理器
    types/          # 前端类型定义
    styles/         # 全局样式（reset.css、variables.css、animations.css）
  index.html
  vite.config.ts
```

### 设计规范（Claude 写 UI 必须遵守）

1. **深色优先** — 默认深色主题，CSS Variables（`variables.css`）定义设计 token，不硬编码
2. **认知层标签** — Bubble 回复可携带 `cognitionLayer`，但**默认隐藏**，用户在设置中开启后显示（蓝/紫/绿 10px 标签）
3. **活跃记忆列表** — 左面板记忆用纯文字列表展示（标题 + 模糊时间），**无置信度条、无百分比、无卡片容器**
4. **压实通知** — 对话流中插入纯文字 inline 通知（`── 记忆已更新：xxx ──`），禁止弹窗
5. **左侧面板角色** — 展示 Bubble 的认知状态（非工具箱），Space 切换器固定顶部，其余元素纯展示不可点击
6. **输入区** — 仅 textarea + 发送按钮，无快捷标签、无 OCR 按钮
7. **状态指示器** — 仅 3 种：○ 空闲 / ● 思考中 / ● 回复完成，不细分更多状态

### 构建命令

```bash
pnpm --filter bubble-web dev        # 启动前端开发服务器（默认 5173）
pnpm --filter bubble-web build      # 构建前端（输出到 web/dist/）
pnpm build:all               # 后端 + 前端一起构建
```

### API 对接约定

- 后端 base URL：`http://localhost:3000/api`（开发，Vite proxy 自动转发）
- 对话接口：`POST /api/chat`（当前走 WebSocket，未来可 SSE）
- Bubble 列表：`GET /api/bubbles?spaceId=xxx`
- 工具调用记录：`GET /api/tools/history?spaceId=xxx`
- **spaceId 必须透传**，每个请求都带，不可遗漏

## 部署配置（只读，不修改）

| 项目 | 值 |
|------|----|
| SSH | `ssh -p $SSH_PORT $DEPLOY_USER@$DEPLOY_HOST` |
| 项目路径（服务器） | `/opt/bubble-agent-os/` |
| 健康检查 | `http://localhost:3000/api/health` |
| PM2 进程 | `bubble` (id=0)，`bobi` (id=1) 不动 |
| rsync 排除 | `--exclude='.env'`（生产凭据不覆盖） |
