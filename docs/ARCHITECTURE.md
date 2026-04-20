# Bubble Agent OS - 功能结构图

> **Living Document** - 在使用过程中随时在 `> 想法:` 区域记录你的改进思路，后期开发时直接参考。
>
> 最后更新: 2026-04-07 | 版本: v1.0.1

---

## 版本历史

| 版本 | 日期 | 主要变更 |
|------|------|---------|
| v1.0.1 | 2026-04-07 | 认知友好数据呈现: LLM回复结构化(Markdown表格), Web UI概况看板+异常告警+进度条+趋势箭头+列精简 |
| v1.0.0 | 2026-03-30 | 正式版: 功能模块弹窗居中修复, 版本号升级 |
| v0.8.0 | 2026-03-30 | Phase 2+3: 全站响应式重构 + SaaS 交互打磨 (15个文件) |
| v0.7.1 | 2026-03-30 | 交易对手可搜索筛选 (combobox)，RecordList 触控优化 |
| v0.7.0 | 2026-03-28 | Phase 1: doc_no 回填修复, space_id 数据隔离, 按单号利润报表 |
| v0.6.0 | 2026-03-27 | 业务模块首版上线 |

### v0.8.0 变更详情 (Phase 2: 移动端响应式 + Phase 3: SaaS UI 打磨)

**设计体系:**
- 新增设计 token 体系: spacing (4-32px), typography (11-18px), 触控目标 (44px), 内容最大宽度 (640/960/1200px)
- 三级响应式断点: 手机 (0-599px), 平板 (600px+), 桌面 (1024px+)
- 全局 `::selection` 品牌色, 按钮默认过渡动画

**布局改进 (Wave 1):**
- AppShell 内容区从 768px 扩展到 1200px
- Header 改为 sticky 定位 + backdrop blur 毛玻璃效果
- NavTabs 增大触控区域 + hover 态

**表单响应式 (Wave 2):**
- PurchaseEventForm/SaleEventForm: 手机端表单行自动堆叠 (column), 桌面端水平排列 (row)
- EntryView: 同上响应式模式
- SearchSelect: 下拉动画 (fadeSlideUp), 选项高度达 44px 触控标准
- BusinessFlow: 响应式网格 (手机3列, 桌面4列), 详情内容居中约束

**数据视图 (Wave 3):**
- RecordList: 所有按钮/输入框触控目标增大, `:active` 按压反馈
- QueryView: 手机端表格自动转卡片布局 (隐藏表头, `data-label` 伪元素显示标签)
- ReportView: 4 个报表子视图全部支持手机端卡片化 (利润/按单号/对账单/月度总览)
- MasterDataPanel: 表单行响应式, 编辑/删除按钮触控优化

**交互打磨 (Wave 4):**
- 所有可交互元素: `:active { transform: scale(0.96) }` 按压反馈
- 输入框: `:focus { box-shadow: 0 0 0 3px rgba(..., 0.15) }` 聚焦光晕
- 下拉菜单: fadeSlideUp 动画

---

## 整体架构

```
                          Bubble Agent OS v0.8.0
 ┌──────────────────────────────────────────────────────────────┐
 │                        接入层                                │
 │   飞书 WebSocket ─┐                                         │
 │   企业微信 Webhook ┼── MessageRouter ── Brain (LLM推理)      │
 │   Web 前端 Chat ──┘        │                                │
 │                            ├── 工具调用 (钢价/天气/搜索)     │
 │                            ├── 业务识别 → BizEntryHandler    │
 │                            └── 教学识别 → TeachHandler       │
 ├──────────────────────────────────────────────────────────────┤
 │                       记忆层                                 │
 │   MemoryManager ── 提取/存储/检索/衰减                       │
 │   SemanticBridge ── 实体关联                                 │
 │   SurpriseDetector ── 异常发现                               │
 │   FocusTracker ── 对话焦点追踪                               │
 │   Compactor ── L0→L1→L2 记忆压缩                            │
 │   Reflector ── 规律发现与验证                                │
 ├──────────────────────────────────────────────────────────────┤
 │                       业务层                                 │
 │   结构化存储 (biz_*表) ── 单据生命周期 ── 报表引擎           │
 │   Excel桥接 ── 实体自动解析 ── 去重                          │
 │   交易对手筛选 (可搜索 combobox)                             │
 ├──────────────────────────────────────────────────────────────┤
 │                       前端层 (响应式)                         │
 │   设计 Token → 3级断点 (手机/平板/桌面)                      │
 │   触控优化 (44px) → 卡片化表格 → 毛玻璃导航                  │
 ├──────────────────────────────────────────────────────────────┤
 │                       存储层                                 │
 │   SQLite (bubbles + biz_*表 + users + spaces)                │
 └──────────────────────────────────────────────────────────────┘
```

