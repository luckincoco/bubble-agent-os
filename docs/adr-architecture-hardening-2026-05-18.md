# 架构加固三模块设计共识 2026-05-18

## 决策全表

### TaskLedger（跨轮任务状态）

| 决策点 | 结论 | 来源/理由 |
|--------|------|-----------|
| 目录位置 | `src/temporal/` | 时间化实体定位，待涌现编排能力后迁至 workflow/ |
| 存储粒度 | 摘要快照 | 只存 checkpoints、pendingAction、关键引用；不存推理链和变量 |
| 恢复方式 | 先报告状态→等用户确认 | 避免数据过时/优先级变更导致误操作 |
| 与 Episode 关系 | 单向弱引用，用 episodeWindow 区间引用 | 一个任务可能跨多轮对话，区间比单点捕获更完整；Episode 不反向引用 |
| 注入时机 | Router 检测到回指词时主动注入到 Brain.think() 前的上下文 | Brain 做自己该做的就行，不需要做元判断 |
| 表结构 | 包含 plan_steps（完整步骤序列+依赖+备选）和 checkpoints（完成标记） | 两者职责不同，不冗余 |

### ActionPlanner（行动计划生成与执行）

| 决策点 | 结论 | 来源/理由 |
|--------|------|-----------|
| 计划生成方式 | 动态生成为主，机械流程模板为辅 | 对齐涌现式设计哲学 |
| 触发判断链 | Router(Layer 0) 做粗筛标记 → Brain.think() 最终判定（条件：步骤>=3 或 含不可逆操作或用户要求分步） | PlanGuard 无需独立模块，十几行规则就地处理 |
| 失败分级处理 | 可重试型：自动重试1次；数据异常：停下来报告等确认；不可逆操作失败：绝对停 | 最小化中断 vs 风险控制 |
| 用户中断能力 | 必须可中断，用户指令优先级永远高于 plan 下一步 | 这是 Plan 模式和自动化脚本的本质区别 |
| 步骤依赖模型（初始） | 仅支持串行和并行，不做 DAG | 涌现式设计——不为假设需求预建复杂度 |

### BoundaryChecker（统一边界检查）

| 决策点 | 结论 | 来源/理由 |
|--------|------|-----------|
| 入口位置 | ToolRegistry.invoke() 内建，所有工具调用必经 | 统一治理，不依赖调用方自觉过检查 |
| 内部分流 | 零风险（白名单<1ms）→ 中风险（硬规则）→ 高风险（硬+柔性LLM） | 调用方无需知晓分流逻辑 |
| evolution-risk 位置 | 迁入硬规则层，原文件不删，改造成纯函数模块 | self-evolution 引用不受影响 |
| 硬规则格式 | TypeScript 配置文件 + 预埋 JSON 接口 | 正确性优先，第二阶段用 feature flag 开启 JSON self-evolution |
| reversible 声明 | 工具注册时声明，未声明默认不可逆 | 零信任姿态 |
| 柔性判断演化路径 | 用户定框架→AI判定→用户覆盖(approve/reject)→AI学习→调阈值 | 同 InternalizationEngine 审批模式，复用反馈收集机制 |
| 日志记录 | 每次检查写 Episode(type:'system', source:'boundary-check')，通过简记、拦截详记 | daily-digest 可汇报拦截统计 |
| cost 阈值（初始） | 仅监控 token 成本，单次工具调用>=5000 token 触发审批确认 | 金钱/业务成本放第二阶段 |
| GateCheckResult 字段 | decision/reason/suggestion/riskLevel/triggeredRule/source | 消费方是 ToolRegistry，与 ApprovalResult 不共用类型 |

### Feature Flag

| 字段 | 值 |
|------|-----|
| `features.boundaryRuleSelfEvolution` | `false`，锁死 |
| 控制对象 | AI 是否能自主调整 BoundaryChecker 硬规则的 JSON 配置文件 |
| 启用条件 | 用户手动改为 `true` |

---

## 修正后的全景流程

```
用户输入
    |
Router (Layer 0)
+-- 意图分类
+-- 回指词检测 + 预读 TaskLedger（如有活跃 ledger）
+-- 复杂度粗筛（步骤>=3/含不可逆操作 -> multi_step_flag）
    |
[如有活跃 ledger] system prompt 结构化注入 ledger 摘要
    |
Brain.think()
+-- 非 Plan 模式 -> 直接决策 -> 调 Tool -> ToolRegistry.invoke()
|                                               +-- Gate Layer --> 执行/拦截
+-- Plan 模式 -> ActionPlanner -> 生成计划 -> 逐步骤
                                              +-- ToolRegistry.invoke()
                                                   +-- Gate Layer --> 执行/拦截
```

---

## 实施顺序

| 步骤 | 模块 | 前置依赖 | 产出 |
|------|------|---------|------|
| **Step 1** | TaskLedger | 无（最独立） | 跨轮任务状态骨架，后续模块可立即基于其恢复上下文 |
| **Step 2** | Gate Layer | 建议在 TaskLedger 之后 | 内建在 ToolRegistry.invoke()，立即覆盖所有工具调用 |
| **Step 3** | ActionPlanner | 依赖 TaskLedger + Gate Layer | 安全检查保障下的跨轮行动编排能力 |

---

## 下次对话时的前置条件

- 用户说"开始实施架构加固"时进入实施阶段
- 实施顺序按 Step 1 -> Step 2 -> Step 3 推进
- 所有决策点已有明确批复，不需重开讨论
