#!/bin/bash
# gen-module-state.sh — 部署后自动生成模块状态锚点文件
#
# 运行环境: 服务器上（/opt/bubble-agent-os/）
# 输出位置: /root/.bubble-agent/obsidian-ingest/_system/module-state.md
# 用途: 让 Bubble 始终拥有"当前系统真实状态"的权威参考
#
# 使用方式:
#   直接运行: bash /opt/bubble-agent-os/scripts/gen-module-state.sh
#   部署后自动运行: 集成在 bubble-bingbu 部署流程 Step 4

set -euo pipefail

# ── 配置 ──
PROJECT_DIR="/opt/bubble-agent-os"
SRC_DIR="$PROJECT_DIR/src"
DB_PATH="/root/.bubble-agent/data/bubble.db"
OUTPUT_DIR="/root/.bubble-agent/obsidian-ingest/_system"
OUTPUT_FILE="$OUTPUT_DIR/module-state.md"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$OUTPUT_DIR"

# ── 辅助函数 ──
check_dir() {
  if [ -d "$1" ]; then echo "exists"; else echo "missing"; fi
}

check_file() {
  if [ -f "$1" ]; then echo "exists"; else echo "missing"; fi
}

db_table_exists() {
  local count
  count=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$1';" 2>/dev/null || echo "0")
  echo "$count"
}

db_row_count() {
  sqlite3 "$DB_PATH" "SELECT count(*) FROM $1;" 2>/dev/null || echo "0"
}

pm2_status() {
  local name="$1"
  local result
  result=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try:
  data=json.load(sys.stdin)
  for p in data:
    if p['name']=='$name':
      print(p['pm2_env']['status']); sys.exit(0)
  print('not_found')
except: print('error')
" 2>/dev/null | head -1)
  echo "${result:-unknown}"
}

# ── 收集数据 ──

# 1. 核心模块目录
KERNEL_STATUS=$(check_dir "$SRC_DIR/kernel")
MEMORY_STATUS=$(check_dir "$SRC_DIR/memory")
EVENT_STATUS=$(check_dir "$SRC_DIR/event")
SCHEDULER_STATUS=$(check_dir "$SRC_DIR/scheduler")
COGNITION_STATUS=$(check_dir "$SRC_DIR/cognition")
CONNECTOR_STATUS=$(check_dir "$SRC_DIR/connector")
AGENT_STATUS=$(check_dir "$SRC_DIR/agent")
WORKFLOW_STATUS=$(check_dir "$SRC_DIR/workflow")

# 2. 关键子模块文件
BRAIN_STATUS=$(check_file "$SRC_DIR/kernel/brain.ts")
RESONANCE_DIR=$(check_dir "$SRC_DIR/memory/resonance")
RESONANCE_TRACKER=$(check_file "$SRC_DIR/memory/resonance/resonance-tracker.ts")
RESONANCE_INTEGRATION=$(check_file "$SRC_DIR/memory/resonance/resonance-integration.ts")
METRICS_COLLECTOR=$(check_file "$SRC_DIR/memory/resonance/metrics-collector.ts")
CAUSAL_EVAL=$(check_file "$SRC_DIR/memory/causal-evaluator.ts")
SEMANTIC_BRIDGE=$(check_file "$SRC_DIR/memory/semantic-bridge.ts")
SURPRISE_DETECTOR=$(check_file "$SRC_DIR/memory/surprise-detector.ts")
FOCUS_TRACKER=$(check_file "$SRC_DIR/memory/focus-tracker.ts")
EVIDENCE_CHAIN=$(check_file "$SRC_DIR/memory/evidence-chain.ts")
OBSERVATION_RECORDER=$(check_file "$SRC_DIR/memory/observation-recorder.ts")
COMPACTOR=$(check_file "$SRC_DIR/memory/compactor.ts")
EVENT_BUS=$(check_file "$SRC_DIR/event/event-bus.ts")

# 3. DB 表状态
ACTIVATION_PATHS_EXISTS=$(db_table_exists "activation_paths")
EMISSION_LOG_EXISTS=$(db_table_exists "emission_log")
CONVERSATION_SIGNALS_EXISTS=$(db_table_exists "conversation_signals")
BUBBLES_EXISTS=$(db_table_exists "bubbles")
SPACES_EXISTS=$(db_table_exists "spaces")
EVAL_RESULTS_EXISTS=$(db_table_exists "eval_results")

