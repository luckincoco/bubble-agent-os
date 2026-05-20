# Spec: Event Gate — 统一入口协议与偏差分类引擎

> 回应 Bubble 2026-05-14 的架构审查反馈
> 状态：待实施 | 优先级：P1（阻塞后续时间感知演化）

---

## 问题陈述

Bubble 在读取架构设想笔记后，指出了 3 个设计缺口和 2 个隐藏假设：

| # | 问题 | 本质 |
|---|------|------|
| Gap 1 | 原始事件抽取 | 谁来判定一段输入包含几个事件泡泡？边界在哪？ |
| Gap 2 | 去重与合并 | 同一件事说两次 → 1个还是2个 bubble？ |
| Gap 3 | 非事件消失 | 口误、废弃念头怎么不污染系统 |
| Assumption 1 | 偏差≠总需关注 | 周期波动 vs 趋势漂移 vs 真异常 |
| Assumption 2 | 线性 vs 网络 | 多节奏共振问题 |

当前系统已有的相关组件（分散、无统一判断框架）：
- `ConversationInsightEvaluator` — 对话后评估是否值得保存
- `SurpriseDetector` — 数据导入时数值异常检测
- `CausalEvaluator` — 判断信息的因果影响力
- `InternalizationEngine` — 内化决策（更新已有 vs 创建新的）
- `OrientationGraph` — 知识景观与认知取向

---

## 设计方案：Event Gate（事件门控）

### 核心理念

在所有信息入口处设置一个统一的**门控层**，回答一个根本问题：

> 这条输入，值得变成泡泡吗？如果值得，是新建、合并、还是更新？

不新增独立模块，而是在现有流程中织入一个**判决协议**。

### 架构位置

```
原始输入（对话/RSS/搜索/Excel/Obsidian）
    │
    ▼
┌─────────────────────────────────┐
│         Event Gate              │
│  ┌──────────┐  ┌────────────┐  │
│  │ Relevance│→ │ Dedup/Merge│  │
│  │ Filter   │  │ Resolver   │  │
│  └──────────┘  └────────────┘  │
│         │              │        │
│         ▼              ▼        │
│  ┌─────────────────────────┐   │
│  │    Verdict: CREATE /    │   │
│  │    MERGE / UPDATE /     │   │
│  │    DISCARD              │   │
│  └─────────────────────────┘   │
└─────────────────────────────────┘
    │
    ▼
既有流程（createBubble / InternalizationEngine）
```

---

## 模块设计：`src/cognition/event-gate.ts`

### 1. Relevance Filter（相关性过滤）

**职责**：解决 Gap 1（事件抽取边界）和 Gap 3（噪声消除）

```typescript
interface RelevanceVerdict {
  relevant: boolean           // 是否值得处理
  reason: 'novel' | 'reinforcement' | 'contradiction' | 'noise'
  segments: EventSegment[]    // 一段输入可拆出多个事件
  confidence: number          // 0-1
}

interface EventSegment {
  content: string
  type: 'event' | 'fact' | 'thought' | 'meta'
  urgency: 'immediate' | 'routine' | 'background'
}
```

**判定规则（0 LLM 成本的 fast-path）**：

| 条件 | 判定 | 理由 |
|------|------|------|
| 输入 < 20字 且不含数字/专有名词 | DISCARD | 大概率闲聊/确认 |
| 与最近5条 bubble 内容 cosine > 0.92 | → Dedup Resolver | 可能重复 |
| 包含时间表达式 + 实体名 | segments.push(event) | 高概率有结构化事件 |
| 输入来源为 system/scheduler | 直接 CREATE | 系统产出信任度高 |

**需要 LLM 的 slow-path**（仅当 fast-path 无法判定时）：
- 只在 `confidence < 0.5` 时才调用 LLM
- 使用 memory category 的 LLM（共享额度）
- Prompt: "这段内容包含几个独立事件？每个事件的核心是什么？有什么已经知道的吗？"

### 2. Dedup/Merge Resolver（去重合并器）

