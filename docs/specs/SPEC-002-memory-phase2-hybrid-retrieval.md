# SPEC: Memory Phase 2 — Hybrid Retrieval Upgrade

## Summary

Upgrade Koda's retrieval from vector-first to a hybrid fusion pipeline combining BM25 lexical, vector similarity, entity overlap, and recency decay scores — with weighted fusion per intent and reranking.

## Phase Boundary

Phase 2 owns retrieval ranking and retrieval-time filtering only. It does not introduce new canonical truth tables, semantic memory extraction, AST indexing, or entity graph traversal. Those remain Phase 1, Phase 3, and Phase 4 responsibilities.

Phase 2 must remain compatible with the existing KB endpoint while the new retriever is introduced:
- `/projects/:slug/kb/search` remains the public read path unless a new retrieval endpoint is explicitly added.
- The controller may call `HybridRetrieverService` directly or use a feature flag during rollout, but the response must preserve the existing KB response fields plus provenance from Phase 0.
- Code results must obey `Project.graphifyEnabled` on both the current live path and the hybrid path.
- All reads are project-scoped by internal `projectId` after slug resolution.

## Motivation

Vector similarity retrieval alone suffers from:
- Poor recall on exact-match queries (technical terms, ticket IDs, function names)
- No entity-aware ranking (a query about "auth service" should boost entities tagged "auth")
- No recency bias (old irrelevant results dominate over fresh ones)

The graphify PR added code graph content but did not change how results are retrieved. Today the live KB path still uses `RagService.search()` with vector search plus native/in-memory FTS merged by RRF. Phase 2 upgrades that retrieval engine into a true hybrid pipeline.

## Design

### 1. Hybrid Retrieval Pipeline

```ts
// apps/api/src/retrieval/hybrid-retriever.service.ts
class HybridRetrieverService {
  constructor(
    private vectorStore: RagService,     // existing LanceDB-backed
    private lexicalStore: LexicalIndex,  // new: in-memory BM25
    private entityStore: EntityStore,     // new: entity graph store
    private config: RetrievalConfig,
  ) {}

  async search(query: HybridSearchQuery): Promise<HybridSearchResult>
}

interface HybridSearchQuery {
  projectId: string;
  query: string;
  intent: string; // normalized to RetrievalIntent internally
  ticketIds?: string[];
  repoRefs?: string[];
  timeWindow?: { from?: Date; to?: Date };
  limit?: number;   // default 20
}

interface HybridSearchResult {
  results!: ScoredResult[];
  scores!: ScoreBreakdown[];
  query!: string;
  intent!: string;
  retrievedAt!: Date;
}

interface ScoredResult {
  id!: string;
  source!: string;
  sourceId!: string;
  content!: string;
  score!: number;
  rank!: number;
  metadata!: Record<string, unknown>;
}

interface ScoreBreakdown {
  id: string;
  vectorScore: number;
  lexicalScore: number;
  entityScore: number;
  recencyScore: number;
  finalScore: number;
}
```

```ts
type RetrievalIntent = 'answer' | 'diagnose' | 'plan' | 'update' | 'search';
```

### 2. Scoring Strategy

| Intent | Vector | BM25 | Entity | Recency |
|--------|--------|------|--------|---------|
| `answer` | 0.4 | 0.3 | 0.2 | 0.1 |
| `diagnose` | 0.2 | 0.2 | 0.4 | 0.2 |
| `plan` | 0.3 | 0.3 | 0.2 | 0.2 |
| `update` | 0.2 | 0.4 | 0.2 | 0.2 |
| `search` | 0.3 | 0.4 | 0.1 | 0.2 |

**BM25** — in-memory BM25 over stored document content. `k1=1.5, b=0.75`. Built lazily on first query, rebuilt on `document_indexed` and `graphify_import` outbox events, and incrementally updated only once dedicated add/remove events exist for the lexical store.

**Persistence:** The BM25 index is kept in-memory only. On API startup, a warmup job starts for all active projects (projects with ≥1 document) in the background. API startup must not fail if warmup has not completed. If warmup is still running, the first search for a project triggers a synchronous lazy build for that project (degraded but functional).

**Vector score** — cosine similarity from LanceDB `vectorSearch()`, normalized to [0,1].

**Entity score** — overlap between query terms and entity labels/tags in Phase 2's `EntityStore`. `score = |query_terms ∩ entity_tags| / |entity_tags|`. 0 if no entities match.

**Recency score** — exponential decay: `score = 0.5^(days_since_indexed / 30)`. Normalized to [0,1] within the result set.

**Fusion:** Weighted linear combination of normalized scores → `finalScore`. Top-K candidates reranked by `finalScore`.

