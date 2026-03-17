# Bubble Agent OS

A personal AI agent with long-term memory, powered by Bubble Theory.

Bubble Agent OS is an open-source AI assistant that **remembers**. Unlike stateless chatbots, it stores and retrieves memories using a three-path fusion algorithm (keyword + vector + graph), enabling contextual conversations that improve over time.

## Features

- **Bubble Memory System** - Information is stored as "Bubbles" with embeddings, tags, relationships, and confidence scores
- **Three-Path Fusion Retrieval** - Combines keyword search (30%), vector similarity (40%), graph traversal (20%), and recency decay (10%) for intelligent memory recall
- **Streaming Chat** - Real-time AI responses via WebSocket
- **Tool Calling** - Extensible tool system (weather, time, and custom tools)
- **Auto Memory Extraction** - Automatically extracts and stores important information from conversations
- **Mobile-First PWA Frontend** - React-based UI with bubble-themed design, installable on mobile devices
- **Single-Port Deployment** - Fastify serves both API and frontend on one port

## Architecture

```
src/
  index.ts              # Entry point (REPL + server modes)
  kernel/brain.ts       # AI reasoning engine with tool calling
  bubble/model.ts       # Bubble data model (CRUD operations)
  bubble/aggregator.ts  # Three-path fusion retrieval
  bubble/links.ts       # Relationship graph between bubbles
  memory/manager.ts     # Memory extraction and retrieval orchestration
  memory/extractor.ts   # Extract memories from conversations
  ai/llm.ts             # LLM provider abstraction
  ai/embeddings.ts      # Text embedding generation
  server/api.ts         # REST API + WebSocket server
  connector/            # Tool registry and built-in tools
  storage/database.ts   # SQLite storage layer
web/
  src/                  # React + Vite PWA frontend
```

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm

### Installation

```bash
git clone https://github.com/luckincoco/bubble-agent-os.git
cd bubble-agent-os
pnpm install
```

### Configuration

Copy the example environment file and add your API key:

```bash
cp .env.example .env
```

Edit `.env` and set your API key:

```env
# DeepSeek (default)
DEEPSEEK_API_KEY=sk-your-key-here

# Or use OpenAI
# OPENAI_API_KEY=sk-your-key-here
# LLM_PROVIDER=openai

# Or use local Ollama
# LLM_PROVIDER=ollama
```

### Build & Run

```bash
# Build everything (backend + frontend)
pnpm build:all

# Start in interactive REPL mode
pnpm start

# Start with web UI (HTTP + WebSocket server on port 3000)
pnpm start --serve
```

Then open http://localhost:3000 in your browser.

### Development

```bash
# Run in dev mode
pnpm dev

# Build frontend only
pnpm build:web

# Type check
pnpm lint

# Run tests
pnpm test
```

## Supported LLM Providers

| Provider | Model | Setup |
|----------|-------|-------|
| DeepSeek | deepseek-chat | Set `DEEPSEEK_API_KEY` |
| OpenAI | gpt-4o-mini | Set `OPENAI_API_KEY`, `LLM_PROVIDER=openai` |
| Ollama | any local model | Set `LLM_PROVIDER=ollama` |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/chat` | Send a chat message |
| GET | `/api/memories` | List stored memories |
| WS | `/ws` | Streaming chat via WebSocket |

## How Bubble Theory Works

Information is stored as **Bubbles** - data points with:
- **Content** - The actual text/information
- **Embedding** - Vector representation for semantic search
- **Tags** - Categorical labels
- **Links** - Relationships to other bubbles (graph structure)
- **Confidence** - How reliable/important this information is
- **Access tracking** - Recency decay for relevance scoring

When you ask a question, the **Aggregator** searches across three paths simultaneously:
1. **Keyword search** - Traditional text matching
2. **Vector similarity** - Semantic meaning comparison
3. **Graph traversal** - Following relationship links

Results are fused with weighted scoring to surface the most relevant memories as context for the AI's response.

## License

MIT
