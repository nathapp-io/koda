# SPEC: Memory Phase 0 — Guardrails

## Summary

Establish hard project namespace isolation and domain write gates before any new memory components are introduced. Stop truth drift by enforcing `projectId` as a mandatory dimension on every read/write and wrapping all agent write paths behind a domain service.

## Motivation

Koda currently has no enforcement layer preventing cross-project data access or unauthorized writes. Agent prompts can accidentally query or mutate tickets/docs from other projects. As episodic and semantic memory layers are added, this risk grows. We need guardrails that make leakage impossible — not just improbable.

Current repo baseline to preserve while adding guardrails:
- internal project identifiers are Prisma `cuid()` values, not UUIDs
- public API routes typically resolve projects by `slug`, then fan into internal `projectId`

## Design

### 1. Project ID Enforcement

All repository and service methods that accept `projectId` must validate it before any operation.

**Changes:**
- `rag.service.ts` — `getOrCreateTable(projectId)` already exists; add guard that throws `ForbiddenException` if `projectId` is falsy, malformed, or not a valid existing Koda project ID.
- `rag.repository.ts` — all methods accept `projectId string`; add assertion at method entry.
- `tickets.service.ts`, `docs.service.ts`, `rag.service.ts` — every public method that accepts `projectId` must validate it exists and belongs to the caller org.

**Validation rule:** `projectId` must be a non-empty Koda project identifier. In the current schema this is a Prisma CUID that exists in the `projects` table.

### 2. Domain Write Gate — `KodaDomainWriter`

A new service that wraps all agent-initiated writes. Agents never call repositories directly.

```ts
// apps/api/src/memory/domain-writer.service.ts
class KodaDomainWriter {
  constructor(
    private eventLog: EventLogRepository,
    private rag: RagService,
    private outbox: OutboxService,
  ) {}

  // Every write returns a WriteResult with provenance
  async writeTicketEvent(data: TicketEventInput): Promise<WriteResult>
  async writeAgentAction(data: AgentActionInput): Promise<WriteResult>
  async indexDocument(data: IndexDocumentInput): Promise<WriteResult>
  async importGraphify(data: ImportGraphifyInput): Promise<WriteResult>
}
```

**WriteResult shape:**
```ts
interface WriteResult {
  ok: boolean;
  canonicalId?: string;    // canonical truth ID
  derivedIds?: string[];  // IDs in derived stores
  provenance: Provenance;
  error?: string;
}

interface Provenance {
  actorId: string;
  projectId: string;
  action: string;
  timestamp: Date;
  source: 'agent' | 'system' | 'manual';
}
```

**Failure handling:** All writes are transactional on the canonical store. Derived store failures are non-fatal (queued to outbox). The `WriteResult.error` carries the canonical error; derived errors are logged but do not roll back the canonical write.

### 3. Provenance Envelope on Responses

Every API response that includes retrieved context must carry provenance metadata.

**Changes to `SearchKbResponseDto`:**
```ts
class SearchKbResponseDto {
  results!: KbResultDto[];
  provenance!: ResponseProvenance;  // new field
}

class ResponseProvenance {
  projectId!: string;
  retrievedAt!: Date;
  sources!: SourceRef[];  // one per unique source_type + source_id used
}
```

**Changes to `KbResultDto`:**
```ts
class KbResultDto {
  // ...existing fields...
  provenance?: ItemProvenance;  // new optional field
}

class ItemProvenance {
  indexedAt!: Date;
  sourceProjectId!: string;  // cross-check with response projectId
  indexMethod!: 'manual' | 'import' | 'agent';  // how it entered the system
}
```

### Context Files (optional)
- `apps/api/src/rag/rag.service.ts` — integration point for projectId guard
- `apps/api/src/rag/rag.repository.ts` — repository methods to annotate
- `apps/api/src/projects/projects.service.ts` — project existence check pattern

---

## Stories

### US-001: Project ID Hard Enforcement
**Size:** Medium | **AC count:** 6 | **Files:** 3

**ACs:**
- `RagService.getOrCreateTable('')` throws `ForbiddenException` with message `Project ID is required`
- `RagService.getOrCreateTable('not-a-project-id')` throws `ForbiddenException`
- `RagService.getOrCreateTable('cm_invalid_but_well_shaped')` throws `ForbiddenException` when the project does not exist
- `RagService.search()` rejects an invalid `projectId` before any table access occurs
- Every service method that accepts `projectId` has a doc comment `@throws ForbiddenException if projectId is invalid`
- Current slug-routed API endpoints resolve `slug -> projectId` before calling guarded services; any new endpoint that accepts raw `projectId` as a path/query param returns 400 when the value is missing or malformed

### US-002: KodaDomainWriter — Write Gate Service
**Size:** Complex | **AC count:** 8 | **Files:** 5 | **Depends on:** US-001

**ACs:**
- `KodaDomainWriter.writeTicketEvent(data)` writes a record to `ticket_events` canonical table and returns `WriteResult` with `canonicalId`
- `KodaDomainWriter.writeAgentAction(data)` writes a record to `agent_events` canonical table and returns `WriteResult` with `canonicalId`
- `KodaDomainWriter.indexDocument(data)` calls `RagService.indexDocument()` and returns `WriteResult` with `derivedIds`
- `KodaDomainWriter.importGraphify(data)` calls `RagService.importGraphify()` and returns `WriteResult`
- Every `WriteResult` includes a fully populated `provenance` field (actorId, projectId, action, timestamp, source)
- When `writeTicketEvent` is called with a non-existent `projectId`, it throws `ForbiddenException` (not a silent fail)
- When `RagService.indexDocument()` fails during `indexDocument()`, `WriteResult.error` contains the error message but the canonical write (if any) is still committed
- `KodaDomainWriter` is injected into `AgentService` (new or existing) replacing all direct repository calls for write operations

### US-003: Provenance on Search Responses
**Size:** Medium | **AC count:** 6 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `SearchKbResponseDto.provenance` is non-null on every successful search response
- `SearchKbResponseDto.provenance.sources` lists every unique `source_type` + `source_id` pair in the results
- `KbResultDto.provenance.indexedAt` is a valid ISO timestamp
- `KbResultDto.provenance.sourceProjectId` equals the `projectId` of the search request (cross-check)
- When searching with `projectId: 'project-a'`, no result's `provenance.sourceProjectId` is 'project-b'
- `ResponseProvenance.retrievedAt` is within 1 second of the server-side response timestamp

### US-004: Outbox Service (Skeleton)
**Size:** Simple | **AC count:** 4 | **Files:** 2 | **Depends on:** US-002

**ACs:**
- `OutboxService.enqueue(event)` persists an `outbox_events` record with status `pending`
- `OutboxService.processPending()` selects all `pending` records, processes them, and sets status to `completed` or `failed`
- `OutboxService` is called by `KodaDomainWriter` after every canonical write (fire-and-forget, non-blocking)
- Failed outbox events are retried up to 3 times before moving to `dead_letter` status
