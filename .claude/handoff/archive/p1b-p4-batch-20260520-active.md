# Handoff: P1-b → P2-b → P3 → P4 → Feature Branch Merge → api.ts Split

## Handoff-ID
p1b-p4-batch-20260520

## Branch
p1b-p4-batch

## Status
✅ Build clean (0 TypeScript errors)
✅ 233 tests passed, 36 skipped (pre-existing api-smoke EPERM + excel-translator date serial)

## Completed

### 1. Feature Branch Merged
- `feature/all` branch (35 files) merged into `p1b-p4-batch`
- Adds: assertion identification, observability tracing, code forge, obsidian ingest, FTS5, draft observations, task ledgers, conversation turns
- Only conflict was `src/kernel/brain.ts` — resolved

### 2. api.ts Split (93% reduction: 2377 → 166 lines)
- 9 domain route files in `src/server/routes/`
- Shared types: `src/server/route-types.ts` (JwtPayload, ServerModules, RouteDeps)
- Pattern: `registerXxxRoutes(app, deps)`

### 3. Build Errors Fixed (7 post-merge TS errors)
- brain.ts, memory-tools.ts, session-compression.ts, temporal-query.ts

### 4. Partial as any Reduction (54 → 43)
- Fixed: agent/model.ts (AgentRow), bubble/links.ts (BubbleLinkRow), knowledge-routes.ts, api.ts

## Remaining Technical Debt

### 43 as any casts (lower priority)
- `src/memory/resonance/` (6) — feature branch, SQLite rows
- `src/server/routes/biz.ts` (9) — `body as any` in CRUD (biz fns accept any)
- `src/server/routes/assertions.ts` (4) — enum-like type params
- `src/scheduler/` (5) — deps access, error codes
- `src/connector/` (12) — SDK, dynamic imports
- `src/memory/` (2) — manager, causal-evaluator
- `src/bubble/aggregator.ts` (1), `src/server/api.ts` (1)
- `src/server/routes/import-routes.ts` (1)

### Pre-existing test failures
- `tests/api-smoke.test.ts` — EPERM in sandbox (all 36 tests skipped)
- `tests/excel-translator.test.ts` — date serial off by 1

## Deploy Steps
1. `git push origin p1b-p4-batch`
2. Rsync src/ to server
3. Rsync docs/ to server
4. Remote: `pnpm build && pm2 restart bubble`
5. Health check

## Constraints
- Restart bubble only (id=0), not bobi (id=1)
- No data/ sync, no dist/ sync, no web/ sync
- No package.json changes — no pnpm install needed
- Database schema includes 6 new migration sections from feature branch (FTS5, observability, task_ledgers, draft_observations, conversation_turns, focus_messages) — these are additive and backward-compatible

## Rollback
`git checkout main && rsync src/ && rsync docs/ && pnpm build && pm2 restart bubble`
