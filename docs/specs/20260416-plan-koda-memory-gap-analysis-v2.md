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

PR #81 did **not** deliver:
- a retrieval-time `graphifyEnabled` guard on the live `/projects/:slug/kb/search` path
- response-level provenance metadata on KB search results
- outbox/event infrastructure for derived-store sync
- a project-scoped actor/ACL layer for the future memory APIs

---

## Updated Gap Analysis

| Domain | Current Koda (Post-v2) | Target State | Gap | Status |
|--------|------------------------|-------------|-----|--------|
| **Graph Relations** | Code-only graph → vector indexing | Entity graph (ticket↔service↔owner↔incident) | **Partial** | 🔵 Partial — only code graph addressed |
| **Project Isolation** | Slug-resolved project lookup + project-scoped Lance tables | Hard namespace isolation across all stores | **High** | 🔴 Unchanged — no enforcement layer |
| **Memory Types** | Vector RAG + native/in-memory FTS + imported code graph text | Episodic + semantic + graph + code + temporal | **High** | 🟡 Improved — code graph added |
| **Source of Truth** | Mixed (DB + inferred from RAG) | Canonical Postgres only | **High** | 🔴 Unchanged |
| **Write Safety** | `indexDocument()` open, no domain gate | Domain API write gates + validation | **High** | 🔴 Unchanged |
| **Conflict Resolution** | Vector distance wins | Canonical wins + authority tiers | **High** | 🔴 Unchanged |
| **Temporal Reasoning** | Relevance-only (vector + FTS), no event timeline | Event timeline + recency policies | **High** | 🔴 Unchanged |
| **Code Intelligence** | Graphify adjacency text (embedding) | AST/symbol/callgraph index per commit | **Medium** | 🟡 Improved — graph content but no AST |
| **Hybrid Retrieval** | Vector + native/in-memory FTS with RRF | BM25 + vector + entity + recency fusion | **Medium** | 🔴 Unchanged |
| **Auditability/Provenance** | Score/similarity metadata only; no response provenance envelope | Full provenance per answer fragment | **High** | 🔴 Unchanged |
| **Freshness Pipeline** | Manual/batch indexing tendency | Event-driven outbox sync | **Medium-High** | 🔴 Unchanged |
| **Agent Contract** | Agent-specific prompts | Shared `getProjectContext()` contract | **High** | 🔴 Unchanged |
| **Auth / Actor Model** | Global `ADMIN`/`MEMBER` users + agent role/capability records | Project-scoped actor roles and memory permissions | **High** | 🔴 Unchanged |

---

## New Gaps Exposed by Graphify

| Gap | Severity | Detail |
|-----|----------|--------|
| **Code graph only** | High | Graphify targets code. Ticket→service→owner→incident graph still missing. |
| **Graph is import-only, not derived** | High | `importGraphify()` is a bulk-import endpoint. No incremental graph update (new commit = full re-import). |
| **No AST/symbol index** | Medium | Graphify generates adjacency text, not true symbol-level metadata. No caller/callee graph. |
| **LanceDB purge bottleneck** | Medium | `deleteAllBySourceType` loads ALL rows into memory, then filters. Will break at scale. |
| **No graphify guard on live retrieval path** | Medium | The current `/projects/:slug/kb/search` endpoint still calls `RagService.search()` directly, so `source='code'` results can surface in non-graphify projects. |
| **Roadmap auth model is ahead of the repo** | Medium | Later specs assume project-scoped actor roles (`admin/developer/agent/viewer`), but current Koda auth is still global `ADMIN`/`MEMBER` plus agent role tables. |

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
| Build entity graph from scratch | Initial code graph import path exists (`importGraphify`), but persistent graph tables/diffing do not |
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

1. **Enforce `graphifyEnabled` on the current live search path** (`RagService.search()` / `/projects/:slug/kb/search`) before Phase 2 lands
2. **Fix `deleteAllBySourceType` O(n) memory issue** — use direct delete or a batched/streaming count strategy
3. **Add an auth/actor bridge story** so future memory APIs map cleanly from current `ADMIN`/`MEMBER` + agent records into project-scoped roles
4. **Start Phase 1** (event tables + outbox) — this is still the biggest gap vs. the target architecture
5. **Add incremental graph diff** — avoid full re-import on every new commit
