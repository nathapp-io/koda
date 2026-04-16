# Koda Memory Architecture — Gap Analysis v2 (Post-Graphify)

**Date:** 2026-04-16
**Project:** Koda
**Scope:** Re-analysis after PR #81 (feat/graphify-kb) merged

---

## What Changed in v2

PR #81 `feat/graphify-kb-validation` (merged) delivered:
- `Project.graphifyEnabled` + `graphifyLastImportedAt` fields
- `'code'` source type in the RAG data model
- `RagService.importGraphify(nodes, links)` — adjacency-aware code indexing
- `RagService.deleteAllBySourceType(projectId, sourceType)` — source-type purge
- `kb import` CLI command
- LanceDB-backed graph-to-vector conversion (deterministic text per node)

---

## Updated Gap Analysis

| Domain | Current Koda (Post-v2) | Target State | Gap | Status |
|--------|------------------------|-------------|-----|--------|
| **Graph Relations** | Code-only graph → vector indexing | Entity graph (ticket↔service↔owner↔incident) | **Partial** | 🔵 Partial — only code graph addressed |
| **Project Isolation** | `projectId` on table, soft retrieval filter | Hard namespace isolation across all stores | **High** | 🔴 Unchanged — no enforcement layer |
| **Memory Types** | Semantic (vector) + code graph | Episodic + semantic + graph + code + temporal | **High** | 🟡 Improved — code graph added |
| **Source of Truth** | Mixed (DB + inferred from RAG) | Canonical Postgres only | **High** | 🔴 Unchanged |
| **Write Safety** | `indexDocument()` open, no domain gate | Domain API write gates + validation | **High** | 🔴 Unchanged |
| **Conflict Resolution** | Vector distance wins | Canonical wins + authority tiers | **High** | 🔴 Unchanged |
| **Temporal Reasoning** | BM25/relevance-heavy | Event timeline + recency policies | **High** | 🔴 Unchanged |
| **Code Intelligence** | Graphify adjacency text (embedding) | AST/symbol/callgraph index per commit | **Medium** | 🟡 Improved — graph content but no AST |
| **Hybrid Retrieval** | Vector + BM25 | BM25 + vector + entity + recency fusion | **Medium** | 🔴 Unchanged |
| **Auditability/Provenance** | Per-result provenance metadata | Full provenance per answer fragment | **High** | 🔴 Unchanged |
| **Freshness Pipeline** | Manual/batch indexing tendency | Event-driven outbox sync | **Medium-High** | 🔴 Unchanged |
| **Agent Contract** | Agent-specific prompts | Shared `getProjectContext()` contract | **High** | 🔴 Unchanged |

---

## New Gaps Exposed by Graphify

| Gap | Severity | Detail |
|-----|----------|--------|
| **Code graph only** | High | Graphify targets code. Ticket→service→owner→incident graph still missing. |
| **Graph is import-only, not derived** | High | `importGraphify()` is a bulk-import endpoint. No incremental graph update (new commit = full re-import). |
| **No AST/symbol index** | Medium | Graphify generates adjacency text, not true symbol-level metadata. No caller/callee graph. |
| **LanceDB purge bottleneck** | Medium | `deleteAllBySourceType` loads ALL rows into memory, then filters. Will break at scale. |
| **No graphify guard on retrieval** | Medium | No `graphifyEnabled` gate on search results — code graph results can surface in non-graphify projects. |

---

## Updated Migration Plan

### Phase 0 (Guardrails) — **Unchanged, still needed first**
- Enforce `project_id` on all reads/writes
- Add domain write gate
- Provenance envelope

### Phase 1 (Canonical + Episodic) — **Unchanged, still needed**
- Event tables + outbox pattern
- Timeline API

### Phase 2 (Hybrid Retrieval) — **Unchanged, still needed**
- BM25 + vector + entity + recency fusion
- Evaluation harness

### Phase 3 (Semantic Memory) — **Unchanged, still needed**
- Atomic fact extraction
- Memory governance

### Phase 4 (Graph + Code Intelligence) — **Scope Shift**

| Before v2 | After v2 |
|-----------|----------|
| Build entity graph from scratch | Code graph is **done** (graphify) |
| Build AST/symbol index from scratch | Need **incremental** updates + AST |
| Dependency path queries | Need **symbol-level** caller/callee |

**Revised Phase 4 deliverables:**
1. Incremental graph update pipeline (diff-based, not full re-import)
2. AST/symbol index keyed by `repo+commit`
3. `getChangeImpact(projectId, repo, commit)` with symbol references
4. Ticket/entity graph builder (the missing half)

### Phase 5 — **Unchanged, still needed**
- Shared context contract
- CI policy gates
- SLO dashboard

---

## Immediate Next Actions

1. **Enforce `graphifyEnabled` gate** on retrieval — prevent code graph surfacing in non-graphify projects
2. **Fix `deleteAllBySourceType` O(n) memory issue** — use streaming delete or batched approach
3. **Add incremental graph diff** — avoid full re-import on every new commit
4. **Start Phase 1** (event tables + outbox) — this is still the biggest gap vs. the target architecture
