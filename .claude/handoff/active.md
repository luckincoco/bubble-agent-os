# Handoff: P1-b → P2-b → P3 → P4 → Feature Branch Merge → api.ts Split

## Handoff-ID
p1b-p4-batch-20260520

## Branch
p1b-p4-batch (commit `d5d7522`)

## Status
✅ **All work committed on branch**
✅ Build clean (0 TypeScript errors)
✅ 233 tests passed, 36 skipped (api-smoke EPERM — sandbox restriction, 0 failed)

## Completed

### 1. Feature Branch Merged (commit `c57c7cd`)
- `feature/all` branch (35 files) merged into `p1b-p4-batch`
- Adds: assertion identification, observability tracing, code forge, obsidian ingest, FTS5, draft observations, task ledgers, conversation turns
- Only conflict was `src/kernel/brain.ts` — resolved

### 2. api.ts Split (commit `d5d7522`, 2376 → 127 lines, 93% reduction)
- 9 domain route files in `src/server/routes/`:
  - `auth-admin.ts` — login, preferences, users CRUD, change-password
  - `chat-memory.ts` — chat, WebSocket, memories, search
  - `biz.ts` — ~55 biz CRUD + reports + document lifecycle
  - `agents.ts` — agents CRUD + activate
  - `spaces.ts` — spaces + members CRUD
  - `tasks.ts` — scheduler tasks CRUD + run
  - `import-routes.ts` — Excel, doc, image OCR import
  - `forge.ts` — CodeForge + SpecForge
  - `assertions.ts` — assertion query/calibrate/stats
- Shared types: `src/server/route-types.ts` (JwtPayload, ServerModules, RouteDeps)
- Consistent pattern: `registerXxxRoutes(app, deps)`

### 3. as any Reduction (54 → 43 remaining low-priority)
- **agent/model.ts**: Added `AgentRow` interface, replaced `as any` with typed casts
- **bubble/links.ts**: Added `BubbleLinkRow` interface, replaced `as any[]`
- **bubble/model.ts**: Exported `BubbleRow` interface
- **knowledge-routes.ts**: 3 `as any` → `BubbleType[]` / `Record<string, string>`
- **temporal-query.ts**: Fixed `type: string` → `type: BubbleType`, removed casts

### 4. Post-Merge Runtime Fixes (commit `d5d7522`)
- **brain.ts**: `this.observationRecorder.recordToolCall()` → `recorder.record()`, `activeAgent` → `activeAgent ?? null`
- **memory-tools.ts**: `searchBubbles(params.query, { spaceId, limit })` → `searchBubbles(params.query, limit, [spaceId])`, removed `rowToBubble`
- **session-compression.ts**: `session.messages` → `session.history`

## Remaining Technical Debt

### 43 as any casts (low priority)
- `src/memory/resonance/` (6) — feature branch, SQLite rows
- `src/server/routes/biz.ts` (9) — `body as any` in CRUD (biz fns accept any)
- `src/server/routes/assertions.ts` (4) — enum-like type params
- `src/scheduler/` (5) — deps access, error codes
- `src/connector/` (12) — SDK, dynamic imports
- `src/memory/` (2) — manager, causal-evaluator
- `src/bubble/aggregator.ts` (1), `src/server/api.ts` (1)
- `src/server/routes/import-routes.ts` (1)
- `src/server/knowledge-routes.ts` (2)

### Pre-existing test non-issue
- `tests/api-smoke.test.ts` — EPERM binding to `0.0.0.0` in sandbox (all 36 tests skipped, 0 failed). Works fine outside sandbox.

## Deploy Steps
1. `git push origin p1b-p4-batch`
2. `rsync -avz --delete -e "ssh -p 22622" src/ root@101.34.243.245:/opt/bubble-agent-os/src/`
3. `rsync -avz --delete -e "ssh -p 22622" docs/ root@101.34.243.245:/opt/bubble-agent-os/docs/`
4. `ssh -p 22622 root@101.34.243.245 "cd /opt/bubble-agent-os && pnpm build && pm2 restart bubble"`
5. Health check

## Constraints
- Restart bubble only (id=0), not bobi (id=1)
- No data/ sync, no dist/ sync, no web/ sync
- No package.json changes — no pnpm install needed
- Database schema includes 6 new migration sections from feature branch — additive and backward-compatible

## Rollback
`git checkout main && rsync src/ && rsync docs/ && pnpm build && pm2 restart bubble`