---

## 1. 接入层 (Connectors)

### 1.1 飞书连接器
`src/connector/feishu.ts`
- WebSocket 长连接，接收卡片消息
- 消息路由到 MessageRouter → Brain

> 想法:

### 1.2 企业微信连接器
`src/connector/wecom.ts`
- Webhook 签名验证 + 消息解析
- 同样路由到 MessageRouter

> 想法:

### 1.3 消息路由器
`src/connector/router.ts`
- Layer 0 (反射): 正则检测钢价/搜索意图 → 直接工具调用
- Layer 1 (深思): Brain.think() 完整推理
- 异步触发 SurpriseDetector 扫描

> 想法:

### 1.4 Web 前端 (Chat)
`web/src/components/chat/`
- ChatView + InputBar + MessageBubble
- WebSocket 流式响应
- 支持上传 Excel/PDF/图片

> 想法:

---

## 2. 核心推理 (Kernel)

### 2.1 Brain
`src/kernel/brain.ts`
- 对话历史管理 (每用户独立，40条上限)
- Token 预算分配 (系统提示 + 工具 + 记忆 + 历史)
- 记忆注入: 检索 top 20 加权气泡作为上下文
- 工具调用检测与执行
- Agent 切换 (自定义 Agent 的 system prompt)

> 想法:

---

## 3. 记忆系统 (Memory)

### 3.1 记忆管理器
`src/memory/manager.ts`
- 从对话中提取新记忆 → 计算惊奇分 → 存储为气泡
- 检索时双阶段: 轻量摘要搜索(30条) → 加载 top 20 完整内容

> 想法:

### 3.2 记忆提取器
`src/memory/extractor.ts`
- LLM 驱动，从对话中过滤出可操作事实 (姓名/偏好/习惯)
- 赋予置信度分数

> 想法:

### 3.3 语义桥接
`src/memory/semantic-bridge.ts`
- Excel 导入时自动识别实体列 → 关联到已有气泡网络
- 创建加权 `related` 链接

> 想法:

### 3.4 惊奇检测
`src/memory/surprise-detector.ts`
- 监控 Excel 导入和消息中的异常 (数值尖峰/矛盾/新实体)
- 创建 `event` 气泡标记 `surprise`

> 想法:

### 3.5 焦点追踪
`src/memory/focus-tracker.ts`
- 滑动窗口记录最近对话关键词
- 给检索结果加 0~0.15 的相关性加权

> 想法:

### 3.6 记忆压缩
`src/memory/compactor.ts`
- L0 (原子记忆) → L1 (综合概念): LLM 抽象 + Union-Find 聚类
- L1 → L2 (用户画像): 更高层次的模式发现
- 加速子记忆衰减

> 想法:

### 3.7 反思引擎
`src/memory/reflector.ts`
- 从记忆模式中发现规律 → 创建观察气泡
- 用新证据验证趋势: new → strengthening → stable → weakening → stale

> 想法:

---

## 4. 业务模块 (Biz)

### 4.1 自然语言录入
`src/connector/biz/handler.ts` + `detector.ts` + `parser.ts` + `store.ts`
- 正则检测业务意图 (采购/销售/物流/收付款)
- LLM 解析为结构化记录 (时间-人-物-值)
- 双写: 气泡 + biz_* 结构化表

> 想法:

### 4.2 结构化存储
`src/connector/biz/structured-store.ts`
- 产品 (`biz_products`): 品牌/名称/规格/件重
- 交易方 (`biz_counterparties`): 供应商/客户/物流商
- 项目 (`biz_projects`): 工程项目/合同
- 采购单 (`biz_purchases`): 供应商+产品+吨位+金额
- 销售单 (`biz_sales`): 客户+产品+吨位+金额+毛利
- 物流单 (`biz_logistics`): 承运商+运费+吊费
- 收付款 (`biz_payments`): 方向+金额+方式
- 发票 (`biz_invoices`): 进项/销项+税率

> 想法:

### 4.3 单据生命周期
`src/connector/biz/doc-engine.ts`
- 状态机: draft → confirmed → completed → cancelled
- 单据链接: 销售→物流→发票→付款
- 修订 (Amendment): 已确认单据可修订生成新草稿

