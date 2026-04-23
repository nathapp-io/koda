# SPEC: Memory Phase 4 — Graph + Code Intelligence (Revised)

## Summary

Address the gaps left by graphify's initial implementation: incremental graph diff (instead of full re-import), AST/symbol-level code indexing, and the missing ticket/entity graph. All three components feed into a `getChangeImpact()` query API.

## Phase Boundary

Phase 4 owns durable graph/code intelligence and impact analysis. It builds on earlier phases but must not replace their responsibilities:
- Phase 2 owns retrieval scoring; Phase 4 may feed code/entity metadata into it.
- Phase 3 owns semantic memory; Phase 4 may link memories or decisions through provenance but does not extract semantic memories.
- Phase 5 owns shared agent context assembly; Phase 4 only exposes APIs and services that context assembly can call.
- Existing graphify imports remain project-scoped and continue to honor `Project.graphifyEnabled`.

The minimum Phase 4 outcome is not "perfect code intelligence"; it is a deterministic, incremental, project-isolated foundation that can answer which symbols, services, and tickets are likely affected by a code change.

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
  nodeMap: Map<string, GraphifyNodeDto>;  // keyed by graphify node.id / GraphNode.nodeId
  linkMap: Map<string, GraphifyLinkDto[]>;  // keyed by source GraphNode.nodeId
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
  filesIndexed: number;
  fileErrors: Array<{ path: string; error: string }>;
  durationMs: number;
}

