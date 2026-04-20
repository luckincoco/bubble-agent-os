# Bubble Agent OS -- 开发指南

## 项目定位

通用 AI 记忆学习系统。当前验证场景：钢贸。
钢贸是实验田，不是天花板——架构设计必须领域无关。

## 架构速查

### 三层消息路由 (src/connector/router.ts)

- **Layer 0 (Reflex)**: 正则检测 → 零/一次 LLM → 直接返回或注入上下文
  - BizHandler 最高优先级，fullyHandled 时短路跳过 Brain
  - 钢价/搜索意图 → 工具调用 → 结果注入 context
- **Layer 1 (Deliberation)**: Brain.think() + 记忆注入 + 工具调用
- **Layer 2 (Anticipation)**: 异步 fire-and-forget（矛盾检测、未来反思）

### 记忆系统

- **4-Path Fusion 检索** (src/bubble/aggregator.ts): 关键词 + 向量 + 图邻域 + 时间衰减
- **三级抽象**: L0 原子(memory) → L1 合成(synthesis) → L2 画像(portrait)
- **BubbleCompactor** (src/memory/compactor.ts): Union-Find 聚类 → LLM 抽象 → composed_of 链接

### 泡泡数据模型 (src/shared/types.ts)

BubbleType: `memory | entity | event | synthesis | portrait | observation | api | workflow | document | question`
关键字段: id, type, title, content, summary, metadata, tags, embedding, links, confidence, decayRate, abstractionLevel, spaceId, pinned

### 记忆存储 (src/memory/manager.ts)

extractAndStore 流程: LLM 提取 → calcSurprise(Jaccard + 数值矛盾) → 去重/刷新 → confidence/decayRate 调整 → embedding 生成 → 自动 same_turn 链接

## 文件索引（改代码前必看）

| 模块 | 关键文件 | 职责 |
|------|---------|------|
| 入口 | src/index.ts | 初始化所有模块，接线 |
| 路由 | src/connector/router.ts | 三层架构调度 |
| 大脑 | src/kernel/brain.ts | LLM 对话 + 记忆注入 + 工具调用 |
| 记忆管理 | src/memory/manager.ts | 提取/存储/检索记忆 |
| 记忆提取 | src/memory/extractor.ts | LLM 从对话中提取结构化记忆 |
| 惊奇检测 | src/memory/surprise-detector.ts | 矛盾 / 新奇度扫描 |
| 焦点追踪 | src/memory/focus-tracker.ts | 用户关注点动态追踪 |
| 语义桥 | src/memory/semantic-bridge.ts | 跨空间语义关联 |
| 检索引擎 | src/bubble/aggregator.ts | 4-Path Fusion + 两阶段检索(v0.4) |
| 压实 | src/memory/compactor.ts | L0→L1→L2 抽象 |
| 反思引擎 | src/memory/reflector.ts | 发现→验证→建议闭环(v0.4) |
| 数据模型 | src/bubble/model.ts | Bubble CRUD |
| 图操作 | src/bubble/links.ts | BubbleLink CRUD + BFS |
| 类型定义 | src/shared/types.ts | 所有 TypeScript 类型 |
| 数据库 | src/storage/database.ts | SQLite schema + 迁移 |
| 工具注册 | src/connector/registry.ts | ToolRegistry |
| 工具集 | src/connector/tools/*.ts | weather, time, excel, web-search, fetch-page |
| Biz 录入 | src/connector/biz/handler.ts | 钢贸业务录入(v0.3) |
| Biz 检测 | src/connector/biz/detectors/*.ts | 各品类正则检测器 |
| Biz 解析 | src/connector/biz/parser.ts | LLM 结构化解析 |
| 技能加载 | src/connector/skills/loader.ts | SKILL.md 解析器(v0.4) |
| 技能路由 | src/connector/skills/skill-router.ts | 可插拔技能分发(v0.4) |
| 技能配置 | skills/steel-trading/SKILL.md | 钢贸 Skill 定义(v0.4) |
| 反思任务 | src/scheduler/tasks/reflection.ts | 反思引擎定时任务(v0.4) |
| 服务器 | src/server/api.ts | HTTP + WebSocket |
| 调度器 | src/scheduler/scheduler.ts | 定时任务 |
| 飞书 | src/connector/feishu.ts | 飞书 Webhook 连接器 |
| 企微 | src/connector/wecom.ts | 企业微信连接器 |
| 前端 | web/src/ | React + Vite PWA |
| 配置 | src/shared/config.ts | 环境变量 → AppConfig |
| 日志 | src/shared/logger.ts | 统一日志 |
| Token | src/shared/tokens.ts | Token 估算和预算控制 |

## 构建与测试

```bash
pnpm build:all    # 编译 TypeScript + 构建前端
pnpm build        # 仅编译后端
pnpm build:web    # 仅构建前端
pnpm test         # 运行测试（vitest）
```

## 部署（腾讯云）

触发 bubble-bingbu skill 获取完整部署流程。

部署三步：rsync 同步 → 远程 pnpm build:all → pm2 restart。
服务器地址、端口、用户名等信息存储在 bubble-bingbu skill 中，不在此处硬编码。

## 开发规范

1. **先读后改** -- 修改任何文件前必须先 Read 它
2. **最小改动** -- 只改必要的，不加额外重构/注释/docstring
3. **类型安全** -- 所有新代码必须有 TypeScript 类型
4. **上下文节约** -- 不要反复 grep/glob 同一个文件，读一次记住
5. **构建验证** -- 每次改动后 `pnpm build:all && pnpm test`
6. **一个 TODO 一次做** -- 用 TodoWrite 拆分任务，逐个完成，逐个标记
7. **领域无关** -- 新功能不能硬编码业务逻辑，钢贸相关代码只能放 biz/ 或 skills/

## v0.4 路线图

三个方向（详见 bubble-taichang skill）：
1. **分层加载** -- summary 字段 + 两阶段检索（先摘要后全文）
2. **Skill 封装** -- SKILL.md 配置化领域知识，从 biz/ 迁移到可插拔技能系统
3. **反思机制** -- observation 泡泡类型 + discover/validate/suggest 闭环

关键原则：**在知识层把"发现-判断-建议"的闭环跑通**，不急于做模型层的自监督学习。
