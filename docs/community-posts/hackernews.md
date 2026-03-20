# Show HN: Bubble Agent OS – Self-hosted AI assistant with brain-inspired hierarchical memory

**Post URL**: Submit to https://news.ycombinator.com/submit

**Title**: Show HN: Bubble Agent OS – Self-hosted AI assistant with brain-inspired hierarchical memory

**URL**: https://github.com/luckincoco/bubble-agent-os

**Text** (if no URL, or as comment):

---

I built an open-source personal AI agent that actually remembers conversations and imported data. Instead of simple RAG, it uses a "three-path fusion" retrieval that combines keyword search, vector similarity, graph traversal, and recency decay — with dynamic weight adjustment based on query intent.

What makes it different from standard RAG:

- **Bubble Compaction Engine**: Inspired by LeCun's H-JEPA, it automatically compresses atomic memories into higher-level concepts using Union-Find clustering + LLM abstraction. 169 scattered Excel records → one insight about the user's financial monitoring anxiety.

- **Surprise Detector**: Passively detects contradictions and anomalies in your data. When new info conflicts with existing knowledge, it creates a high-priority event bubble that surfaces in future queries.

- **Focus Tracker**: Sliding window attention model over recent messages. Boosts memories related to your current conversation topic without manual tagging.

- **Dynamic retrieval weights**: "What's my phone number?" routes 55% to keyword search. "What happened today?" routes 50% to recency. The intent classifier is just heuristic rules — no ML model needed.

Tech stack: TypeScript, SQLite (no Postgres needed), Fastify, React PWA. Supports DeepSeek, OpenAI, or fully offline with Ollama. Single-port deployment.

The theory behind it: https://github.com/luckincoco/bubble-agent-os/blob/main/docs/blog/bubble-memory-theory.md

I'd love feedback on the memory architecture. Is hierarchical compression the right approach for long-term AI memory, or are there simpler solutions I'm missing?
