# Bubble Agent OS — 功能全景与演化路线图

> 最后更新：2026-05-07

---

## 一、项目定位

Bubble Agent OS 是面向**钢贸行业**的 AI Agent 操作系统，定位为**华瑞隆的对外统一代言人**。

- 对内：姜春雨的私人业务助理（全量视图）
- 对外：以华瑞隆身份面向供应商、客户、司机提供 24h 在线专业服务
- 设计哲学：涌现式设计（基于真实使用反馈渐进补全，不预设完整架构）
- 记忆模型：海洋模型（非仓库模型），信息自然流动、压实、涌现

---

## 二、技术栈

| 层 | 技术 |
|----|------|
| 语言 | TypeScript (Node.js) |
| Web 框架 | Fastify |
| 数据库 | SQLite（双写模式：bubble 记忆表 + 结构化业务表）|
| LLM | DeepSeek API（主）/ 本地 Ollama（规划中）|
| 连接器 | 飞书 WebSocket + 企微 Callback |
| 前端 | Vue 3 + Vite (PWA) |
| 部署 | PM2 @ 腾讯云 Ubuntu |
| 构建 | tsup (backend) + Vite (frontend) |

---

## 三、已实现功能清单

### 3.1 核心引擎

| 模块 | 说明 | 状态 |
|------|------|------|
| 分层路由 | Reflex → Deliberation → Anticipation 三级决策 | ✅ 已上线 |
| Brain (LLM 对话) | 多轮对话 + 工具调用 + 上下文注入 | ✅ 已上线 |
| Skill Router | 基于关键词/意图匹配分发给 Skill Handler | ✅ 已上线 |
| Message Router | 飞书/企微消息统一路由 | ✅ 已上线 |
| EventNotifier | 事件同步（对外推送通知） | ✅ 已上线 |

### 3.2 记忆系统

| 模块 | 说明 | 状态 |
|------|------|------|
| 三层压实 | 原子 bubble → 综合 observation → 空间画像 profile | ✅ 已上线 |
| 时间属性 | t_lindy（林迪权重）、t_silence（静默天数）、t_exposure（敞口金额） | ✅ 已上线 |
| 对称镜像 | 同一事件自动生成对方视角的镜像体验 | ✅ 已上线 |
| 语义桥 | Semantic Bridge — 跨空间关联发现 | ✅ 已上线 |
| 惊讶检测 | Surprise Detector — 信息熵偏离度判断 | ✅ 已上线 |
| 集中度追踪 | Focus Tracker — 注意力集中度预警 | ✅ 已上线 |
| 记忆衰减 | Memory Decay — 未验证知识自动衰减 | ✅ 已上线 |
| 对话洞察评估 | Conversation Insight Evaluator | ✅ 已上线 |
| 证据链 | Evidence Chain — 知识溯源 | ✅ 已上线 |

### 3.3 业务数据层

| 模块 | 说明 | 状态 |
|------|------|------|
| Excel 导入 | SheetJS 解析 → LLM Schema Inference → 结构化入库 | ✅ 已上线 |
| 导入 Guardrails | 金额/吨数/日期范围校验 | ✅ 已上线 |
| 模糊列名匹配 | 适应不同 Excel 模板的列名差异 | ✅ 已上线 |
| 11 个 biz 查询工具 | 采购/销售/物流/收付款/报表/Excel交叉验证 | ✅ 已上线 |
| 双视角查询 | 己方视角 + 对方视角切换 | ✅ 已上线 |
| 工具调用 Tracing | 完整调用链路记录 | ✅ 已上线 |

### 3.4 对外接口 (Phase 2)

| 模块 | 说明 | 状态 |
|------|------|------|
| 身份识别 | 外部用户自动识别角色（供应商/客户/司机） | ✅ 已上线 |
| 6 个外部工具 | ext_my_orders, ext_my_payments, ext_my_logistics, ext_price_inquiry, ext_confirm_receipt, ext_payment_status | ✅ 已上线 |
| 3 个管理员工具 | ext_bind_contact, ext_unbind_contact, ext_list_contacts | ✅ 已上线 |
| 信息边界 | 每个角色仅访问自身相关数据 | ✅ 已上线 |

### 3.5 自主调度任务 (Scheduler)

| 任务 | 说明 | 状态 |
|------|------|------|
| bubble-compaction | 记忆三层压实执行 | ✅ 已上线 |
| reflection | 反思机制 — 从对话中提取 observations | ✅ 已上线 |
| interest-search | 兴趣驱动的主动搜索 | ✅ 已上线 |
| feed-watcher | 订阅源监控 | ✅ 已上线 |
| keyword-monitor | 关键词监控 | ✅ 已上线 |
| silence-scan | 静默预警 — 供应商/客户长时间无互动告警 | ✅ 已上线 |
| concentration-scan | 集中度预警 — 风险集中度过高告警 | ✅ 已上线 |
| steel-price | 钢价行情抓取 | ✅ 已上线 |
| daily-digest | 每日摘要 | ✅ 已上线 |
| learning-digest | 学习摘要 | ✅ 已上线 |
| self-dialogue | 自对话 — 内部推演 | ✅ 已上线 |
| question-generator | 问题生成器 | ✅ 已上线 |
| self-evolution | 自进化 — 代码自我改进（含 Karpathy 假设守卫） | ✅ 已上线 |
| evolution-git | 自进化 Git 操作层 | ✅ 已上线 |
| evolution-risk | 自进化风险评估 | ✅ 已上线 |
| causal-eval | 因果评估器 | ✅ 已上线 |
| pressure-sim | 压力模拟 | ✅ 已上线 |
| memory-decay | 记忆衰减调度 | ✅ 已上线 |

### 3.6 工具层 (Tools)

