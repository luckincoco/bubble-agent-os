# Reddit Posts

## r/selfhosted

**Title**: [Project] Bubble Agent OS — Self-hosted AI assistant with long-term memory, Excel analysis, and Feishu integration

**Body**:

---

I've been working on a self-hosted AI assistant that remembers everything — conversations, imported spreadsheets, documents. It's called **Bubble Agent OS**.

**What it does:**
- Stores information as "bubbles" with embeddings, tags, and relationship links
- Retrieves memories using 4-path fusion: keyword + vector + graph + time decay
- Automatically detects anomalies in your data (no explicit queries needed)
- Imports and analyzes Excel files with cross-table analysis
- Compresses atomic facts into high-level user understanding over time

**Self-hosting highlights:**
- Single binary, single port (API + WebSocket + frontend on :3000)
- SQLite only — no Postgres, no Redis, no external dependencies
- Supports **Ollama** for fully offline operation — zero data leaves your server
- Mobile-first PWA — install it on your phone
- ~5000 lines of TypeScript, no bloat

**LLM Support:** DeepSeek (cheap), OpenAI, or local Ollama

**Quick start:**
```bash
git clone https://github.com/luckincoco/bubble-agent-os.git
cd bubble-agent-os && pnpm install
cp .env.example .env  # add your API key
pnpm build:all && pnpm start --serve
```

GitHub: https://github.com/luckincoco/bubble-agent-os

Would love to hear your thoughts. What features would make this more useful for your self-hosted setup?

---

## r/LocalLLaMA

**Title**: Bubble Agent OS — Open-source AI agent with long-term memory, works great with Ollama

**Body**:

---

Built an AI assistant that actually has persistent memory across conversations. It works with **Ollama** out of the box — set `LLM_PROVIDER=ollama` in `.env` and you're running fully local.

The memory system is the interesting part:
- Every piece of info becomes a "bubble" with vector embeddings and graph links
- Retrieval uses 4 parallel paths (keyword, vector, graph, recency) fused with dynamic weights
- A "Compaction Engine" periodically compresses atomic memories into higher-level concepts
- A "Surprise Detector" passively flags contradictions and anomalies

All data stays in local SQLite. No cloud calls except to the LLM (and even that's local with Ollama).

GitHub: https://github.com/luckincoco/bubble-agent-os

Technical deep-dive on the memory theory: https://github.com/luckincoco/bubble-agent-os/blob/main/docs/blog/bubble-memory-theory.md