> 想法:

### 4.4 报表引擎
`src/connector/biz/reports.ts`

| 报表 | 说明 | 状态 |
|------|------|------|
| 利润报表 | 按月统计采购/销售/毛利/吨位, 支持客户/供应商筛选 | 已实现 |
| **按单号利润** | 以 doc_no 为维度, 关联采购/销售/物流/毛利 (v0.7.0) | **已实现** |
| **往来对账单** | 按交易方汇总采购/销售/收付款/发票 | **已实现，很满意** |
| 月度总览 | KPI 汇总 + 同环比 | 已实现 |

> 想法: 对账单效果很好，保留。按单号报表是 v0.7.0 新增。

### 4.5 交易对手筛选 (v0.7.1)
`web/src/components/biz/RecordList.tsx`
- 可搜索 combobox: 输入文字实时过滤交易对手列表
- 点击详情中的交易对手名称可直接设为筛选条件
- 支持采购/销售/物流/收付款/发票全部列表

> 想法:

### 4.6 Excel 桥接
`src/connector/biz/excel-bridge.ts`
- Excel 导入时自动同步到 biz 结构化表
- EntityCache: 自动解析/创建交易方、产品、项目
- 去重机制: 日期+交易方+金额匹配
- 导入后自动确认 (confirmed)

> 想法:

### 4.7 计算视图
`src/connector/biz/structured-store.ts` (后半部分)
- 库存 = 采购吨位 - 销售吨位
- 应收 = 销售额 - 已收款
- 应付 = 采购额 - 已付款
- Dashboard KPI: 今日采购/销售/物流 + 总库存/应收/应付

> 想法:

---

## 5. 工具系统 (Tools)

### 5.1 Excel 翻译器
`src/connector/tools/excel-translator.ts`
- 表名识别 → 行翻译 → 知识卡片 → 聚合汇总
- 支持: 采购/销售/物流/收付款/产品信息/供应商信息/客户信息

> 想法:

### 5.2 Excel 查询/导出/清洗
`src/connector/tools/excel.ts`
- query_excel: 查询已导入的 Excel 数据
- export_excel: 导出为 .xlsx 下载
- clean_excel: 去重/填充/去空白/格式统一
- cross_analyze: 多表交叉关联分析

> 想法:

### 5.3 文档导入
`src/connector/tools/doc-import.ts`
- 支持 PDF / Word (DOCX) / TXT
- 自动分段 + OCR (腾讯云)

> 想法:

### 5.4 其他工具
- `web-search.ts`: 网页搜索
- `fetch-page.ts`: 网页抓取 (钢价行情页)
- `weather.ts`: 天气查询
- `time.ts`: 当前时间

> 想法:

---

## 6. 定时任务 (Scheduler)

`src/scheduler/scheduler.ts` + `tasks/`

| 任务 | 时间 | 说明 |
|------|------|------|
| 钢价抓取 | 工作日 9:30 | 抓取当日钢价 → 飞书推送 |
| 每日摘要 | 每日 | 综合近期记忆 → 摘要推送 |
| 记忆衰减 | 每日 | 按 decay_rate 降低置信度 |
| 记忆压缩 | 每日 4:00 | L0→L1→L2 抽象压缩 |
| 反思 | 每日 6:00 | 规律发现与趋势验证 |
| 关键词监控 | 定期 | 关键词出现时创建提醒 |
| 提问生成 | 定期 | 从记忆生成启发性问题 |

> 想法:

---

## 7. 前端 UI

### 7.1 设计体系 (v0.8.0)
`web/src/styles/variables.css` + `reset.css`

**设计 Token:**
```
间距: --space-1(4px) ~ --space-6(32px)
字号: --text-xs(11px) ~ --text-xl(18px)
触控: --tap-min(44px)
宽度: --content-sm(640px) / --content-md(960px) / --content-lg(1200px)
```

**响应式策略:** CSS-only, 不使用 JS 断点检测
- 手机 (0-599px): 表单堆叠, 表格转卡片, 单列布局
- 平板 (600px+): 表单行内排列, 网格 4 列
- 桌面 (1024px+): 加大内边距, 宽屏优化

**交互规范:**
- 按压反馈: `:active { transform: scale(0.96) }`
- 聚焦光晕: `:focus { box-shadow: 0 0 0 3px rgba(color, 0.15) }`
- 毛玻璃: `backdrop-filter: blur(12px)` (Header/NavTabs)
- 品牌选区: `::selection { background: rgba(124, 58, 237, 0.3) }`

