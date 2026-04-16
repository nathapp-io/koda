# SPEC: Memory Phase 4 — Graph + Code Intelligence (Revised)

## Summary

Address the gaps left by graphify's initial implementation: incremental graph diff (instead of full re-import), AST/symbol-level code indexing, and the missing ticket/entity graph. All three components feed into a `getChangeImpact()` query API.

## Motivation

Graphify (PR #81) delivered the *first* code graph via adjacency text and code-document indexing in LanceDB. Three critical gaps remain:

1. **Full re-import is unscalable** — every new commit requires re-indexing all nodes
2. **No AST/symbol index** — adjacency text is not true symbol-level metadata
3. **Ticket/entity graph is missing** — code graph is isolated from the operational context

## Design

### 1. Incremental Graph Diff

**Problem with current approach:** `importGraphify()` does `deleteAllBySourceType('code')` then re-indexes all nodes. O(n) memory load + no incremental update.

**Solution:** Compute a diff between the incoming graph and the stored graph. Apply only the delta (added, modified, removed nodes/links).

```ts
// apps/api/src/graph/incremental-graph-diff.service.ts
class IncrementalGraphDiffService {
  constructor(
    private graphStore: GraphStoreService,
    private rag: RagService,
  ) {}

  async diffAndApply(
    projectId: string,
    newNodes: GraphifyNodeDto[],
    newLinks: GraphifyLinkDto[],
  ): Promise<DiffResult>

  async getStoredGraph(projectId: string): Promise<StoredGraph>
}

interface StoredGraph {
  nodeMap: Map<string, GraphifyNodeDto>;  // keyed by node.id
  linkMap: Map<string, GraphifyLinkDto[]>;  // keyed by source node ID
}

interface DiffResult {
  added: number;
  updated: number;
  removed: number;
  indexed: number;  // total nodes re-indexed into vector store
  durationMs: number;
}
```

**Diff algorithm:**
1. Load stored graph from `graph_nodes` table (keyed by `projectId + nodeId`)
2. Compare: `newIds - storedIds` = added; `storedIds - newIds` = removed; `intersection(storedIds, newIds)` where content changed = updated
3. For removed nodes: delete from `graph_nodes` table + delete from LanceDB vector store
4. For added/updated nodes: upsert into `graph_nodes` table + regenerate adjacency text + upsert into LanceDB
5. Links: upsert link records, delete stale links

**Content regeneration for updated nodes:** Only regenerate adjacency text for nodes whose `label`, `type`, `source_file`, or outgoing `links` changed. Skip unchanged nodes entirely.

### 2. AST/Symbol Index Pipeline

```ts
// apps/api/src/codeintel/ast-index.service.ts
class AstIndexService {
  constructor(
    private codeGraph: CodeGraphService,
    private symbolStore: SymbolStore,
  ) {}

  async indexCommit(repoId: string, commitHash: string, files: SourceFile[]): Promise<SymbolIndexResult>

  async getSymbol(projectId: string, symbolId: string): Promise<Symbol | null>

  async getCallers(projectId: string, symbolId: string): Promise<CallerInfo[]>

  async getCallees(projectId: string, symbolId: string): Promise<CalleeInfo[]>
}

interface SymbolIndexResult {
  commitHash: string;
  symbolsIndexed: number;
  durationMs: number;
}

interface Symbol {
  id: string;         // e.g. 'repo:main/src/auth/service.ts::AuthService::login'
  projectId: string;
  repoId: string;
  commitHash: string;
  name: string;      // 'AuthService.login'
  kind: 'class' | 'method' | 'function' | 'interface' | 'enum';
  file: string;      // relative path
  startLine: number;
  endLine: number;
  signature?: string;  // parameter types + return type
  callers: string[];   // symbol IDs of functions that call this
  callees: string[];   // symbol IDs of functions this calls
  docComment?: string;
}
```

**Approach:** Parse TypeScript/JavaScript source files with a tree-sitter or AST parser (ts-morph if available, otherwise a minimal custom parser). Index at the symbol level, not file level.

**Implementation approach:** LLM-assisted extraction from source file content + AST parsing. Process files changed in the commit only (not full repo). `projectId` from `repoId → projectId` mapping.

**Symbol ID convention:** `{repoId}:{filePath}::{SymbolName}` — globally unique within a project.

### 3. Ticket/Entity Graph Builder

```ts
// apps/api/src/graph/entity-graph.service.ts
class EntityGraphService {
  constructor(private entityStore: EntityStore) {}

  // Build from ticket events + graphify nodes
  async rebuildGraph(projectId: string): Promise<void>

  // Incremental: update only affected nodes
  async onTicketEvent(event: TicketEvent): Promise<void>
  async onGraphifyImport(projectId: string, nodes: GraphifyNodeDto[]): Promise<void>

  // Graph traversal queries
  async getRelatedEntities(projectId: string, entityId: string, depth?: number): Promise<EntityPath[]>

  async getIncidentImpact(projectId: string, incidentTicketId: string): Promise<ImpactAnalysis>
}

interface EntityPath {
  path: EntityRecord[];
  relation: string;
  depth: number;
}

interface ImpactAnalysis {
  incidentTicketId: string;
  affectedServices: EntityRecord[];
  affectedTickets: EntityRecord[];
  affectedCodeModules: EntityRecord[];
  rootCause?: string;
}
```

**Entity node types:**
- `ticket`: extracted from `TicketEvent`
- `service`: extracted from graphify node `type=code_module` (file path = service boundary)
- `owner`: extracted from ticket `assignedToUserId` or `assignedToAgentId`
- `incident`: extracted from tickets with `priority=critical` or `priority=high`

**Link creation:**
- `ticket → service`: inferred from `gitRefFile`, linked code files, graphified `source_file`, labels, or a future explicit `serviceId` if that field is later added
- `ticket → owner`: from `assignedToUserId` or `assignedToAgentId`
- `service → service`: from graphify links with `relation='depends_on'`
- `incident → ticket`: from incident ticket linking events

### 4. getChangeImpact API

```ts
// apps/api/src/codeintel/impact-analysis.service.ts
class ImpactAnalysisService {
  constructor(
    private symbolStore: SymbolStore,
    private entityGraph: EntityGraphService,
    private codeGraph: GraphStoreService,
  ) {}

  async getChangeImpact(query: ChangeImpactQuery): Promise<ChangeImpactResult>
}

interface ChangeImpactQuery {
  projectId: string;
  repoId: string;
  commitHash: string;
  changedFiles: string[];
  ticketId?: string;  // optional: tie to a ticket
}

interface ChangeImpactResult {
  commitHash: string;
  changedFiles: string[];
  impactedSymbols: Symbol[];       // from AST index
  impactedServices: EntityRecord[];
  impactedTickets: EntityRecord[];
  impactScore: number;             // 0-100, composite
  provenance: Provenance;
}
```

**Impact score formula:**
```
impactScore = 0.3 * (affectedSymbols / totalSymbols * 100)
            + 0.3 * (affectedServices / totalServices * 100)
            + 0.2 * (affectedTickets / totalTickets * 100)
            + 0.2 * (linkedIncidents > 0 ? 100 : 0)
```

### Context Files (optional)
- `apps/api/src/rag/rag.service.ts` — existing `importGraphify` to modify
- `apps/api/src/rag/dto/import-graphify.dto.ts` — DTOs to extend
- `apps/api/src/memory/outbox.service.ts` — outbox event to hook AST indexing into
- `apps/api/src/retrieval/entity-store.service.ts` — Phase 2 entity store to extend

### 5. GraphNode + Symbol Prisma Schema

```sql
-- apps/api/prisma/schema.prisma additions

model GraphNode {
  id          String   @id   // node.id from graphify (e.g. 'AuthService')
  projectId   String
  label       String
  type        String?  // 'class', 'function', 'module', etc.
  sourceFile  String?
  community   Int?
  metadata    Json?    // original node object
  indexedAt   DateTime @default(now())

  project     Project  @relation(fields: [projectId], references: [id])
  links       GraphLink[]
  @@unique([projectId, id])
  @@index([projectId])
}

model GraphLink {
  id          String   @id @default(cuid())
  projectId   String
  sourceId    String   // source node id
  targetId    String   // target node id
  relation    String?

  project     Project  @relation(fields: [projectId], references: [id])
  sourceNode  GraphNode @relation(fields: [sourceId], references: [id])
  @@unique([projectId, sourceId, targetId, relation])
  @@index([projectId, sourceId])
}

model Symbol {
  id           String   @id   // '{repoId}:{filePath}::{SymbolName}'
  projectId    String
  repoId       String
  commitHash   String
  name         String
  kind         String   // 'class' | 'method' | 'function' | 'interface' | 'enum'
  file         String
  startLine    Int
  endLine      Int
  signature    String?
  callers      String[] // array of Symbol.id
  callees      String[]
  docComment   String?
  indexedAt    DateTime @default(now())

  project      Project  @relation(fields: [projectId], references: [id])
  @@unique([projectId, id])
  @@index([projectId, repoId])
  @@index([projectId, commitHash])
}
```

### 6. CanonicalStateService Interface

```ts
// apps/api/src/memory/canonical-state.service.ts
class CanonicalStateService {
  constructor(private prisma: PrismaService) {}

  // Returns authoritative state for a project at query time
  async getSnapshot(query: CanonicalSnapshotQuery): Promise<CanonicalSnapshot>
}

interface CanonicalSnapshotQuery {
  projectId: string;
  ticketIds?: string[];   // if absent, returns no tickets
  actorId?: string;
  timeWindow?: { from?: Date; to?: Date };
}

interface CanonicalSnapshot {
  tickets?: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    assignedToUserId: string | null;
    assignedToAgentId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  recentEvents?: Array<{
    id: string;
    eventType: string;
    actorId: string;
    action: string;
    payload: Json;
    createdAt: Date;
  }>;
  activeDecisions?: Array<{
    id: string;
    topic: string;
    decision: string;
    rationale: string | null;
    createdAt: Date;
  }>;
  retrievedAt: Date;
}
```

> **Design note:** `CanonicalStateService` is a thin read layer over the existing Prisma models. It does NOT introduce new tables — it composes reads across `Ticket`, `TicketEvent`, `AgentEvent`, `DecisionEvent` and `MemoryItem` (for decisions). It is the single canonical read path for all authoritative data.

---

## Stories

### US-001: Incremental Graph Diff — Replace Full Re-Import
**Size:** Complex | **AC count:** 9 | **Files:** 4 | **Depends on:** SPEC-000/US-002, SPEC-002/US-001

**ACs:**
- `IncrementalGraphDiffService.diffAndApply()` computes a diff and applies only the delta
- Stored graph is loaded from `GraphNode` + `GraphLink` Prisma tables (§5 above); not from LanceDB
- When `newNodes` has 100 nodes and stored has 90, `added=10, removed=0`
- When a stored node is absent from `newNodes`, it is deleted from both `GraphNode` table and LanceDB (by `sourceId`)
- When a node exists in both with unchanged content, it is skipped (no re-index)
- `diffAndApply` is called by the existing `importGraphify` endpoint (replaces the current `deleteAllBySourceType` logic)
- `DiffResult.indexed` reflects only the number of nodes actually written to LanceDB (not the total)
- A diff-and-apply of 500 unchanged nodes + 10 added + 5 removed completes in under 2 seconds
- `DiffResult` includes `durationMs` for performance monitoring
- Only actors with role `admin`, `developer`, or `agent` can call `importGraphify` (enforced at controller layer)

### US-002: AST/Symbol Index Pipeline
**Size:** Complex | **AC count:** 9 | **Files:** 5 | **Depends on:** US-001

**ACs:**
- `AstIndexService.indexCommit()` parses source files and stores symbol metadata in the `Symbol` Prisma table (§5)
- `Symbol.id` uses the convention `{repoId}:{filePath}::{SymbolName}` and is globally unique within a project
- `getCallers(symbolId)` returns all symbols that have this symbol in their `callers` array field
- `getCallees(symbolId)` returns all symbols in this symbol's `callees` array field
- When `indexCommit` is called with `files=[{path: 'src/auth.ts', content: '...'}]`, only `src/auth.ts` is parsed (incremental — existing symbols for unchanged files are preserved)
- `Symbol.signature` captures parameter types and return type (e.g. `(userId: string): Promise<User>`)
- Indexing is triggered by a `code_commit` outbox event (fired by the VCS webhook handler — see US-004)
- A commit with 20 files (avg 200 lines each) is indexed in under 30 seconds
- Only actors with role `admin` or `developer` can call `AstIndexService.indexCommit()` directly (not agents); role checked at controller layer

### US-003: Ticket/Entity Graph Builder
**Size:** Complex | **AC count:** 8 | **Files:** 4 | **Depends on:** SPEC-002/US-003

**ACs:**
- `EntityGraphService.rebuildGraph(projectId)` rebuilds all entity nodes and links for a project
- `onTicketEvent(status_changed)` updates the entity node for that ticket (if it exists)
- `onGraphifyImport()` extracts `service` entities from graphify nodes with `type=code_module`
- The initial implementation does not require a `Ticket.serviceId` column; service linkage works from current Koda fields (`gitRefFile`, labels, linked code/module references) until an explicit service relation exists
- `getRelatedEntities(projectId, entityId, depth=2)` returns all entities reachable within 2 hops
- `getIncidentImpact(projectId, incidentTicketId)` returns all entities linked to the incident
- Service entities extracted from graphify inherit `tags` from the graphify node (e.g. `['backend', 'auth']`)
- Entity graph is updated incrementally via outbox fan-out (no full rebuild on every event)
- A graph with 500 nodes and 2000 edges returns `getRelatedEntities` in under 50ms

### US-004: VCS Webhook Handler → code_commit Outbox Event
**Size:** Medium | **AC count:** 7 | **Files:** 3 | **Depends on:** US-001, US-002

**ACs:**
- `VcsWebhookController` extends the existing project-scoped webhook surface at `POST /projects/:slug/vcs-webhook` to handle push/code-intel events
- Webhook payload is validated: presence of `repository.id`, `ref`, `commits[]`, and `sender.account_id` (or `sender.id`)
- For each commit in the push, `AstIndexService.indexCommit()` is called with `{ repoId, commitHash, files: [{path, content}] }`
- A `code_commit` outbox event is enqueued after each `AstIndexService.indexCommit()` call (fire-and-forget)
- If `AstIndexService.indexCommit()` throws, the outbox event is NOT enqueued and the error is logged
- GitHub webhook signature verification reuses the existing `x-hub-signature-256` flow already used by Koda VCS webhooks; invalid signatures return 401
- The webhook secret continues to come from the project's VCS connection record (never hard-coded)
- Webhook handler is idempotent: pushing the same `commitHash` twice does not create duplicate outbox events (dedup by `commitHash` within a 5-minute window)

### US-005: getChangeImpact API
**Size:** Medium | **AC count:** 7 | **Files:** 3 | **Depends on:** US-001, US-002, US-003

**ACs:**
- `GET /projects/:slug/codeintel/impact?repoId=X&commitHash=Y&changedFiles=file1,file2` returns a `ChangeImpactResult`
- `impactedSymbols` contains symbols whose `file` matches any entry in `changedFiles`
- `impactedServices` contains service entities linked to any `impactedSymbols`
- `impactedTickets` contains tickets linked to any `impactedServices`
- `impactScore` is a number 0-100 computed by the formula in §4
- When called with a `ticketId`, the result includes `provenance.sourceRef` pointing to that ticket
- The endpoint returns in under 5 seconds for a commit touching up to 50 files
- Only actors with role `admin`, `developer`, or `agent` can call this endpoint (role checked at controller level)
