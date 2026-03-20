# Why AI Needs Hierarchical Memory: From LeCun's JEPA to Bubble Theory
# 为什么 AI 需要分层记忆：从 LeCun 的 JEPA 到泡泡理论

*A technical deep-dive into the memory architecture behind [Bubble Agent OS](https://github.com/luckincoco/bubble-agent-os)*

---

## The Goldfish Memory Problem / 金鱼记忆问题

ChatGPT changed how we interact with AI. But there's a fundamental flaw that becomes painfully obvious after a few weeks of use: **it doesn't remember you**.

ChatGPT 改变了我们和 AI 的交互方式。但有一个根本性缺陷在使用几周后变得非常明显：**它不记得你**。

Every conversation starts from zero. You explain your context again. You re-describe your preferences. You re-upload the same data. The AI that felt brilliant in the first session feels frustratingly forgetful by the tenth.

每次对话都从零开始。你重新解释背景、重新描述偏好、重新上传数据。第一次觉得惊艳的 AI，到第十次对话时只剩下让人沮丧的健忘。

RAG (Retrieval-Augmented Generation) was supposed to solve this. Store documents, embed them as vectors, retrieve the most similar chunks. It helps, but it's a crude approximation of memory — like replacing a library with a single search bar. You get keyword matches, not understanding.

RAG 本应解决这个问题。存储文档、向量化、检索最相似的片段。有帮助，但这只是记忆的粗略近似——就像用一个搜索栏替代整个图书馆。你得到的是关键词匹配，而非理解。

**What would a real memory system for AI look like?**

**一个真正的 AI 记忆系统应该长什么样？**

---

## LeCun's JEPA: A Clue from World Models / LeCun 的 JEPA：来自世界模型的线索

In 2022, Yann LeCun published [A Path Towards Autonomous Machine Intelligence](https://openreview.net/forum?id=BZ5a1r-kVsf), proposing the Joint Embedding Predictive Architecture (JEPA). The key insight relevant to memory is **hierarchical abstraction**:

2022 年，Yann LeCun 发表了《通向自主机器智能之路》，提出了联合嵌入预测架构（JEPA）。其中与记忆最相关的核心洞察是**分层抽象**：

> The world model should operate at multiple levels of abstraction, with higher levels making predictions over longer time scales and at coarser granularity.

> 世界模型应在多个抽象层次上运作，更高层次在更长的时间尺度上以更粗的粒度进行预测。

This maps directly to how human memory works:

这与人类记忆的工作方式直接对应：

- **Working memory** (seconds): "I just heard a phone number"
- **Episodic memory** (days): "I had a meeting about procurement yesterday"
- **Semantic memory** (years): "I'm a risk-averse operations manager"

- **工作记忆**（秒级）："我刚听到一个电话号码"
- **情景记忆**（天级）："昨天开了一个关于采购的会"
- **语义记忆**（年级）："我是一个风险规避型的运营管理者"

Each level is a **compression** of the one below — not a summary, but an abstraction that preserves the essential patterns while discarding the noise.

每个层次都是下一层的**压缩**——不是总结，而是保留核心模式、丢弃噪声的抽象。

---

## Bubble Theory: Memory as Floating Bubbles / 泡泡理论：记忆如浮动气泡

Bubble Agent OS translates these theoretical insights into a concrete system using the **bubble metaphor**:

泡泡 Agent OS 将这些理论洞察转化为一个具体系统，使用**泡泡隐喻**：

**Every piece of information is a bubble.** New information creates small, high-buoyancy bubbles that float near the surface (working memory). Over time, without reinforcement, they sink (decay). Related bubbles naturally cluster. When enough related bubbles accumulate, they compress into a larger, denser bubble — a higher-level understanding.

**每条信息都是一个泡泡。** 新信息创建小的、高浮力的泡泡，浮在表面（工作记忆）。随着时间推移，没有被强化的泡泡会下沉（衰减）。相关的泡泡自然聚合。当足够多的相关泡泡积累后，它们压缩成一个更大、更致密的泡泡——一个更高层次的理解。

### The Three Levels / 三个层次

```
Level 0: Atomic Bubbles (原子泡泡)
├── "User bought 50 units of detergent on 2026-03-17"
├── "User bought 30 units of dish soap on 2026-03-17"
└── "User bought 100 units of tissues on 2026-03-17"
        ↓ Union-Find clustering + LLM abstraction leap
Level 1: Synthesis Bubbles (综合泡泡)
└── "Periodic bulk procurement of household consumables,
     suggesting systematic purchasing planning and
     pursuit of economies of scale"
        ↓ Further compression across multiple syntheses
Level 2: Portrait Bubbles (画像泡泡)
└── "Risk-aware operations manager with systematic
     procurement habits and strong focus on cash flow
     health and operational efficiency"
```

The critical insight: **Level 1 is not a summary of Level 0.** It's an abstraction leap — discovering the *pattern*, *intent*, and *trend* hidden in the raw facts. The LLM prompt explicitly instructs:

关键洞察：**Level 1 不是 Level 0 的摘要。** 而是一次抽象跃迁——发现隐藏在原始事实中的*模式*、*意图*和*趋势*。LLM 的提示词明确要求：

> "Do not list what the user said. Instead, identify: What pattern does this reveal? What is the underlying motivation? What trend is emerging? What might happen next?"

> "不要列举用户说了什么。而是识别：这揭示了什么模式？底层动因是什么？正在出现什么趋势？接下来可能发生什么？"

### Union-Find: Clustering Without K / Union-Find：无需预设 K 的聚类

A practical challenge: how do you decide which bubbles should be compressed together? K-means requires a predefined number of clusters. Graph partitioning adds heavy dependencies.

一个实际挑战：如何决定哪些泡泡应该被压缩在一起？K-means 需要预定义聚类数量。图分割则引入沉重的依赖。

We use **Union-Find** (disjoint set) — a classic O(n²α(n)) algorithm that merges bubbles based on pairwise similarity:

我们使用 **Union-Find**（并查集）——经典的 O(n²α(n)) 算法，基于成对相似度合并泡泡：

```typescript
// Similarity = tag overlap (40%) + graph links (40%) + time proximity (20%)
// Threshold: 0.3 — merge if above
// Cluster size: min 3, max 12

for (let i = 0; i < bubbles.length; i++) {
  for (let j = i + 1; j < bubbles.length; j++) {
    const sim = tagJaccard(i, j) * 0.4
              + graphLink(i, j) * 0.4
              + timeProximity(i, j) * 0.2;
    if (sim > 0.3) union(i, j);
  }
}
```

No predefined K. No external libraries. The clusters emerge naturally from the data.

无需预设 K。无需外部库。聚类从数据中自然涌现。

---

## Three-Path Fusion: Why One Search Path Isn't Enough / 三路融合：为什么单一搜索路径不够

Traditional RAG uses a single retrieval path: embed the query, find the nearest vectors. This fails in predictable ways:

传统 RAG 使用单一检索路径：嵌入查询，找最近的向量。这种方式在可预测的场景下会失败：

| Query | Vector search fails because... | Better path |
|---|---|---|
| "What's Zhang Wei's phone number?" | Numbers have poor semantic embeddings | **Keyword search** |
| "What have we been discussing lately?" | Needs time awareness, not similarity | **Recency decay** |
| "Anything related to that supplier?" | Needs relationship traversal | **Graph search** |

Bubble Agent OS runs all three paths in parallel and fuses the results with **intent-aware dynamic weights**:

泡泡 Agent 并行运行三条路径，用**意图感知的动态权重**融合结果：

```typescript
const WEIGHT_PROFILES = {
  precise:   { keyword: 0.55, vector: 0.25, graph: 0.10, recency: 0.10 },
  fuzzy:     { keyword: 0.15, vector: 0.45, graph: 0.30, recency: 0.10 },
  temporal:  { keyword: 0.20, vector: 0.20, graph: 0.10, recency: 0.50 },
  aggregate: { keyword: 0.35, vector: 0.30, graph: 0.15, recency: 0.20 },
};
```

Intent is classified by simple heuristic rules — detecting patterns like "最近/today/yesterday" (temporal), "一共/total/how many" (aggregate), "电话/email/address" (precise). No ML model needed.

意图通过简单的启发式规则分类——检测"最近/today/yesterday"（时间）、"一共/total/how many"（聚合）、"电话/email/address"（精确）等模式。不需要 ML 模型。

---

## Surprise Detection: Finding What You Didn't Know to Ask / 惊讶检测：发现你不知道要问的

Most AI systems are purely reactive — they only help when you ask. The Surprise Detector flips this by **passively scanning** for anomalies:

大多数 AI 系统是纯响应式的——只有你问才会帮。惊讶检测器通过**被动扫描**异常来翻转这个模式：

- **Near-duplicate**: New info highly similar to existing memory → low surprise (0.1)
- **Novel**: New info with <40% overlap → high surprise (0.8)
- **Contradiction**: New info conflicts with existing knowledge → maximum surprise (1.0)
- **Numerical anomaly**: Excel import values deviate >20% from historical patterns

When a contradiction is detected, both the old and new bubbles are flagged, and the contradiction itself becomes a high-priority `event` bubble that surfaces in future queries.

当矛盾被检测到时，新旧泡泡都会被标记，矛盾本身变成一个高优先级的 `event` 泡泡，在未来的查询中被优先浮出。

---

## Real Results: First Compaction Run / 实际效果：首次压缩运行

When we first ran the Compaction Engine on a production database with ~200 bubbles, it produced 5 synthesis bubbles:

当我们首次在生产数据库（约 200 个泡泡）上运行压缩引擎时，生成了 5 个综合泡泡：

| Synthesis Bubble | Source Bubbles | Key Insight |
|---|---|---|
| "AI Tool Pragmatism Tendency" | 4 | User evaluates AI by function, not interface |
| "Feishu Business Efficiency Optimizer" | 9 | Core intent is workflow automation via Feishu |
| "Bulk Consumables Procurement" | 3 | Systematic periodic purchasing pattern |
| "Financial Data Monitoring & Annual Review" | 169 | Deep focus on cash flow health and operational risk |
| "Repetitive Anxiety in Financial Monitoring" | 28 | High-frequency monitoring driven by operational concern |

The largest cluster compressed **169 atomic bubbles** (scattered Excel data records) into a single synthesis bubble that captured the essential pattern: *the user is deeply focused on cash flow health and operational efficiency, with monitoring frequency suggesting underlying concern about financial risk*.

最大的聚类将 **169 个原子泡泡**（分散的 Excel 数据记录）压缩为一个综合泡泡，捕获了核心模式：*用户深度关注现金流健康和运营效率，监控频率暗示对财务风险的潜在担忧*。

This is not summarization. This is understanding.

这不是摘要。这是理解。

---

## What's Next / 下一步

Bubble Agent OS is open source and actively developed. The current Compaction Engine is a first implementation — there's much more to explore:

泡泡 Agent OS 是开源的且在积极开发中。当前的压缩引擎是第一版实现——还有更多值得探索的方向：

- **Cross-session learning**: Use portrait bubbles to initialize context for new conversations
- **Predictive memory**: Surface relevant bubbles *before* the user asks, based on temporal patterns
- **Multi-agent memory sharing**: Let different agents contribute to and read from a shared bubble graph
- **Memory visualization**: Interactive graph visualization of the bubble network

If this resonates with you, check out the project and give it a star:

如果你对此感兴趣，欢迎查看项目并给个 Star：

**GitHub**: [github.com/luckincoco/bubble-agent-os](https://github.com/luckincoco/bubble-agent-os)

---

*This article is part of the Bubble Agent OS documentation. The project is MIT licensed and open for contributions.*