### 7.2 主导航 Tab
`web/src/components/layout/NavTabs.tsx`

| Tab | 组件 | 说明 |
|-----|------|------|
| 对话 | ChatView | 与 agent 对话 |
| 记忆 | MemoryPanel | 查看/搜索记忆气泡 |
| **业务** | BusinessFlow | 进销存管理 |
| 调度 | SchedulerView | 定时任务管理 |
| 设置 | ModuleSettings | 模块开关 |

> 想法: 业务 tab 里有些子 tab 不需要，后期精简。

### 7.3 业务子模块
`web/src/components/biz/`

| 子模块 | 组件 | 说明 | v0.8.0 改进 |
|--------|------|------|-------------|
| KPI 面板 | BusinessFlow (顶部) | 利润/库存/应收/应付 | 响应式网格 |
| 单据列表 | RecordList | 采购/销售/物流/收付单 | 触控优化 + 交易对手筛选 |
| 快速录入 | EntryView | 自然语言+表单录入 | 响应式表单行 |
| 主数据管理 | MasterDataPanel | 产品/交易方/项目 CRUD | 响应式 + 触控按钮 |
| 查询 | QueryView | 库存/应收/应付/对账/基础数据 | 手机端卡片化 |
| 报表 | ReportView | 利润/按单号/对账单/月度总览 | 手机端卡片化 |
| 发票表单 | InvoiceForm | 发票录入 | - |
| 采购表单 | PurchaseEventForm | 采购录入 (也用于销售) | 响应式行 + 聚焦光晕 |
| 搜索选择 | SearchSelect | 可搜索下拉选择 | 触控优化 + 动画 |

> 想法: 对账单很喜欢。其他 tab 后期决定去留。

### 7.4 状态管理
`web/src/stores/`
- authStore: 用户认证/空间切换/Agent 选择
- chatStore: 消息列表/WebSocket/流式状态
- bizStore: 全部业务实体 + Dashboard KPI + CRUD 操作
- memoryStore: 记忆列表/搜索
- uiStore: UI 状态 (当前 tab/弹窗)
- moduleStore: 功能开关

> 想法:

---

## 8. 存储层

### 8.1 SQLite 数据库
`src/storage/database.ts`

**核心表:**
- `bubbles` — 记忆气泡 (标题/内容/标签/置信度/抽象层级)
- `bubble_links` — 气泡间关系图 (类型/权重)

**业务表:**
- `biz_products` / `biz_counterparties` / `biz_projects` — 主数据
- `biz_purchases` / `biz_sales` / `biz_logistics` / `biz_payments` / `biz_invoices` — 交易单据
- `biz_doc_links` — 单据间链接

**系统表:**
- `users` / `spaces` / `user_spaces` — 多租户
- `scheduled_tasks` — 定时任务配置

> 想法:

---

## 9. 数据流

### 对话流
```
用户消息 → WebSocket → MessageRouter
  ├─ 反射层: 正则匹配 → 工具调用 → 注入上下文
  └─ 深思层: Brain.think()
       ├─ 加载记忆上下文 (top 20 加权气泡)
       ├─ LLM 流式推理
       ├─ 工具调用检测 → 执行 → 追加回答
       └─ 异步: 提取新记忆 + 惊奇检测
```

### Excel 导入流
```
文件上传 → /api/import-excel
  ├─ Phase 1: 基础信息表 → 知识卡片气泡
  ├─ Phase 2: 交易表 → 自然语言气泡
  ├─ Phase 2.5: 交易表 → biz 结构化记录 (confirmed)
  ├─ Phase 3: 聚合汇总气泡
  ├─ Phase 4: 摘要气泡 + 语义桥接 + 异常检测
  └─ 返回: 气泡统计 + bizBridge 统计
```

### 记忆进化流
```
每日 4:00 — 压缩: 原子记忆 → 综合概念 → 用户画像
每日 6:00 — 反思: 发现规律 → 验证趋势 → 标记过时
持续    — 衰减: 按 decay_rate 降低置信度
```

---

## 10. 修改文件索引 (v0.8.0)

本次 Phase 2+3 共修改 **15 个文件**:

