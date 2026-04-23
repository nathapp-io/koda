# SPEC: Memory Phase 3 — Semantic Memory Extraction

## Summary

Persist reusable facts, decisions, preferences, and patterns extracted from agent conversations and ticket history — without storing full transcripts. Introduce atomic memory item schema, confidence/TTL/owner fields, conflict resolution rules, and memory governance jobs.

## Phase Boundary

Phase 3 owns durable semantic memory items and the rules that create, retrieve, supersede, and expire them. It does not own raw transcript storage, hybrid document ranking, graph traversal, or agent prompt formatting.

Semantic memory must be derived from canonical events whenever possible:
- `TicketEvent`, `AgentEvent`, and `DecisionEvent` from Phase 1 are the source of truth.
- `MemoryItem` records are derived, queryable summaries and may be rebuilt from canonical events in a future maintenance job.
- No full agent transcript is stored in `MemoryItem.object`; only atomic facts, decisions, preferences, constraints, or incident patterns are stored.
- Every memory item must retain `sourceType` and `sourceId` when it came from a canonical event or explicit decision write.

## Motivation

Today, every agent query re-derives the same facts from raw context. This is slow, token-expensive, and inconsistent. Phase 3 extracts durable atomic memories that survive across sessions and make context assembly faster and cheaper.

## Design

### 1. Memory Item Schema

```sql
-- apps/api/prisma/schema.prisma additions

model MemoryItem {
  id           String      @id @default(cuid())
  projectId    String
  kind         String      // FACT | DECISION | PREFERENCE | CONSTRAINT | INCIDENT_PATTERN
  subject      String      // the thing being described (e.g. 'auth service', 'deploy pipeline')
  predicate    String      // the relationship/description (e.g. 'endpoint is', 'uses', 'follows')
  object       String?     // optional value (e.g. 'auth.v1.nathapp.io', 'conventional commits')
  confidence   Float       @default(0.8)   // 0-1
  ttlAt        DateTime?   // null = never expires
  ownerId      String?     // agent or user who created it
  sourceType   String?     // ticket_event | agent_event | decision_event | manual
  sourceId     String?     // ID of canonical record/source
  status       String      @default('active')  // 'active' | 'superseded' | 'rejected'
  supersededBy String?
  activeKey    String?     // set only for active rows; null for superseded/rejected
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  project      Project     @relation(fields: [projectId], references: [id])
  supersededByMemory MemoryItem? @relation("MemorySupersession", fields: [supersededBy], references: [id])
  supersedes          MemoryItem[] @relation("MemorySupersession")
  @@index([projectId, kind])
  @@index([projectId, status])
  @@index([projectId, kind, subject, predicate])
  @@unique([projectId, activeKey])
}
```

**Kind constants:** Koda API guidance says not to use Prisma enums. Define `MemoryKind` as a TypeScript string union/constant in API code and validate at DTO/service boundaries.

**Active uniqueness:** Koda supports SQLite by default, so use `activeKey` for uniqueness instead of a partial unique index. For active rows, set `activeKey = "{kind}:{subject}:{predicate}"`; for superseded/rejected rows, set `activeKey = null`. SQLite allows multiple `null` values in a unique index, so history rows can coexist while active rows remain unique per project.

### 2. Extraction Service

```ts
// apps/api/src/memory/extraction.service.ts
class ExtractionService {
  constructor(
    private memoryRepo: MemoryItemRepository,
    private timeline: TimelineService,
  ) {}

  // Called by outbox fan-out on agent_event + ticket_event
  async extractFromEvent(event: OutboxEvent): Promise<MemoryItem[]>

  // Called explicitly by agent via KodaDomainWriter
  async recordDecision(data: RecordDecisionInput): Promise<WriteResult>

  // Resolve conflicts before storing
  async resolveConflicts(item: MemoryItem): Promise<MemoryItem | null>
}

interface RecordDecisionInput {
  projectId: string;
  actorId: string;
  topic: string;
  decision: string;
  rationale?: string;
  sourceId?: string;
}
```