**职责**：解决 Gap 2（同一事件的去重与合并）

```typescript
interface MergeVerdict {
  action: 'CREATE' | 'MERGE' | 'UPDATE' | 'DISCARD'
  targetBubbleId?: string     // MERGE/UPDATE 时指向已有 bubble
  mergeStrategy?: 'append' | 'replace' | 'increment_weight'
}
```

**判定逻辑**：

```
1. 搜索现有 bubbles（embedding 相似度 + 标题关键词）
2. 如果找到 top match:
   - cosine > 0.95 且 时间间隔 < 1h → DISCARD（完全重复）
   - cosine > 0.85 且 来源相同 → UPDATE（同源更新，保留最新）
   - cosine > 0.75 且 包含新信息 → MERGE（追加证据）
   - cosine < 0.75 → CREATE（新事件）
3. 合并时：
   - 更新 existing bubble 的 content（追加段落）
   - 增加 weight（+0.1，因为被再次提及 = 信号增强）
   - 记录 merge history 到 metadata
```

### 3. Deviation Classifier（偏差分类器）

**职责**：解决 Assumption 1（偏差不总是需要关注）

在 OrientationGraph 的基础上，增加偏差的三级分类：

```typescript
type DeviationType = 'periodic' | 'drift' | 'anomaly'

interface DeviationClassification {
  type: DeviationType
  confidence: number
  action: 'ignore' | 'update_baseline' | 'alert'
  context: string
}
```

**分类标准**：

| 类型 | 判定条件 | 系统行为 |
|------|---------|---------|
| **periodic** | 事件在历史中有周期性出现（±20%时间窗口内重复过3+次） | 标记为"预期内"，不触发告警，不创建 observation |
| **drift** | 连续3+次同方向偏移，且幅度递增 | 更新 OrientationGraph 基线，创建趋势型 observation |
| **anomaly** | 首次出现 或 幅度超过历史 2σ 且无周期解释 | 触发 urgency 事件，立即因果评估 |

**算法实现**（0 LLM）：

```
input: current_event, history_window (30 days)

1. 提取同类事件的时间序列
2. 计算基本统计量（均值、方差、周期检测用 autocorrelation）
3. if autocorrelation_peak > 0.6 at period P:
     检查 current 是否落在 P±20% 的预期窗口内
     是 → periodic
4. elif 最近5个点线性回归 R² > 0.7 且斜率显著:
     → drift（更新基线）
5. else:
     → anomaly
```

### 4. Rhythm Network（节奏网络）— 解决 Assumption 2

**职责**：从线性单变量检测升级为多变量关联检测

不做独立模块，而是扩展 OrientationGraph 的 `OrientationNode` 结构：

```typescript
interface RhythmEdge {
  sourceNodeId: string
  targetNodeId: string
  correlation: number       // -1 to 1
  lag: number              // 时间滞后（天）
  lastUpdated: number
}
```

**核心能力**：
- 当 Node A 出现异常时，检查与 A 强相关的 Node B、C 是否也在滞后期内出现偏移
- 如果多个节点同时异常 → "系统级事件"（升级为 urgency=immediate）
- 如果只有单个节点异常 → "局部事件"（按正常流程处理）

**实现路径**：
- 每次 orientation_snapshot 时，顺带计算相邻节点间的 Pearson 相关系数
- 存储为 `rhythm_edges` 表（source_node_id, target_node_id, correlation, lag）
- 轻量：O(N²) 但 N 是领域节点数（通常 < 30），计算量可忽略

---

## 调度与集成

### 触发时机

Event Gate 不是定时任务，而是**内嵌在数据流中的同步判决**：

| 入口 | 触发方式 | 备注 |
|------|---------|------|
| 用户对话 | Brain.think() 之后，ConversationInsightEvaluator 之前 | 门控 insight 创建 |
| RSS/Feed | feed-watcher 解析每条条目后 | 门控是否创建 bubble |
| 兴趣搜索 | interest-search 结果返回后 | 门控搜索结果质量 |
| Excel导入 | SurpriseDetector.scan 之前 | 门控异常事件颗粒度 |
| Obsidian摄入 | ObsidianIngest 每个文件处理时 | 门控文档级 dedup |