**Normalization:** Each score source is normalized to `[0,1]` before fusion. If a source returns no score for a candidate, that source contributes `0`. If all candidates for a source have the same raw score, normalize that source to `1` for matching candidates and `0` for missing candidates.

**Candidate identity:** Results from vector and lexical stores are merged by stable document identity: `source + sourceId`. Duplicate candidates are collapsed before scoring. The returned `id` must be stable across repeated queries for the same indexed document.

**Time filtering:** `timeWindow` filters by the document's indexed timestamp (`createdAt` / `created_at` in the existing RAG record), not by the source object's domain timestamp. Domain-time filtering belongs to canonical/timeline queries.

**Limit handling:** `limit` defaults to 20 and is capped at 50. Candidate pool size is `max(100, limit * 5)`, split evenly between vector and lexical sources before deduplication.

### 3. Lexical Index (BM25)

```ts
// apps/api/src/retrieval/lexical-index.service.ts
class LexicalIndex {
  private index: Map<string, BM25Document> = new Map();  // projectId → index

  buildIndex(projectId: string, documents: Array<{ id: string; content: string }>): void
  search(projectId: string, query: string, limit: number): Array<{ id: string; score: number }>
  addDocument(projectId: string, doc: { id: string; content: string }): void
  removeDocument(projectId: string, docId: string): void
}

// BM25Document
interface BM25Document {
  id: string;
  terms: Map<string, number>;  // term → frequency
  docLength: number;
  avgDocLength: number;
}
```

**Approach:** Custom in-memory BM25 implementation (no external dependency). Index built lazily on first search per project. Phase 2 supports `addDocument()` and `removeDocument()` for unit-testable behavior, but production outbox wiring may use full project rebuilds until per-document delete/update events are available.

**Document source:** The lexical index rebuild reads from the existing project RAG table through a repository/helper method. Do not duplicate document content into a new canonical table in Phase 2.

### 4. Entity Store

```ts
// apps/api/src/retrieval/entity-store.service.ts
class EntityStore {
  private entities: Map<string, Map<string, EntityRecord>> = new Map();  // projectId → (entityId → entity)

  indexEntity(projectId: string, entity: EntityRecord): void
  removeEntity(projectId: string, entityId: string): void
  searchEntities(projectId: string, query: string): EntityRecord[]
  getByTag(projectId: string, tag: string): EntityRecord[]
}

interface EntityRecord {
  id: string;
  projectId: string;
  type: 'ticket' | 'service' | 'owner' | 'incident' | 'code_module';
  label: string;
  tags: string[];         // for entity-score lookup
  linkedTicketIds: string[];
  linkedServiceIds: string[];
}
```

**Indexing:** Entities are extracted from ticket metadata and code graph (graphify nodes). Updated via outbox fan-out (Phase 1 US-003).

**Storage boundary:** Phase 2's `EntityStore` is a retrieval helper, not the durable entity graph. It may be in-memory for this phase, but it must expose a clear rebuild path from canonical ticket events and graphify imports. Phase 4 owns durable entity graph persistence, traversal, and impact analysis.

**Entity-to-document scoring:** Entity score for a document is computed from entities linked to that document's `source + sourceId`. If no linked entities exist for the document, `entityScore = 0`. Query-wide entity matches that are not linked to a candidate document do not boost that candidate.

### Context Files (optional)
- `apps/api/src/rag/rag.service.ts` — existing vector search to integrate
- `apps/api/src/rag/rag.repository.ts` — document content access for BM25
- `apps/api/src/memory/outbox.service.ts` — outbox event to trigger lexical/entity rebuild

---

## Stories

### US-001: HybridRetrieverService — Pipeline Skeleton + Live Search Compatibility
**Size:** Medium | **AC count:** 10 | **Files:** 3

**ACs:**
- `HybridRetrieverService.search()` accepts `HybridSearchQuery` and returns `HybridSearchResult`
- `HybridSearchResult.scores` contains one `ScoreBreakdown` per result with all four scores populated
- `HybridRetrieverService` is injected into `RagController` or a new `RetrievalController` as the primary search path
- Until the controller fully cuts over, the existing `/projects/:slug/kb/search` path applies any required compatibility filters (including `graphifyEnabled`) so the live behavior matches the future hybrid contract
- When `intent` is not recognized, it defaults to `answer` weights
- When `timeWindow` is provided, results are filtered to only include documents indexed within the window before scoring
- `limit` is capped at 50 and candidate pool size is `max(100, limit * 5)`
- `HybridSearchResult.retrievedAt` is set to the server timestamp at query time
- Only actors with role `admin`, `developer`, `agent`, or `viewer` on the project can call `search()` (checked at controller level)
- `HybridSearchResult` is never returned with `results` from a different `projectId` than the request (hard enforcement)