**Explicit decisions:** `recordDecision()` must write a canonical `DecisionEvent` through `KodaDomainWriter` or the Phase 1 decision event service before creating/upserting the derived `MemoryItem`. The returned `WriteResult.canonicalId` is the `DecisionEvent.id`; the derived memory ID is returned in `derivedIds`.

**Extraction approach:** Rule-based extractors run on event payloads. NOT LLM-based for extraction (too expensive at scale). Extractor registry:

| Event type | What to extract |
|-----------|-----------------|
| `ticket_event` action=`status_changed` | FACT: `ticket {id} status changed from {old_value} to {new_value}` |
| `ticket_event` action=`assigned` | FACT: `ticket {id} assigned to {new_assignee}` |
| `agent_event` metadata contains `decision_made` | DECISION: extract topic + decision text |
| `ticket_event` action=`incident_linked` | INCIDENT_PATTERN: link ticket to service |

**Conflict resolution rules:**
1. `FACT` with higher `confidence` wins
2. `FACT` from a canonical event (ticket_event) overrides `FACT` inferred from agent conversation
3. `DECISION` with newer `createdAt` supersedes older decision on same topic
4. `PREFERENCE` from explicit `recordDecision` call overrides extracted preference
5. Memories with `ttlAt < now()` are excluded from retrieval (governance job)

**Unsupported extraction:** If an event payload is missing required fields for a rule, the extractor returns `[]` and logs a structured warning. It must not create low-confidence placeholder memories from incomplete payloads.

### 3. Memory Retrieval API

```ts
// apps/api/src/memory/memory.service.ts
class MemoryService {
  async getProjectMemory(query: MemoryQuery): Promise<MemoryResponse>
  async getMemoryById(id: string): Promise<MemoryItem | null>
}

interface MemoryQuery {
  projectId: string;
  kinds?: string[];
  subjects?: string[];    // filter by subject (prefix match)
  tags?: string[];        // for future tag-based filtering
  status?: 'active' | 'superseded' | 'rejected';  // default: 'active'
  limit?: number;
}
```

**Retrieval integration:** `getProjectContext()` calls `MemoryService.getProjectMemory()` and includes results in the `semanticMemory` block of the context response.

**Ordering:** Unless a caller provides a more specific ranking rule, memory retrieval orders by `confidence DESC`, then `updatedAt DESC`, then `createdAt DESC`.

### 4. Memory Governance Jobs

```ts
// apps/api/src/memory/governance.service.ts
class GovernanceService {
  // Cron: daily at 03:00 UTC
  async runCleanup(): Promise<GovernanceResult>

  // Expire TTL'd memories
  async expireMemories(): Promise<number>

  // Downrank memories with confidence < 0.3 that are > 90 days old
  async downrankStaleLowConfidence(): Promise<number>

  // Deduplicate: find memories with same (kind, subject, predicate) and keep highest confidence
  async deduplicate(): Promise<DedupResult>

  // Supersede patterns (e.g. decision supersedes older decision on same topic)
  async applySupersession(): Promise<number>
}

interface GovernanceResult {
  expired: number;
  downranked: number;
  deduplicated: number;
  superseded: number;
  durationMs: number;
}
```

### Context Files (optional)
- `apps/api/prisma/schema.prisma` — schema additions
- `apps/api/src/memory/outbox.service.ts` — outbox event types to hook extraction into
- `apps/api/src/memory/timeline.service.ts` — TimelineService to query for context

---

## Stories

### US-001: Memory Item Schema + Repository
**Size:** Medium | **AC count:** 9 | **Files:** 3 | **Depends on:** SPEC-001/US-001

**ACs:**
- Prisma migration adds `MemoryItem` table with all fields defined in §1
- Repository-level transaction logic prevents more than one active memory for the same `(projectId, kind, subject, predicate)` key
- `MemoryItemRepository.findByProject(query)` returns paginated results matching the filter criteria
- `MemoryItemRepository.upsert(item)` inserts or updates (on conflict) a memory item
- `MemoryItemRepository.findActive(projectId, kind, subject, predicate)` returns the active memory for that composite key, or null
- Creating a `MemoryItem` with a non-existent `projectId` throws `ForbiddenError` (`code: 'PROJECT_NOT_FOUND'`)
- Only actors with role `admin`, `developer`, or `agent` can write memories; role is checked at the controller layer before calling `ExtractionService`
- Memory rows include `sourceType` and `sourceId` when created from `TicketEvent`, `AgentEvent`, `DecisionEvent`, or explicit `recordDecision`
- Active rows have non-null `activeKey`; superseded/rejected rows have `activeKey = null`