# 4. 关键表行数
if [ "$ACTIVATION_PATHS_EXISTS" = "1" ]; then
  ACTIVATION_PATHS_COUNT=$(db_row_count "activation_paths")
else
  ACTIVATION_PATHS_COUNT="N/A"
fi

if [ "$EMISSION_LOG_EXISTS" = "1" ]; then
  EMISSION_LOG_COUNT=$(db_row_count "emission_log")
else
  EMISSION_LOG_COUNT="N/A"
fi

if [ "$CONVERSATION_SIGNALS_EXISTS" = "1" ]; then
  SIGNALS_COUNT=$(db_row_count "conversation_signals")
else
  SIGNALS_COUNT="N/A"
fi

if [ "$BUBBLES_EXISTS" = "1" ]; then
  BUBBLES_COUNT=$(db_row_count "bubbles")
else
  BUBBLES_COUNT="N/A"
fi

# 5. PM2 状态
BUBBLE_PM2=$(pm2_status "bubble")
BOBI_PM2=$(pm2_status "bobi")

# 6. 最后一次部署信息（从 dist/ 的修改时间推断）
LAST_BUILD=""
if [ -d "$PROJECT_DIR/dist" ]; then
  LAST_BUILD=$(stat -c '%y' "$PROJECT_DIR/dist" 2>/dev/null | cut -d'.' -f1)
fi

# ── 生成 Markdown ──
cat > "$OUTPUT_FILE" << EOF
---
bubble: true
type: system-anchor
auto_generated: true
priority: high
---

# Bubble Agent OS — 模块运行状态锚点

> **此文件由部署流程自动生成，反映系统的真实运行状态。**
> 当你需要判断"某模块是否已实施/是否在线"时，以此文件为准。

最后更新: $TIMESTAMP
最后构建: ${LAST_BUILD:-未知}

---

## PM2 进程状态

| 进程 | 状态 |
|------|------|
| bubble | $BUBBLE_PM2 |
| bobi | $BOBI_PM2 |

---

## 核心模块目录

| 模块 | 路径 | 状态 |
|------|------|------|
| Kernel | src/kernel/ | $KERNEL_STATUS |
| Memory | src/memory/ | $MEMORY_STATUS |
| Event | src/event/ | $EVENT_STATUS |
| Scheduler | src/scheduler/ | $SCHEDULER_STATUS |
| Cognition | src/cognition/ | $COGNITION_STATUS |
| Connector | src/connector/ | $CONNECTOR_STATUS |
| Agent | src/agent/ | $AGENT_STATUS |
| Workflow | src/workflow/ | $WORKFLOW_STATUS |

---

## 关键子模块文件

| 模块 | 文件 | 状态 |
|------|------|------|
| Brain (LLM核心) | kernel/brain.ts | $BRAIN_STATUS |
| EventBus | event/event-bus.ts | $EVENT_BUS |
| ObservationRecorder | memory/observation-recorder.ts | $OBSERVATION_RECORDER |
| Compactor (压实) | memory/compactor.ts | $COMPACTOR |
| **共振层目录** | memory/resonance/ | $RESONANCE_DIR |
| ResonanceTracker | memory/resonance/resonance-tracker.ts | $RESONANCE_TRACKER |
| ResonanceIntegration | memory/resonance/resonance-integration.ts | $RESONANCE_INTEGRATION |
| MetricsCollector | memory/resonance/metrics-collector.ts | $METRICS_COLLECTOR |
| CausalEvaluator | memory/causal-evaluator.ts | $CAUSAL_EVAL |
| SemanticBridge | memory/semantic-bridge.ts | $SEMANTIC_BRIDGE |
| SurpriseDetector | memory/surprise-detector.ts | $SURPRISE_DETECTOR |
| FocusTracker | memory/focus-tracker.ts | $FOCUS_TRACKER |
| EvidenceChain | memory/evidence-chain.ts | $EVIDENCE_CHAIN |

---

## 数据库表状态