### Deviation Classifier 触发

- 绑定在 `eval_observation` 任务中（daily 6:30）
- 每次 observation 被 validate/strengthen 时，顺带跑一次分类
- 结果写入 observation 的 metadata.deviationType

### Rhythm Network 更新

- 绑定在 `orientation_snapshot` 任务中（daily 6:00）
- 快照完成后，计算相邻节点间相关性
- 新增 scheduler 逻辑：如果检测到多节点共振 → emit `knowledge.system.resonance` 事件

---

## Token 预算

| 组件 | 日均 LLM 调用 | Token 消耗 |
|------|-------------|-----------|
| Relevance Filter (fast-path) | 0 | 0 |
| Relevance Filter (slow-path) | ~5-10次/天 | ~2k tokens |
| Dedup Resolver | 0（纯 embedding 比对） | 0 |
| Deviation Classifier | 0（纯数值计算） | 0 |
| Rhythm Network | 0（Pearson 计算） | 0 |
| **总计** | ≤10 LLM calls/day | ~2k tokens |

---

## 实施计划

### Phase 1: Event Gate 核心（优先）

1. 创建 `src/cognition/event-gate.ts`
   - RelevanceFilter: fast-path 规则 + slow-path LLM 回退
   - DedupResolver: embedding 搜索 + 相似度阈值判定
   - 输出统一 `GateVerdict`

2. 织入现有流程：
   - `ConversationInsightEvaluator.evaluate()` 调用前增加 gate 检查
   - `feed-watcher` 每条条目通过 gate
   - `interest-search` 结果通过 gate

3. 事件类型注册：
   - `knowledge.event.gated` → 记录 gate 判决（供后续审计）

### Phase 2: Deviation Classifier

4. 扩展 `eval-observation` 任务
   - 在 validate 环节后，对每个 observation 跑偏差分类
   - 分类结果写入 metadata

5. 偏差响应逻辑：
   - periodic → 不操作
   - drift → 调用 InternalizationEngine 更新趋势
   - anomaly → emit urgency 事件

### Phase 3: Rhythm Network

6. 扩展 `orientation-snapshot` 任务
   - 快照后计算节点间相关系数
   - 新建 `rhythm_edges` 表

7. 共振检测
   - anomaly 事件触发时，查 rhythm_edges 找关联节点
   - 多节点同时异常 → emit `knowledge.system.resonance`

---

## 安全约束（继承已有原则）

- **可纠正性**：所有 gate 判决可被用户推翻（手动 force-create/force-delete）
- **证据溯源**：每个 verdict 记录在 event log 中（审计链）
- **衰减遗忘**：gate 通过但后续无引用的 bubble 照常衰减
- **空间隔离**：gate 判决继承输入来源的 spaceId

---

## 与 Bubble 回应的对应关系

| Bubble 的问题 | 本方案的回答 |
|--------------|-------------|
| "原始输入变事件泡泡的入口协议是啥？" | Event Gate = 统一判决协议，RelevanceFilter + DedupResolver |
| "偏差分类标准是什么？" | DeviationClassifier: periodic/drift/anomaly 三级分类 |
| "线性 vs 网络" | RhythmNetwork: 节点间相关性 + 共振检测 |
| "去重与合并" | DedupResolver: cosine 阈值梯度判定 |
| "非事件消失" | RelevanceFilter fast-path DISCARD 规则 |

---

## 成功标准

- [ ] 噪声 bubble 创建率下降 > 50%（对比 gate 上线前后 bubble/day）
- [ ] 重复 bubble 归零（同一事件不再出现多个独立 bubble）
- [ ] 偏差分类准确率 > 80%（人工抽样 20 条验证）
- [ ] 多节点共振能在发生后 24h 内被检测到

---

*这篇 spec 也会同步到 Bubble 的 obsidian-ingest 目录，让她参与后续讨论。*
