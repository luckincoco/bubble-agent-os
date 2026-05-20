# ADR-002: Module Lifecycle & Architecture Hygiene

**Status:** Accepted · **Date:** 2026-05-20  
**Context:** P2-a grep audit identified feature branch modules vs. main's surface area.

## Decision

1. **Module introduction** follows a two-phase gate: (a) code merged behind a feature flag or as dead code, (b) wired into index.ts / scheduler / router before the feature branch merges to main. No module exists on `main` unwired.

2. **Module deprecation** removes the file and all imports in the same commit. Dead-code graveyards are not kept.

3. **ADR coverage** is required for any new module that crosses 300 lines or introduces a new architectural concept. Existing modules above 300 lines without ADRs are grandfathered.

4. **Complexity budget** — files exceeding 1000 lines trigger a review. Two files currently exceed this:
   - `src/server/api.ts` (1937 lines) — P2-b target for route/handler split
   - `src/connector/biz/structured-store.ts` (1707 lines) — consider domain split

## Module Map (main branch)

| Layer | Key Modules | Lines | Status |
|-------|------------|-------|--------|
| Kernel | brain, tool-loop, prompts | ~500 | ✅ Active |
| Memory | manager, extractor, focus-tracker, compactor, working-memory, context-budget, reflector | ~2500 | ✅ Active |
| Storage | database, bubble/model, bubble/links, bubble/aggregator | ~2000 | ✅ Active |
| Connector | registry, router, tools/, biz/, skills/ | ~6000 | ✅ Active |
| Temporal | episode-store, temporal-linker, temporal-query, entity-extractor | ~800 | ✅ Active |
| Event | event-bus, event-store, materializer | ~600 | ✅ Active |
| Scheduler | scheduler + 15 task modules | ~3000 | ✅ Active |
| API | api.ts, knowledge-routes | ~2200 | ⚠️ api.ts over threshold |

## Feature Branch Modules (pending merge)

All 8 modules from the feature branch are candidates for cleanup or wiring:
- 6/8 already wired (observation-recorder, tracer, concept-forge, obsidian-ingest, task-ledger, resonance)
- 2/8 (draft-observations, workflow) remain unwired even in branch — decide: implement or delete

**Decision:** The feature branch should either wire `draft-observations` and `workflow` into the active code paths, or delete them before merging to main.