| 波次 | 文件 | 改动要点 |
|------|------|---------|
| Wave 1 | `styles/variables.css` | 新增 spacing/typography/tap/content tokens |
| Wave 1 | `layout/AppShell.module.css` | max-width 768→1200px |
| Wave 1 | `layout/Header.module.css` | sticky + backdrop blur + 响应式 padding |
| Wave 1 | `layout/NavTabs.module.css` | 触控目标 + hover 态 |
| Wave 2 | `biz/PurchaseEventForm.module.css` | 响应式 row + focus glow + active scale |
| Wave 2 | `biz/EntryView.module.css` | 响应式 row + focus glow |
| Wave 2 | `biz/SearchSelect.module.css` | 触控选项 44px + fadeSlideUp 动画 |
| Wave 2 | `biz/BusinessFlow.module.css` | 响应式网格 + detailContent 居中 |
| Wave 3 | `biz/RecordList.module.css` | 全量触控优化 + cpDropdown 动画 |
| Wave 3 | `biz/QueryView.module.css` | 手机端卡片化 (隐藏表头, data-label) |
| Wave 3 | `biz/QueryView.tsx` | 添加 data-label 属性 |
| Wave 3 | `biz/ReportView.module.css` | 手机端卡片化 (table→card) |
| Wave 3 | `biz/ReportView.tsx` | 添加 data-label 属性 |
| Wave 3 | `biz/MasterDataPanel.module.css` | 响应式 formRow + 触控按钮 |
| Wave 4 | `styles/reset.css` | button 过渡 + ::selection 品牌色 |

---

## 改进计划汇总

> 在下方记录你的整体改进思路，每次想到新点子就追加：

- [x] ~~手机端页面溢出~~ — v0.8.0 全站响应式已修复
- [x] ~~录入框布局应该更小巧美观~~ — v0.8.0 focus glow + 响应式行
- [x] ~~交易对手筛选~~ — v0.7.1 可搜索 combobox
- [x] ~~按单号报表~~ — v0.7.0 已实现
- [ ] 业务 tab 精简 — 确定哪些子 tab 保留/移除
- [ ] 对账单增强 — (已满意，可考虑导出 PDF?)
- [ ] 微信小程序迁移 — huaruilong-miniapp 全面重构 (Phase 4, 暂缓)
- [ ] yingyun 用户数据隔离体验优化
- [ ] 中南建设数据缺失 — 需重新上传 Excel
- [ ] _在这里添加更多..._

---

## 用户反馈日志