### US-002: BM25 Lexical Index + Warmup
**Size:** Complex | **AC count:** 12 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `LexicalIndex.buildIndex(projectId, docs)` builds a BM25 index for all documents in the project
- `LexicalIndex.search(projectId, query, limit)` returns up to `limit` document IDs with BM25 scores
- BM25 formula uses `k1=1.5` and `b=0.75`
- When a document is added via `addDocument()`, it is immediately searchable in subsequent calls
- When a document is removed via `removeDocument()`, it no longer appears in search results
- BM25 index is lazy-built on first `search()` call per project if warmup has not yet completed for that project
- A warmup job starts on API startup for active projects with ≥1 document; the API can accept traffic while warmup is running
- After a cold start (restart), the first `search()` call for a project may take up to 2× the normal latency (lazy build cost) but still completes successfully
- Building an index for 10,000 documents completes in under 5 seconds
- A single `search()` call with a 5-word query returns results in under 100ms for 10,000 documents (after warmup)
- A `document_indexed` outbox event triggers `LexicalIndex.buildIndex()` (full project rebuild) for the associated project
- Rebuilds for the same project are serialized so concurrent outbox events cannot corrupt the in-memory index

### US-003: Entity Store + Entity Score
**Size:** Medium | **AC count:** 7 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `EntityStore.indexEntity()` stores the entity and its linked `source + sourceId` references, then makes it searchable by `searchEntities()`
- `EntityStore.searchEntities(projectId, 'auth')` returns entities with 'auth' in label or tags
- `EntityStore.getByTag(projectId, 'backend')` returns all entities tagged 'backend'
- Entity score is computed as `|query_terms ∩ entity.tags| / |entity.tags|`, 0 if no overlap
- Entity score only boosts candidate documents linked to the matched entity; unrelated candidate documents receive `entityScore = 0`
- Entities from graphify nodes (type: `code_module`) are indexed when `graphify_import` outbox event fires
- Entities from tickets (type: `ticket`) are indexed when `ticket_event` outbox event fires

### US-004: Intent-Weighted Fusion + Reranking
**Size:** Medium | **AC count:** 6 | **Files:** 2 | **Depends on:** US-001, US-002, US-003

**ACs:**
- Each intent uses the weight table defined in §2 above
- `finalScore = 0.4*vector + 0.3*lexical + 0.2*entity + 0.1*recency` for `answer` intent
- Results are sorted by `finalScore DESC` and assigned sequential `rank`
- Candidates before reranking are drawn from a pool of `max(100, limit * 5)` split evenly between vector and lexical sources
- When a document has no entity tags, its `entityScore` is 0 and `finalScore` reflects the other three
- When `limit` is not specified, `limit=20` is used as default

### US-005: Evaluation Harness
**Size:** Medium | **AC count:** 6 | **Files:** 2 | **Depends on:** US-004

**ACs:**
- `EvaluationService.runQueries(queries)` runs a batch of `{ projectId, query, intent, expectedDocIds }` and returns precision@5 per query
- `EvaluationService.runQueries()` returns a summary: `{ precision@5_avg, precision@5_p50, precision@5_p95, totalQueries }`
- A seed dataset of 50 evaluation queries is stored in `apps/api/src/retrieval/fixtures/eval-queries.json`
- Running the full evaluation harness prints a table to stdout (for CI capture)
- `EvaluationService` is callable via `bun run evaluate:retrieval` CLI script
- The harness is integrated into the CI pipeline and fails if `precision@5_avg` drops below 0.70

### US-006: graphifyEnabled Retrieval Guard
**Size:** Medium | **AC count:** 8 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- When `HybridRetrieverService.search()` is called for a project where `Project.graphifyEnabled = false`, results with `source = 'code'` are silently excluded from the response
- The same guard is enforced on the current live `/projects/:slug/kb/search` path until that endpoint fully migrates to `HybridRetrieverService`
- When `Project.graphifyEnabled = true`, results with `source = 'code'` are included as normal
- The guard is applied after scoring and before the `HybridSearchResult` is returned (does not affect scoring)
- A project with `graphifyEnabled = false` that has never run `importGraphify` returns 0 code results (same as any other empty result — no error)
- The `graphifyEnabled` flag lookup is cached in `HybridRetrieverService` with a 60-second TTL to avoid repeated DB hits
- Cache is invalidated when `UpdateProjectDto` sets `graphifyEnabled`; direct service-level invalidation is sufficient unless a future `project_updated` outbox event exists
- Policy gate `GraphifyEnabledGate` runs in CI: asserts that searching a non-graphify project never returns `source = 'code'` results
