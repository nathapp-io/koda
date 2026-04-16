# Koda Memory Architecture — Phase Roadmap Overview

**Project:** Koda  
**Parent:** `memory/20260416-plan-koda-memory-gap-analysis-v2.md`  
**Phases:** 6 (SPEC-000 → SPEC-005)  
**Total stories:** 29 | **Total ACs:** ~185

---

## Phase Dependency Graph

```
SPEC-000 (Guardrails)
    ├── US-001 project ID enforcement           ← no deps
    ├── US-002 KodaDomainWriter write gate      ← US-001
    ├── US-003 provenance on responses          ← US-001
    └── US-004 outbox skeleton                  ← US-002

SPEC-001 (Canonical + Episodic)
    ├── US-001 event tables schema              ← SPEC-000/US-001
    ├── US-002 event write ops + auth           ← US-001 + SPEC-000/US-002
    ├── US-003 outbox enqueue + process         ← US-002 + SPEC-000/US-004
    ├── US-004 timeline API                      ← US-001
    ├── US-005 temporal context                 ← US-004
    ├── US-006 fan-out registry wiring          ← US-003 + SPEC-002/US-001 + SPEC-002/US-002 + SPEC-003/US-001 + SPEC-004/US-001
    └── US-007 OutboxEvent table migration      ← US-001

SPEC-002 (Hybrid Retrieval)
    ├── US-001 hybrid retriever skeleton + auth ← no deps
    ├── US-002 BM25 lexical index + warmup      ← US-001
    ├── US-003 entity store + scoring            ← US-001
    ├── US-004 intent-weighted fusion + rerank   ← US-001, US-002, US-003
    ├── US-005 evaluation harness                ← US-004
    └── US-006 graphifyEnabled retrieval guard   ← US-001

SPEC-003 (Semantic Memory)
    ├── US-001 memory item schema + auth        ← SPEC-001/US-001
    ├── US-002 rule-based extraction             ← US-001 + SPEC-001/US-006
    ├── US-003 memory retrieval API              ← US-001
    ├── US-004 governance jobs                    ← US-001, US-002
    └── US-005 memory in getProjectContext       ← US-003

SPEC-004 (Graph + Code Intelligence)
    ├── US-001 incremental graph diff + schema   ← SPEC-000/US-002, SPEC-002/US-001
    ├── US-002 AST/symbol index pipeline         ← US-001
    ├── US-003 entity graph builder              ← SPEC-002/US-003
    ├── US-004 VCS webhook → code_commit         ← US-001, US-002
    └── US-005 getChangeImpact API               ← US-001, US-002, US-003

SPEC-005 (Multi-Agent Consistency)
    ├── US-001 ContextBuilderService + errors    ← SPEC-001/US-005, SPEC-002/US-001, SPEC-003/US-005, SPEC-004/US-001
    ├── US-002 policy gates (incl. GraphifyGate) ← SPEC-000/US-002, SPEC-000/US-003, SPEC-002/US-006
    ├── US-003 agent adapter registry            ← US-001
    ├── US-004 SLO dashboard + token budgets     ← US-001
    └── US-005 CI pipeline integration            ← US-002, US-004
```

---

## Story Size Summary

| Spec | Phase | Stories | Size Range | Estimated Effort |
|------|-------|---------|------------|-----------------|
| SPEC-000 | Phase 0 — Guardrails | 4 | Simple → Complex | Medium |
| SPEC-001 | Phase 1 — Canonical + Episodic | 7 | Simple → Complex | Medium |
| SPEC-002 | Phase 2 — Hybrid Retrieval | 6 | Medium → Complex | High |
| SPEC-003 | Phase 3 — Semantic Memory | 5 | Medium → Complex | Medium |
| SPEC-004 | Phase 4 — Graph + Code Intel | 5 | Medium → Complex | High |
| SPEC-005 | Phase 5 — Multi-Agent Hardening | 5 | Simple → Complex | Medium |

**Total: 32 stories across 6 specs**

---

## Key Files to Create/Modify (Summary)

### New Files
- `apps/api/src/memory/domain-writer.service.ts` (SPEC-000)
- `apps/api/src/memory/outbox.service.ts` (SPEC-000)
- `apps/api/src/memory/outbox-fan-out.ts` (SPEC-001/US-006)
- `apps/api/src/memory/timeline.service.ts` (SPEC-001)
- `apps/api/src/memory/canonical-state.service.ts` (SPEC-004 §6)
- `apps/api/src/memory/extraction.service.ts` (SPEC-003)
- `apps/api/src/memory/governance.service.ts` (SPEC-003)
- `apps/api/src/memory/memory.service.ts` (SPEC-003)
- `apps/api/src/retrieval/hybrid-retriever.service.ts` (SPEC-002)
- `apps/api/src/retrieval/lexical-index.service.ts` (SPEC-002)
- `apps/api/src/retrieval/entity-store.service.ts` (SPEC-002)
- `apps/api/src/retrieval/evaluation.service.ts` (SPEC-002)
- `apps/api/src/graph/incremental-graph-diff.service.ts` (SPEC-004)
- `apps/api/src/graph/entity-graph.service.ts` (SPEC-004)
- `apps/api/src/codeintel/ast-index.service.ts` (SPEC-004)
- `apps/api/src/codeintel/impact-analysis.service.ts` (SPEC-004)
- `apps/api/src/vcs/vcs-webhook.controller.ts` (SPEC-004/US-005)
- `apps/api/src/context/context-builder.service.ts` (SPEC-005)
- `apps/api/src/policy/policy-gate.service.ts` (SPEC-005)
- `apps/api/src/agents/agent-registry.service.ts` (SPEC-005)
- `apps/api/src/monitoring/slo-dashboard.service.ts` (SPEC-005)
- `apps/api/src/common/errors.ts` (SPEC-001 §5)
- `apps/api/src/auth/auth.types.ts` (SPEC-001 §5)

### Schema Changes
- `apps/api/prisma/schema.prisma` — new models across phases:
  - Phase 1: `TicketEvent`, `AgentEvent`, `DecisionEvent`, `OutboxEvent`
  - Phase 3: `MemoryItem`
  - Phase 4: `GraphNode`, `GraphLink`, `Symbol`

---

## Quick-Start Recommendation

If running nax on this roadmap, start with **SPEC-000** (Phase 0) — it lays the foundation for everything else. Phase 0's guardrails must be in place before Phase 1's outbox can safely fan out.

If running sequentially, each phase's exit criteria should gate the next:
- Phase 0 exit: isolation test suite passes + no write path bypasses `KodaDomainWriter`
- Phase 1 exit: outbox processes events < 2s p95 + fan-out registry wired + all 7 event types handled
- Phase 2 exit: `precision@5_avg >= 0.70` on evaluation harness + graphifyEnabled guard verified
- Phase 3 exit: repeated agent queries show measurable token reduction
- Phase 4 exit: `getChangeImpact` returns symbol-level results for a real commit + webhook fires `code_commit`
- Phase 5 exit: zero leakage incidents in 7-day staging soak + all 5 policy gates green