| 工具 | 说明 | 状态 |
|------|------|------|
| code-tools | 代码读写 + Shell 执行（自进化基础） | ✅ 已上线 |
| web-search | 网页搜索 | ✅ 已上线 |
| fetch-page | 网页内容抓取（支持 Obscura 渲染） | ✅ 已上线 |
| obscura-client | Rust 无头浏览器封装（深度阅读 JS 渲染页面） | ✅ 已上线 |
| weather | 天气查询 | ✅ 已上线 |
| time | 时间查询 | ✅ 已上线 |
| excel-translator | Excel 格式转换 | ✅ 已上线 |
| doc-import | 文档导入 | ✅ 已上线 |
| schema-inference | LLM 驱动的 Excel Schema 推理 | ✅ 已上线 |
| markitdown-tool | PDF/Word/PPT/图片/音频等转 Markdown（MarkItDown） | ✅ 已上线 |

### 3.7 编码纪律 (今日新增)

| 项 | 说明 | 状态 |
|----|------|------|
| Karpathy P1 守卫 | self-evolution 必须暴露假设，不确定则跳过 | ✅ 已上线 |
| Karpathy P2 精简 | code-handler 5 行检查清单替代完整 SKILL.md | ✅ 已上线 |
| Karpathy P4 测试 | code-tools 13 项冒烟测试 | ✅ 已上线 |
| AGENTS.md 纪律 | 4 原则写入 Qoder 工作手册 | ✅ 已完成 |

---

## 四、演化路线图与完成度

### 哲学框架：从理性到感知

```
绝对理性 → 感知因果 → 感知时间 → 感知情感
   ↑当前位置               →→→ 未来方向
```

- **人类做减法**（去掉情绪遮蔽）→ 看到"感"
- **Bubble 做加法**（从理性堆叠因果/时间/温度）→ 走向"感"
- 两条路径的交汇点 = "感"

### Phase 完成度

| Phase | 名称 | 核心能力 | 完成度 |
|-------|------|----------|--------|
| Phase 0 | 时间属性 | t_lindy, t_exposure, t_silence, 对称镜像 | ✅ 100% |
| Phase 1 | 内部感知 | 静默预警, 敞口查询, 空间画像, 集中度预警 | ✅ 100% |
| Phase 2 | 对外接口 | 身份识别, 外部工具, 事件推送, 信息边界 | ✅ 100% |
| Phase 3 | 深化 | 自进化, 语义桥, 惊讶检测, 兴趣搜索, 深度阅读 | ✅ ~90% |
| Phase 4 | 认知取向 | 因果评估器, 自学习内化, 反确认偏差 | 🔧 ~30% |
| Phase N | 动作层 | GUI Agent (Mano-P), ERP 操作, 物流平台操作 | 📋 0% 规划中 |

### Phase 3 剩余项

- [ ] feed-watcher Obscura 集成（高惊讶度页面自动深度渲染）
- [ ] 飞书端 self-evolution approve/reject 命令处理器

### Phase 4 — 认知取向（下一阶段重点）

| 组件 | 说明 | 状态 |
|------|------|------|
| 因果评估器 (causal-eval) | 判断"信息能改变我对什么的理解" | ✅ 代码已上线，效果待验证 |
| 认知取向图 | 由 observations 自然涌现，不硬编码领域 | 📋 设计中 |
| 内化机制 | 更新已有 observation 的趋势而非堆积新 bubble | 📋 设计中 |
| 反确认偏差 | 每次搜索包含反面查询 | 📋 设计中 |
| 证据溯源 | 外部/系统来源可信度区分 | ✅ evidence-chain 已上线 |
| 混合模型路由 | 业务数据→安全模型，搜索评估→DeepSeek | 📋 规划中 |
| Token 空转短路 | 无新数据不调 LLM | 📋 规划中 |

### Phase N — 动作层（远期）

- 技术选型：Mano-P（明略科技，纯视觉 GUI Agent）
- 架构：Bubble = 大脑（决策+记忆），Mano-P = 手（GUI 操作）
- 前置条件：Mano-P 开源代码发布 + CLI/SDK 稳定
- 当前状态：持续跟踪，代码尚未完全开源

---

## 五、安全原则

| 原则 | 说明 |
|------|------|
| 可纠正性 | observation 是假设非事实，用户可随时推翻 |
| 反确认偏差 | 防止认知隧道效应 |
| 证据溯源 | 每条知识有完整证据链 |
| 空间隔离 | 自学习继承 spaceId 边界 |
| 衰减遗忘 | 未验证知识高衰减（0.15），人工确认才稳定（0.02）|
| 行为边界 | 对外行为需高可信度 + 人工确认 |
| 信息边界 | 外部角色仅能获取与自身强相关的信息 |

---

## 六、关键数据指标

| 指标 | 值 |
|------|-----|
| 版本 | v1.0.6 |
| biz 查询工具 | 11 个 |
| ext 外部工具 | 9 个 |
| 调度任务 | 18 个 |
| 通用工具 | 10 个 |
| 日均 Token 消耗 | ~30,000-50,000 |
| 服务器 | 腾讯云 Ubuntu (Node 22 + Python 3.12) |

---

## 七、下一步行动（无时间线）

1. **Phase 4 认知取向核心**：实现认知取向图 + 内化机制
2. **反确认偏差**：interest-search 加入反面查询
3. **混合模型路由**：敏感业务数据不走 DeepSeek
4. **Token 优化**：空转短路 + 增量 validate
5. **Phase 3 收尾**：飞书 self-evolution 审批命令
6. **持续跟踪**：Mano-P 开源进度

---

*此文档由 Bubble 团队维护，基于涌现式设计原则 — 每一处改进对应一个被真实感知到的需求。*
