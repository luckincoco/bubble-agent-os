# Bubble Agent OS — Claude Code 项目指南

## 项目概述
Bubble Agent OS 是一个认知架构系统，核心概念是"泡泡理论"——信息以泡泡（Bubble）的形式聚类、压缩、演化。

## 协作模式：与 qoder 的 Handoff Protocol

### 分工

| 角色 | 职责 |
|------|------|
| **Claude Code** | 架构设计、写代码、本地 `pnpm build && pnpm test` 自检、写 handoff 文件、分析错误日志 |
| **qoder** | 审查代码、执行 git/rsync/ssh/pm2 命令、写 result 文件、IDE 操作 |
| **春雨** | 一句话触发任务、做决策 |

### 工作流

1. Claude Code 写代码 → 本地 build + test 自检
2. 自检通过 → 写 `.claude/handoff/active.md`
3. 春雨告诉 qoder："处理 handoff"
4. qoder 读 active.md → 执行命令 → 写 `.claude/handoff/result.md`
5. 成功则归档到 `.claude/handoff/archive/`，失败则 Claude Code 读 result.md 修复

### Claude Code 的约束
- 写代码后必须执行 `pnpm build && pnpm test` 确认通过
- 不执行 git commit / rsync / ssh / pm2（这些是 qoder 的职责）
- handoff 文件用 handoff-id 命名，包含变更摘要和完整命令

### 轻量交互
qoder 可以直接 `claude --print` 调用 Claude CLI 处理错误分析、diff 审查、架构讨论——无需走完整 handoff 流程。