interface Symbol {
  id: string;         // database ID
  symbolId: string;   // e.g. 'repo:main/src/auth/service.ts::AuthService::login'
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

**Approach:** Parse TypeScript/JavaScript source files with a deterministic parser (`ts-morph` preferred for TypeScript projects). Index at the symbol level, not file level.

**Implementation approach:** Parser output is the source of truth. LLM-assisted extraction may be used later to enrich summaries, but Phase 4 must not depend on an LLM to identify symbol names, locations, signatures, callers, or callees. Process files changed in the commit only (not full repo). `projectId` comes from the `repoId → projectId` mapping.

**Symbol ID convention:** `{repoId}:{filePath}::{SymbolName}` — unique within a project. If overloaded or nested symbols collide, append a stable parser-derived suffix such as `#2`.

**Changed file content:** Push webhooks usually contain file names, not full source contents. The `code_commit` outbox handler must resolve file contents before calling `AstIndexService.indexCommit()`, either through a provider method added in this phase (for example `fetchCommitFiles(repoId, commitHash, changedFiles)`) or through a repo checkout/cache service. The webhook controller should not synchronously fetch file contents.

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

**Persistence:** Phase 4 introduces durable `EntityNode` and `EntityLink` tables (§5). Do not depend on Phase 2's in-memory `EntityStore` for graph traversal or impact analysis.

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

**Impact score denominator guard:** If any denominator is zero (`totalSymbols`, `totalServices`, or `totalTickets`), that term contributes `0` instead of dividing by zero. `impactScore` is clamped to `[0,100]`.

### Context Files (optional)
- `apps/api/src/rag/rag.service.ts` — existing `importGraphify` to modify
- `apps/api/src/rag/dto/import-graphify.dto.ts` — DTOs to extend
- `apps/api/src/memory/outbox.service.ts` — outbox event to hook AST indexing into
- `apps/api/src/retrieval/entity-store.service.ts` — Phase 2 entity store to extend

### 5. GraphNode + EntityNode + Symbol Prisma Schema

```sql
-- apps/api/prisma/schema.prisma additions

model GraphNode {
  id          String   @id @default(cuid())
  projectId   String
  nodeId      String   // node.id from graphify (e.g. 'AuthService')
  label       String
  type        String?  // 'class', 'function', 'module', etc.
  sourceFile  String?
  community   Int?
  metadata    String   @default("{}") // original node object as JSON string
  indexedAt   DateTime @default(now())

  project     Project  @relation(fields: [projectId], references: [id])
  outgoingLinks GraphLink[] @relation("GraphLinkSource")
  incomingLinks GraphLink[] @relation("GraphLinkTarget")
  @@unique([projectId, nodeId])
  @@index([projectId])
}

model GraphLink {
  id          String   @id @default(cuid())
  projectId   String
  sourceGraphNodeId String
  targetGraphNodeId String
  relation    String   @default("related")

  project     Project  @relation(fields: [projectId], references: [id])
  sourceNode  GraphNode @relation("GraphLinkSource", fields: [sourceGraphNodeId], references: [id], onDelete: Cascade)
  targetNode  GraphNode @relation("GraphLinkTarget", fields: [targetGraphNodeId], references: [id], onDelete: Cascade)
  @@unique([projectId, sourceGraphNodeId, targetGraphNodeId, relation])
  @@index([projectId, sourceGraphNodeId])
  @@index([projectId, targetGraphNodeId])
}

model EntityNode {
  id          String   @id @default(cuid())
  projectId   String
  entityId    String   // e.g. ticket:{id}, service:{name}, owner:{id}
  type        String   // ticket | service | owner | incident | code_module
  label       String
  tags        String   @default("[]") // JSON string for SQLite compatibility
  sourceType  String?  // ticket_event | graph_node | manual
  sourceId    String?
  metadata    String   @default("{}") // JSON string for SQLite compatibility
  updatedAt   DateTime @updatedAt
  createdAt   DateTime @default(now())

  project       Project @relation(fields: [projectId], references: [id])
  outgoingLinks EntityLink[] @relation("EntityLinkSource")
  incomingLinks EntityLink[] @relation("EntityLinkTarget")
  @@unique([projectId, entityId])
  @@index([projectId, type])
}

model EntityLink {
  id             String   @id @default(cuid())
  projectId      String
  sourceEntityNodeId String
  targetEntityNodeId String
  relation       String
  confidence     Float    @default(0.8)
  sourceType     String?
  sourceId       String?
  createdAt      DateTime @default(now())

  project      Project @relation(fields: [projectId], references: [id])
  sourceEntity EntityNode @relation("EntityLinkSource", fields: [sourceEntityNodeId], references: [id], onDelete: Cascade)
  targetEntity EntityNode @relation("EntityLinkTarget", fields: [targetEntityNodeId], references: [id], onDelete: Cascade)
  @@unique([projectId, sourceEntityNodeId, targetEntityNodeId, relation])
  @@index([projectId, sourceEntityNodeId])
  @@index([projectId, targetEntityNodeId])
}

model Symbol {
  id           String   @id @default(cuid())
  projectId    String
  symbolId     String   // '{repoId}:{filePath}::{SymbolName}'
  repoId       String
  commitHash   String
  name         String
  kind         String   // 'class' | 'method' | 'function' | 'interface' | 'enum'
  file         String
  startLine    Int
  endLine      Int
  signature    String?
  callers      String   @default("[]") // array of Symbol.symbolId as JSON string
  callees      String   @default("[]") // array of Symbol.symbolId as JSON string
  docComment   String?
  indexedAt    DateTime @default(now())

  project      Project  @relation(fields: [projectId], references: [id])
  @@unique([projectId, symbolId])
  @@index([projectId, repoId])
  @@index([projectId, commitHash])
}
```

**SQLite compatibility:** Koda defaults to SQLite and the current schema stores JSON-like fields as strings in several models. Do not use Prisma scalar lists or provider-specific JSON behavior in Phase 4 tables. Store arrays/objects as JSON-encoded strings and validate them in repositories/services.

**Link storage:** Graphify and entity code can still address nodes by `nodeId`/`entityId`; repositories resolve those stable IDs to Prisma row IDs before writing `GraphLink` or `EntityLink` records. This keeps foreign keys simple and Prisma-compatible.

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

> **Design note:** `CanonicalStateService` is a thin read layer over the existing Prisma models. It does NOT introduce new tables — it composes reads across `Ticket`, `TicketEvent`, `AgentEvent`, `DecisionEvent` and `MemoryItem` (for active decisions). It is the single canonical read path for all authoritative data and is consumed by Phase 5.

---

## Stories

### US-001: Incremental Graph Diff — Replace Full Re-Import
**Size:** Complex | **AC count:** 10 | **Files:** 4 | **Depends on:** SPEC-000/US-002, SPEC-002/US-001

**ACs:**
- `IncrementalGraphDiffService.diffAndApply()` computes a diff and applies only the delta
- Stored graph is loaded from `GraphNode` + `GraphLink` Prisma tables (§5 above); not from LanceDB
- When `newNodes` has 100 nodes and stored has 90, `added=10, removed=0`
- When a stored node is absent from `newNodes`, it is deleted from both `GraphNode` table and LanceDB (by graphify `nodeId` / RAG `sourceId`)
- When a node exists in both with unchanged content, it is skipped (no re-index)
- `diffAndApply` is called by the existing `importGraphify` endpoint (replaces the current `deleteAllBySourceType` logic)
- `DiffResult.indexed` reflects only the number of nodes actually written to LanceDB (not the total)
- A diff-and-apply of 500 unchanged nodes + 10 added + 5 removed completes in under 2 seconds
- `DiffResult` includes `durationMs` for performance monitoring
- Only actors with role `admin`, `developer`, or `agent` can call `importGraphify` (enforced at controller layer)

### US-002: AST/Symbol Index Pipeline
**Size:** Complex | **AC count:** 11 | **Files:** 5 | **Depends on:** US-001

**ACs:**
- `AstIndexService.indexCommit()` parses source files and stores symbol metadata in the `Symbol` Prisma table (§5)
- `Symbol.symbolId` uses the convention `{repoId}:{filePath}::{SymbolName}` and is globally unique within a project
- `getCallers(symbolId)` returns all symbols that include this symbol in their JSON `callers` list
- `getCallees(symbolId)` returns all symbols in this symbol's JSON `callees` list
- When `indexCommit` is called with `files=[{path: 'src/auth.ts', content: '...'}]`, only `src/auth.ts` is parsed (incremental — existing symbols for unchanged files are preserved)
- `Symbol.signature` captures parameter types and return type (e.g. `(userId: string): Promise<User>`)
- Indexing is triggered by a `code_commit` outbox event (fired by the VCS webhook handler — see US-004)
- A commit with 20 files (avg 200 lines each) is indexed in under 30 seconds
- Only actors with role `admin` or `developer` can call `AstIndexService.indexCommit()` directly (not agents); role checked at controller layer
- Parser failures for one file are recorded in the result and do not prevent other files in the same commit from being indexed
- The `code_commit` handler resolves changed file contents before calling `indexCommit()`; the webhook controller only enqueues commit metadata

### US-003: Ticket/Entity Graph Builder
**Size:** Complex | **AC count:** 10 | **Files:** 4 | **Depends on:** SPEC-002/US-003

**ACs:**
- `EntityGraphService.rebuildGraph(projectId)` rebuilds all entity nodes and links for a project
- Entity graph data is persisted in `EntityNode` and `EntityLink` tables, not only in Phase 2's in-memory `EntityStore`
- `onTicketEvent(status_changed)` updates the entity node for that ticket (if it exists)
- `onGraphifyImport()` extracts `service` entities from graphify nodes with `type=code_module`
- The initial implementation does not require a `Ticket.serviceId` column; service linkage works from current Koda fields (`gitRefFile`, labels, linked code/module references) until an explicit service relation exists
- `getRelatedEntities(projectId, entityId, depth=2)` returns all entities reachable within 2 hops
- `getIncidentImpact(projectId, incidentTicketId)` returns all entities linked to the incident
- Service entities extracted from graphify inherit `tags` from the graphify node (e.g. `['backend', 'auth']`)
- Entity graph is updated incrementally via outbox fan-out (no full rebuild on every event)
- A graph with 500 nodes and 2000 edges returns `getRelatedEntities` in under 50ms

### US-004: VCS Webhook Handler → code_commit Outbox Event
**Size:** Medium | **AC count:** 8 | **Files:** 3 | **Depends on:** US-001, US-002

**ACs:**
- `VcsWebhookController` extends the existing project-scoped webhook surface at `POST /projects/:slug/vcs-webhook` to handle push/code-intel events
- Webhook payload is validated: presence of repository identifier, `ref`, `commits[]`, and sender identifier (`sender.id`, `sender.login`, or provider equivalent)
- For each commit in the push, a `code_commit` outbox event is enqueued with `{ repoId, commitHash, ref, changedFiles }`
- `AstIndexService.indexCommit()` is called by the `code_commit` outbox handler, not synchronously by the webhook controller
- If event enqueue fails, the webhook logs the failure and returns a non-2xx response so the provider can retry
- GitHub webhook signature verification reuses the existing `x-hub-signature-256` flow already used by Koda VCS webhooks; invalid signatures return 401
- The webhook secret continues to come from the project's VCS connection record (never hard-coded)
- Webhook handler is idempotent: pushing the same `commitHash` twice does not create duplicate outbox events (dedup by `commitHash` within a 5-minute window)

### US-005: getChangeImpact API
**Size:** Medium | **AC count:** 8 | **Files:** 3 | **Depends on:** US-001, US-002, US-003

**ACs:**
- `GET /projects/:slug/codeintel/impact?repoId=X&commitHash=Y&changedFiles=file1,file2` returns a `ChangeImpactResult`
- `impactedSymbols` contains symbols whose `file` matches any entry in `changedFiles`
- `impactedServices` contains service entities linked to impacted symbols through matching `Symbol.file` → `GraphNode.sourceFile` or `EntityNode.sourceId`
- `impactedTickets` contains tickets linked to any `impactedServices`
- `impactScore` is a number 0-100 computed by the formula in §4
- When called with a `ticketId`, the result includes provenance source metadata pointing to that ticket
- The endpoint returns in under 5 seconds for a commit touching up to 50 files
- Only actors with role `admin`, `developer`, or `agent` can call this endpoint (role checked at controller level)

### US-006: CanonicalStateService Snapshot Read Layer
**Size:** Medium | **AC count:** 6 | **Files:** 2 | **Depends on:** SPEC-001/US-004, SPEC-003/US-001

**ACs:**
- `CanonicalStateService.getSnapshot(query)` returns `retrievedAt` set to the server timestamp
- When `ticketIds` are provided, `tickets` contains only tickets in the requested `projectId`
- When `timeWindow` is provided, `recentEvents` contains only events in the window, ordered by `createdAt DESC`
- `activeDecisions` is populated from active `MemoryItem` rows with `kind='DECISION'`
- A non-existent or unauthorized `projectId` throws the same `KodaError`/Nathapp exception style used by earlier memory endpoints
- The service performs canonical Prisma reads only; it does not query LanceDB, BM25, entity graph, or other derived stores
