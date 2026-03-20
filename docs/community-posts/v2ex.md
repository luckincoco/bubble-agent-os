# V2EX 帖子

**板块**: /t/share 或 /t/programmer

**标题**: 开源了一个有"长期记忆"的 AI 助手：泡泡 Agent OS（三路融合检索 + 泡泡压缩引擎 + 惊讶检测）

---

## 正文

做了一个开源的个人 AI 助手，核心卖点是**真正的长期记忆**。

### 痛点

ChatGPT 是"金鱼记忆"，每次对话从零开始。RAG 解决了一部分，但只是单一向量检索，缺乏记忆智能。

### 泡泡 Agent OS 不一样的地方

**1. 三路融合检索**

查询同时走三条路：关键词搜索 + 向量相似度 + 图谱遍历 + 时间衰减，权重根据查询意图自动调整。

问"我的电话号码"→ 关键词权重 55%
问"最近发生了什么"→ 时间权重 50%
问"帮我总结采购情况"→ 均衡检索

**2. 泡泡压缩引擎**

受 LeCun H-JEPA 启发的分层抽象。原子记忆通过 Union-Find 聚类 → LLM 抽象跃迁 → 生成高阶概念。

实测效果：169 条散碎的 Excel 数据记录被压缩成一个洞察——"用户深度关注现金流健康，监控频率暗示对财务风险的持续担忧"。

这不是摘要，是理解。

**3. 惊讶检测器**

不需要你主动问。导入 Excel 时自动检测数据异常、信息矛盾。矛盾会变成高优先级事件泡泡，下次相关查询时自动浮出。

**4. 焦点追踪**

滑动窗口追踪最近 10 条消息的关键词频率，自动提升相关记忆的检索权重。

### 技术栈

- TypeScript + SQLite + Fastify + React PWA
- 支持 DeepSeek / OpenAI / Ollama（完全本地运行）
- 单端口部署，无需 Postgres/Redis
- ~5000 行代码，MIT 协议

### 快速开始

```bash
git clone https://github.com/luckincoco/bubble-agent-os.git
cd bubble-agent-os && pnpm install
cp .env.example .env  # 填入 API Key
pnpm build:all && pnpm start --serve
# 打开 http://localhost:3000
```

### 链接

- GitHub: https://github.com/luckincoco/bubble-agent-os
- 技术文章（泡泡记忆理论）: https://github.com/luckincoco/bubble-agent-os/blob/main/docs/blog/bubble-memory-theory.md

V 友们有什么建议或想法？欢迎 Star 和 PR。