添加日志：1，思考方向：我们的业务板块是不是可以定义为一个个事件，如果用户需要，这些板块可以被用户用来记录
2，在AI tab界面总体观感没问题，就是对话框左边的照相机Emjoi很突兀，不好看，可以参考苹果的照相图标
3，在记忆tab 可以清晰的看到bubble的工作，它记录了很多，但是有些记忆如果用户不想要是不是可以删除，删除确认时是不是可以询问删除的原因？
4，具体到业务板块，点击进去感觉上面的4个tab很突兀，和下面的tab不协调，我的看法就是全部删除。
 4.1既然我把业务板块所有的功能都是一个个事件的话，采购功能：表头设计没有问题，名称是不是可以改为录入/历史（或者你可以设为更贴切的名称），既然是采购事件，我认为整体的功能逻辑是不是应该为时间，地点，具体内容：供应商选择好了之后是不是可以增加一个单号录入，然后如果我在马台采购了多个规格，是不是可以让我一次性的录入多个规格信息，信息内容应包含品牌、材质、规格、计量单位（多单位下拉选择）、理计/过磅、件数、重量（如果客户选择理计则跳出件数*件重的结果；如果客户选过磅，重量应该让客户手动录入，或者后期补录，或者后期修改）、单价（含税不含税）、小计金额、备注（备注栏可以是每件的只数以方便用户核算理计重量，备注栏也可以手输内容如加工品、含税不含税等）在右下角结尾是显示总金额，然后应有付款栏（已付、未付、欠款等支持用户自定义）然后再到项目，备注，保存按钮。既然增加了这么多的输入框，那么录入页面的布局应该重新优化，说到优化，我在电脑端登录bubble，在电脑屏幕上显示没问题，但是我在手机浏览器登录bubble，发现页面会有溢出，我的手机是IPONE14 Pro。这是采购事件的录入页面设想，同样的设想在销售事件中，物流事件中可以只增加一个单号录入，收付款事件（因为用户选择了采购事件或者销售事件必然就会产生收付款事件，那么我在采购录入时已经在付款栏输入了支付完成，是不是对应的付款记录就会产生一笔，同理在销售事件录入时如果客户及时付款，那么收款是不是也会产生一笔记录）；那么单独的收款款事件是不是可以让用户记录一些费用支出，或者零星的收入呢，具体你可以参考财务类的一些类似SaaS产品
 5，发票这一事件作为单独事件出现，或者作为关联事件出现，我录入一笔进项发票录入，是不是在对应的采购历史里可以关联该批采购已开票，同理我在录入销售发票时，是不是可以提示该客户还有多少发票未开呢
 6，对账查询这个tab，这个功能我觉得你设计的很不好：名称就不对，库存表还行（进销应该支持小数点后3位显示，当然这个是根据客户的产品结构，我们钢贸是小数点后两位），应收应付项目对账这三个是不是不应该出现在这里？基础数据倒是可以，你干脆这把这个tab设计成基础数据维护好了，基础数据应包含产品、用户、供应商、物流商等，项目可以不要（跟客户重复了），所有的基础数据支持用户导入，新增，修改。
 7，报表tab，我没想到报表统计设计的这么好。报表里的利润栏是不是可以支持用户选择具体的用户分用户统计？报表设计的是我最满意的，摘要栏是不是可以以单号为主要的显示，单号在我钢贸的流程中是非常重要的，采购，销售，物流，对账，付款都关联到这一指标，在单号下你可以具体到这一批次的所有要素。当然我是从钢贸行业来说的，你可以参考，月度总览还行吧，因为我现在只有3月的数据，或许你可以提供柱状图，饼状等等
 8，经营概览我觉得没啥意思，不是说没必要，关键你做的这个概览他是不可点击的，所以我不知道你设计的意义在哪里，它只能看，而且还不是那么的精确。
 9，这些具体的意见就是我刚想的，完全是从我个人的角度考虑的，我没有去考虑里面的耦合，里面关联的难度，我是想你基于这些详细的建议做一个统筹规划，我们把这一个个事件做好的话，用户的使用会不会更顺畅，会不会有可能推进商用化。当然这里面我知道很复杂的就是，我的个人观感能不能适配bubble的语义元，bubble能不能理解这些设计，能不能基于这些为用户服务，所以麻烦你了Qoder.（v0.9.0）
 **时间来到了2026-3-30**：1，bubble agent在电脑端的对话界面是没问题的。在手机端是会有对话框重叠，如采购事件中的日期和运货单号显示的时候会有重叠。
 2，在yingyun用户的使用界面，她的功能模块中还是只能选择全部业务管理功能，点开也就是跟示例公司用户一样的界面，这是不是跟我们对单一事件的说明呢？而且yingyun用户里面业务模块里面的数据就是示例公司的，这对一个新用户来说是体验很差的。
 3，采购事件中，物料明细行中，品牌没问题，材质是不是可以命名为产品，然后材质，规格，计量（计量里面的单位我建议设置为下拉选择，不是平铺）在物料明细行中，我的建议是录入框的布局的大小应该更小巧美观。销售事件中的也如上设置。
 4，物流事件中，单号的录入和记录都没有体现
 5，我对基础数据这一事件是意见最多额，项目对账这一tab就应该取消，应收和应付的tab，也是多余，这个不是跟前面的一些事件是重复性的么，还是说你把基础数据当做一个单独事件来进行的设计呢？如果是一单独事件存在的话，你这么设置是可以的。
 6，报表事件中，就我示例公司用户体验来讲，你的按单号tab就没有把我上传的excl理解错了，我的上传表格是有单号的，还是说这个录入没有被bubble读取到？
 7，以上还是对bubble布局的看法，现在就对bubble读取Excel，生成数据统计的看法，我觉得报表事件里的数据好像都不对，因为今天我新上传了新的Excel，是因为跟之前的记忆有重复么？利润这一tab他的统计逻辑就不对的，比如我的原始数据里，中南建设的采购是7633.14元，运费支付330元，销售额是9488.4元，这一tab 就查询不出来。（销售收入、毛利润、毛利率、柱状图、下面的统计明细全部是不对的）
 8，版本v1.0.0
 9，qoder:我们在设计的时候还是一步一步的来吧，全局或者你的专家团模式好像还是会有逻辑、耦合错误.我能理解你不像人类有视觉可以有艺术或者视觉审美，这些眼睛看到的错误我可以告诉你，但是bubble的根基，代码类的bug，还是得靠你一步步的设计改动调试，你知道的我完全不懂这些。
