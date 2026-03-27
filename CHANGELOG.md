# Changelog

## [0.3.0] - 2026-03-27

### Added
- **可插拔技能系统** (`connector/skills/`): SKILL.md 配置化技能定义 + SkillLoader 解析器 + SkillRouter 分发路由
- **业务录入技能** (`connector/biz/`): 钢贸进销存自然语言录入，含品类检测器(螺纹钢/线材/盘螺/板材/管材)、LLM 结构化解析、确认流程
- **教学技能** (`connector/teach/`): "泡泡记住/忘记" 自然语言教学，支持记忆创建、更新、遗忘，含冲突检测与解决
- **Excel 语义翻译层** (`connector/tools/excel-translator.ts`): 自然语言 → SQL 翻译，支持查询/聚合/交叉分析
- **反思引擎** (`memory/reflector.ts`): observation 泡泡类型 + discover/validate/suggest 闭环
- **用户管理 API**: Admin CRUD 6 端点 (POST/GET/PUT/DELETE /api/users)，含空间自动创建、角色管理、密码重置
- **AGENTS.md**: 开发指南，含架构速查、文件索引、构建命令、开发规范
- **数据迁移脚本** (`scripts/`): Excel → API 批量导入工具 (TypeScript/Python/ESM 三种实现)

### Changed
- **三层路由增强**: MessageRouter 集成 SkillRouter，支持 Skill 优先级短路
- **记忆检索增强**: aggregator 4-Path Fusion 优化，两阶段检索 (summary → full content)
- **Brain 增强**: 支持工具调用结果注入、技能上下文传递
- **前端**: NavTabs 组件重构，新增业务录入 UI 组件
- **数据库 schema**: 新增 biz_* 结构化业务表

### Security
- **脱敏处理**: 所有脚本/文档中的 API Key、服务器 IP、SSH 凭证已移除，改为环境变量读取

## [0.2.1] - 2026-03-20

### Fixed
- **用户记忆隔离**：修复多用户共享同一空间导致记忆互相可见的问题，每个用户现在拥有独立的个人空间
- **孤儿 bubble 归属**：修复 Excel 导入等场景下 `space_id` 为空字符串的 bubble 无法被任何用户看到的问题

### Changed
- **用户初始化**：新用户不再共享"个人"空间，改为自动创建以用户名命名的专属空间
- **自动修复迁移**：启动时自动检测没有空间的用户并创建专属空间，自动将孤儿 bubble 归入已有空间

## [0.2.0] - 2026-03-20

### Added
- **企业微信连接器** (`connector/wecom.ts`)：支持企业微信消息收发，包括 @提及过滤、XML 消息解析、加密回调验证
- **网页抓取工具** (`tools/fetch-page.ts`)：通用网页内容抓取，自动去除 HTML 标签、提取纯文本，适用于价格行情页等
- **钢材价格定时任务** (`scheduler/tasks/steel-price.ts`)：每日工作日 9:30 自动抓取西本新干线上海钢材报价，存入 bubble 并推送飞书通知
- **飞书图片 OCR**：支持接收飞书图片消息，通过腾讯云 OCR 识别文字，由 Brain 整理后回复
- **搜索意图检测**：飞书/企微消息自动检测搜索意图，钢材关键词走西本新干线，其他走 Tavily 网络搜索
- **环境变量配置项**：`.env.example` 新增 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TAVILY_API_KEY` 说明

### Fixed
- **环境变量同步**：修复 `.env` 文件解析后未同步到 `process.env` 的问题，导致 `web-search` 等工具无法读取 API Key
- **OCR 文本截断**：OCR 识别结果超过 3000 字时自动截断，防止 Brain 处理超时

### Changed
- **工具描述增强**：工具注册描述中增加实时数据搜索的强制规则提示
- **飞书消息处理**：从仅支持文本扩展为支持文本 + 图片，其他类型给出友好提示

## [0.1.0] - 2026-03-17

### Added
- 核心架构：Brain 思考引擎 + Bubble 记忆模型 + Memory Manager
- LLM 集成：支持 DeepSeek / OpenAI / Ollama 三种 provider
- 飞书连接器：WebSocket 长连接，支持私聊和群聊 @提及
- 工具系统：天气查询、时间查询、Excel 语义分析（查询/导出/清洗/交叉分析）、Web 搜索、文档导入
- 定时任务：每日摘要、关键词监控、记忆衰减
- Bubble Compaction Engine：分层记忆压缩
- 多用户认证：JWT + bcrypt，角色权限控制
- 事件驱动模块：SemanticBridge、SurpriseDetector、FocusTracker
- Web UI：Vue 3 前端管理面板
- 安全机制：pre-commit 密钥检测、lint-staged