| 表名 | 存在 | 行数 |
|------|------|------|
| activation_paths | $([ "$ACTIVATION_PATHS_EXISTS" = "1" ] && echo "Y" || echo "N") | $ACTIVATION_PATHS_COUNT |
| emission_log | $([ "$EMISSION_LOG_EXISTS" = "1" ] && echo "Y" || echo "N") | $EMISSION_LOG_COUNT |
| conversation_signals | $([ "$CONVERSATION_SIGNALS_EXISTS" = "1" ] && echo "Y" || echo "N") | $SIGNALS_COUNT |
| bubbles | $([ "$BUBBLES_EXISTS" = "1" ] && echo "Y" || echo "N") | $BUBBLES_COUNT |
| spaces | $([ "$SPACES_EXISTS" = "1" ] && echo "Y" || echo "N") | $([ "$SPACES_EXISTS" = "1" ] && db_row_count "spaces" || echo "N/A") |
| eval_results | $([ "$EVAL_RESULTS_EXISTS" = "1" ] && echo "Y" || echo "N") | $([ "$EVAL_RESULTS_EXISTS" = "1" ] && db_row_count "eval_results" || echo "N/A") |

---

## 模块实施状态总结

以下是基于源码文件和数据库表的综合判断：

EOF

# 动态生成总结
{
  # 共振层
  if [ "$RESONANCE_DIR" = "exists" ] && [ "$ACTIVATION_PATHS_EXISTS" = "1" ]; then
    echo "- **共振层 (Resonance)**: 已实施且运行中（代码存在 + DB 表活跃，$ACTIVATION_PATHS_COUNT 条激活路径，$SIGNALS_COUNT 条对话信号）"
  elif [ "$RESONANCE_DIR" = "exists" ]; then
    echo "- **共振层 (Resonance)**: 代码存在但 DB 表未创建（可能未初始化）"
  else
    echo "- **共振层 (Resonance)**: 未实施（代码目录不存在）"
  fi

  # 因果评估
  if [ "$CAUSAL_EVAL" = "exists" ] && [ "$EVAL_RESULTS_EXISTS" = "1" ]; then
    echo "- **因果评估器 (CausalEval)**: 已实施且运行中"
  elif [ "$CAUSAL_EVAL" = "exists" ]; then
    echo "- **因果评估器 (CausalEval)**: 代码存在，DB 表未确认"
  else
    echo "- **因果评估器 (CausalEval)**: 未实施"
  fi

  # 语义桥
  if [ "$SEMANTIC_BRIDGE" = "exists" ]; then
    echo "- **语义桥 (SemanticBridge)**: 已实施"
  else
    echo "- **语义桥 (SemanticBridge)**: 未实施"
  fi

  # 惊讶检测
  if [ "$SURPRISE_DETECTOR" = "exists" ]; then
    echo "- **惊讶检测 (SurpriseDetector)**: 已实施"
  else
    echo "- **惊讶检测 (SurpriseDetector)**: 未实施"
  fi

  # 集中度追踪
  if [ "$FOCUS_TRACKER" = "exists" ]; then
    echo "- **集中度追踪 (FocusTracker)**: 已实施"
  else
    echo "- **集中度追踪 (FocusTracker)**: 未实施"
  fi

  # 证据链
  if [ "$EVIDENCE_CHAIN" = "exists" ]; then
    echo "- **证据链 (EvidenceChain)**: 已实施"
  else
    echo "- **证据链 (EvidenceChain)**: 未实施"
  fi

  # Event Gate (检查是否有相关文件)
  if [ -f "$SRC_DIR/event/event-gate.ts" ] || [ -d "$SRC_DIR/event/gate" ]; then
    echo "- **Event Gate**: 已实施"
  else
    echo "- **Event Gate**: 未实施（仅有设计文档）"
  fi

  echo ""
  echo "---"
  echo ""
  echo "## 使用说明"
  echo ""
  echo "Bubble 在输出任何关于\"模块是否存在/是否已实施\"的判断时，必须参照本文件。"
  echo "如果本文件说某模块 exists 且有数据，则该模块已实施且运行中。"
  echo "如果本文件说 missing，则该模块确实不存在。"
  echo ""
  echo "**不要基于历史笔记推测系统当前状态，以本锚点为准。**"
  echo ""
  echo "---"
  echo "*自动生成于: $TIMESTAMP*"
  echo "*生成方式: scripts/gen-module-state.sh (部署后自动执行)*"
} >> "$OUTPUT_FILE"

echo "[gen-module-state] 锚点文件已生成: $OUTPUT_FILE"
echo "[gen-module-state] 时间: $TIMESTAMP"