### US-002: Extraction Service — Rule-Based Extractors
**Size:** Complex | **AC count:** 9 | **Files:** 4 | **Depends on:** US-001, SPEC-001/US-003

**ACs:**
- `ExtractionService.extractFromEvent(ticket_event with action='status_changed')` returns a MemoryItem with kind=FACT, subject=`ticket:{id}`, predicate=`status`
- `ExtractionService.extractFromEvent(ticket_event with action='assigned')` returns a MemoryItem with kind=FACT, subject=`ticket:{id}`, predicate=`assigned_to`
- `ExtractionService.extractFromEvent(agent_event)` returns empty array when metadata contains no `decision_made` key
- `ExtractionService.extractFromEvent(event)` returns empty array and logs a warning when a supported event type has an incomplete payload
- `ExtractionService.recordDecision(data)` creates a canonical `DecisionEvent`, calls `MemoryItemRepository.upsert()`, and returns `WriteResult` with `canonicalId` and derived memory ID
- `recordDecision` with a topic that already has an active decision marks the old decision as `superseded` (sets `supersededBy` + `status='superseded'`)
- `extractFromEvent` is called by `OutboxFanOutRegistry.dispatch()` when event type is `ticket_event` or `agent_event` (registered per SPEC-001/US-006)
- Extracted items have `confidence >= 0.5` and `ttlAt = null` (never expires by default)
- Items from explicit `recordDecision` have `confidence = 1.0`

### US-003: Memory Retrieval API
**Size:** Medium | **AC count:** 7 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `GET /projects/:slug/memory` returns all `status=active` memories for the project
- `GET /projects/:slug/memory?kind=FACT` returns only FACT memories
- `GET /projects/:slug/memory?subjects=ticket:123` returns memories with subject starting with `ticket:123`
- When `status=superseded` is requested, each superseded memory includes `supersededBy` when known
- Memory retrieval respects `projectId` isolation (cannot access another project's memories)
- `getProjectMemory()` is called internally by `getProjectContext()` and results appear in the `semanticMemory` block
- Results are ordered by `confidence DESC`, then `updatedAt DESC` unless the caller provides a stricter filter

### US-004: Memory Governance Jobs
**Size:** Medium | **AC count:** 8 | **Files:** 3 | **Depends on:** US-001, US-002

**ACs:**
- `GovernanceService.runCleanup()` executes all four sub-jobs and returns a combined `GovernanceResult`
- `expireMemories()` sets `status='rejected'` for all memories where `ttlAt < now()` and returns the count
- `downrankStaleLowConfidence()` sets `confidence=0.1` for memories older than 90 days with `confidence < 0.3`
- `deduplicate()` finds all (projectId, kind, subject, predicate) combos with >1 active memory, keeps the highest confidence, marks others as `superseded`
- `applySupersession()` finds DECISION memories on the same topic ordered by `createdAt DESC`, keeps the newest as active, marks older ones as `superseded`
- Governance jobs are idempotent (running twice in a row produces the same end state)
- A governance run touching 1000 memories completes in under 30 seconds
- Governance jobs never delete `MemoryItem` rows; they update `status`, `confidence`, or `supersededBy` so audit history remains available

### US-005: Semantic Memory in getProjectContext
**Size:** Simple | **AC count:** 4 | **Files:** 2 | **Depends on:** US-003

**ACs:**
- `getProjectContext()` includes a `semanticMemory` field in its response
- `semanticMemory` contains up to 10 most-relevant active MemoryItems, ordered by confidence DESC
- When `semanticMemory` items are returned, `provenance.sources` includes entries with `source_type='memory_item'`
- If no MemoryItems exist for the project, `semanticMemory` is an empty array (not null)
