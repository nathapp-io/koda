# SPEC: Memory Phase 1 — Canonical + Episodic Foundation

## Summary

Build the durable operational memory layer from ticket events and agent actions. Introduces event tables as the canonical source of truth for all operational state, an outbox-backed sync to derived stores, and a timeline query API for temporal reasoning.

## Motivation

Today, Koda's operational state is spread across prompts and vector chunks. There's no durable record of *what happened*, *who did it*, and *when*. This makes auditability impossible, temporal queries unreliable, and multi-agent coordination blind. Phase 1 lays the durable foundation.

## Design

### 1. Event Tables (Canonical Truth)

```sql
-- apps/api/prisma/schema.prisma additions

model TicketEvent {
  id         String   @id @default(cuid())
  projectId  String
  ticketId   String?
  actorId    String
  action     String   // e.g. 'created', 'status_changed', 'assigned', 'commented'
  payload    Json?    // action-specific data (old_value, new_value, comment_body, etc.)
  createdAt  DateTime @default(now())

  project    Project  @relation(fields: [projectId], references: [id])
  @@index([projectId, createdAt])
  @@index([projectId, ticketId])
}

model AgentEvent {
  id         String   @id @default(cuid())
  projectId  String
  actorId    String
  intent     String   // e.g. 'answer', 'diagnose', 'plan', 'update'
  action     String   // e.g. 'search', 'write', 'import'
  result     String   // 'success', 'partial', 'failure'
  metadata   Json?    // tokens_used, retrieved_sources, error_message, etc.
  createdAt  DateTime @default(now())

  project    Project  @relation(fields: [projectId], references: [id])
  @@index([projectId, createdAt])
  @@index([projectId, actorId])
}

model DecisionEvent {
  id         String   @id @default(cuid())
  projectId  String
  actorId    String
  topic      String   // e.g. 'architecture', 'release', 'ticket-approach'
  decision   String   // the decision text
  rationale  String?
  status     String   @default('active')  // 'active', 'superseded', 'rejected'
  supersededBy String?
  createdAt  DateTime @default(now())

  project    Project  @relation(fields: [projectId], references: [id])
  @@index([projectId, createdAt])
}
```

### 2. Outbox Pattern (Derived Store Sync)

The outbox is the bridge between canonical writes and derived memory stores. Every canonical write publishes an outbox event; a background processor fans out to vector, graph, and semantic indexes.

**Persistence:** The outbox is backed by the `OutboxEvent` Prisma table (§4 above). It is not in-memory — a restart does not lose pending events.

```ts
// apps/api/src/memory/outbox.service.ts
class OutboxService {
  constructor(private prisma: PrismaService) {}

  async enqueue(eventType: string, eventId: string, projectId: string, payload: Json): Promise<OutboxEvent>
  async processPending(limit?: number): Promise<ProcessResult>
  async markCompleted(eventId: string): Promise<void>
  async markFailed(eventId: string, error: string): Promise<void>
  async markDeadLetter(eventId: string, reason: string): Promise<void>
  async retryEvent(eventId: string): Promise<void>   // admin-only: reset dead_letter back to pending
}
```

**Fan-out registry (lazy, Phase 2-4 services register themselves):**
```ts
// apps/api/src/memory/outbox-fan-out.ts
type FanOutHandler = (event: OutboxEvent) => Promise<void>;

class OutboxFanOutRegistry {
  private handlers: Map<string, FanOutHandler[]> = new Map();

  register(eventType: string, handler: FanOutHandler): void
  async dispatch(event: OutboxEvent): Promise<void>   // calls all handlers for event.eventType
}

// Handler responsibilities per event type:
const DEFAULT_HANDLERS: Array<{ eventType: string; handler: FanOutHandler }> = [
  // Phase 2 — Hybrid Retrieval
  { eventType: 'document_indexed',   handler: 'LexicalIndex.addDocument' },
  { eventType: 'document_indexed',   handler: 'EntityStore.indexEntity' },
  // Phase 2 — rebuild BM25 index on bulk operations
  { eventType: 'graphify_import',    handler: 'LexicalIndex.buildIndex' },   // full rebuild after import
  // Phase 3 — Semantic Memory extraction
  { eventType: 'ticket_event',        handler: 'ExtractionService.extractFromEvent' },
  { eventType: 'agent_event',         handler: 'ExtractionService.extractFromEvent' },
  // Phase 4 — Entity graph
  { eventType: 'ticket_event',        handler: 'EntityGraphService.onTicketEvent' },
  { eventType: 'graphify_import',    handler: 'EntityGraphService.onGraphifyImport' },
  // Phase 4 — Code intel
  { eventType: 'code_commit',         handler: 'AstIndexService.indexCommit' },
  // Phase 4 — Graph diff (replaces full re-import)
  { eventType: 'graphify_import',    handler: 'IncrementalGraphDiffService.diffAndApply' },
];
```

**Sync strategy:** The outbox processor runs as a scheduled job (every 5 seconds). Events are processed in order within a project (FIFO by `createdAt`). Concurrent processing across projects is allowed.

**Retry:** Failed events retry up to 3 times with exponential backoff (1s, 4s, 16s). After 3 failures → `dead_letter`.

### 3. Timeline Query API

```ts
// apps/api/src/memory/timeline.service.ts
class TimelineService {
  constructor(private eventLog: EventLogRepository) {}

  async getProjectTimeline(query: TimelineQuery): Promise<TimelineResponse>
  async getTicketHistory(ticketId: string): Promise<TicketHistoryResponse>
  async getAgentActivity(actorId: string, projectId: string): Promise<AgentActivityResponse>
}

interface TimelineQuery {
  projectId: string;
  actorId?: string;
  eventTypes?: string[];
  from?: Date;
  to?: Date;
  limit?: number;   // default 50, max 200
  cursor?: string;  // for pagination
}

interface TimelineResponse {
  events!: Array<{
    id: string;
    eventType: string;
    actorId: string;
    action: string;
    payload: Json;
    createdAt: Date;
  }>;
  nextCursor?: string;
  total?: number;   // total count matching query
}
```

### 4. OutboxEvent Record Schema (Canonical Outbox Table)

The outbox is a persistence table — not just an in-memory queue. This is the Prisma model:

```sql
-- apps/api/prisma/schema.prisma additions

model OutboxEvent {
  id          String   @id @default(cuid())
  projectId   String
  eventType   String   // 'ticket_event' | 'agent_event' | 'decision_event' | 'graphify_import' | 'code_commit' | 'document_indexed'
  eventId     String   // ID of the canonical record this originated from
  payload     Json
  status      String   @default("pending")  // 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter'
  attempts    Int      @default(0)
  lastError   String?
  createdAt   DateTime @default(now())
  processedAt DateTime?

  @@index([status, createdAt])        // for processPending() selection
  @@index([projectId, createdAt])     // for FIFO ordering per project
}
```

**`eventType` enum (complete list):**
| Value | Triggered by |
|-------|-------------|
| `ticket_event` | `TicketEvent` created |
| `agent_event` | `AgentEvent` created |
| `decision_event` | `DecisionEvent` created |
| `graphify_import` | `RagService.importGraphify()` called |
| `code_commit` | VCS webhook fires on commit push |
| `document_indexed` | `RagService.indexDocument()` called |
| `symbol_indexed` | `AstIndexService.indexCommit()` completes |

### 5. Auth / Permissions Model

Koda is multi-tenant. All access is scoped to a `projectId`. This spec defines only the access-control model; individual endpoints opt in to specific roles.

**Bridge from current repo state:** Today Koda has global `User.role` values (`ADMIN` / `MEMBER`), agent role/capability tables, and project routes that usually key by `slug`. This phase introduces a project-scoped actor abstraction for memory features, but it must be implemented as a resolver/mapping layer first rather than assuming the normalized role model already exists everywhere.

```ts
// apps/api/src/auth/auth.types.ts

// Role hierarchy used by the memory subsystem after resolution from current auth state
type ActorRole = 'admin' | 'developer' | 'agent' | 'viewer';

interface Actor {
  actorId: string;
  projectId: string;   // all actors are scoped to one project
  role: ActorRole;
  agentId?: string;    // set when role='agent', identifies the agent instance
}

// Permission matrix
const Permissions = {
  // Read
  'timeline:read':       ['admin', 'developer', 'agent', 'viewer'],
  'memory:read':         ['admin', 'developer', 'agent', 'viewer'],
  'documents:search':    ['admin', 'developer', 'agent', 'viewer'],
  'codeintel:read':      ['admin', 'developer', 'agent'],

  // Write
  'ticket:write':        ['admin', 'developer', 'agent'],
  'decision:record':     ['admin', 'developer', 'agent'],
  'graphify:import':     ['admin', 'developer', 'agent'],
  'symbol:index':        ['admin', 'developer'],   // not agents (system-triggered only)

  // Admin
  'outbox:read':         ['admin'],
  'outbox:retry':       ['admin'],
  'slos:read':          ['admin'],
  'gate:run':           ['admin'],
} as const;

type Permission = keyof typeof Permissions;

function can(role: ActorRole, permission: Permission): boolean {
  return (Permissions[permission] as ActorRole[]).includes(role);
}

interface ActorResolver {
  resolveFromRequest(input: {
    userRole?: 'ADMIN' | 'MEMBER';
    agentId?: string;
    projectSlug?: string;
  }): Promise<Actor>;
}
```

**Actor extraction:** `actorId` and resolved `projectId` are extracted from the request context (JWT claims or API key metadata) plus project slug resolution. Agents identify themselves via an `X-Agent-Id` header. `ActorResolver` is responsible for mapping current Koda auth into the phase role model before permission checks run.

**Error response envelope (standardized across all endpoints):**
```ts
// apps/api/src/common/errors.ts
class KodaError extends Error {
  constructor(
    public readonly code: string,          // machine-readable, e.g. 'PROJECT_NOT_FOUND'
    public readonly message: string,       // human-readable
    public readonly details?: unknown,      // extra context (field errors, etc.)
    public readonly httpStatus: number = 500,
  ) {}
}

// Typed subclasses
class ForbiddenError    extends KodaError { constructor(msg: string, details?: unknown) { super('FORBIDDEN',         msg, details, 403); } }
class NotFoundError     extends KodaError { constructor(msg: string, details?: unknown) { super('NOT_FOUND',          msg, details, 404); } }
class ValidationError   extends KodaError { constructor(msg: string, details?: unknown) { super('VALIDATION_ERROR',   msg, details, 400); } }
class ProjectNotFoundError extends KodaError { constructor(projectId: string) { super('PROJECT_NOT_FOUND', `Project '${projectId}' not found`, undefined, 404); } }
class UnauthorizedError  extends KodaError { constructor(msg: string) { super('UNAUTHORIZED', msg, undefined, 401); } }

// All KodaError subclasses serialize to:
interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;  // for tracing
  }
}
```

**Global exception filter:** NestJS `ExceptionFilter` catches all `KodaError` subclasses and returns the `ErrorEnvelope`. Non-Koda errors return a generic 500 `ErrorEnvelope` with `code: 'INTERNAL_ERROR'`.

### Context Files (optional)
- `apps/api/prisma/schema.prisma` — schema additions
- `apps/api/src/rag/rag.service.ts` — RagService interface to call from outbox fan-out
- `apps/api/src/projects/projects.service.ts` — pattern to follow for repository-per-resource
- `apps/api/src/common/errors.ts` — standardized error types (new file)

---

## Stories

### US-001: Event Tables Schema + Prisma Migration
**Size:** Simple | **AC count:** 5 | **Files:** 2 | **Depends on:** SPEC-000/US-001

**ACs:**
- Prisma migration creates `TicketEvent`, `AgentEvent`, `DecisionEvent` tables with the schema defined above
- Migration is idempotent (can be applied multiple times without error)
- Each table has a non-null `projectId` foreign key to `Project`
- Each table has `@@index([projectId, createdAt])` as a composite index
- `prisma validate` passes after migration application

### US-002: Event Write Operations + Auth
**Size:** Medium | **AC count:** 8 | **Files:** 4 | **Depends on:** US-001, SPEC-000/US-002

**ACs:**
- `TicketEventService.create(data)` writes to `TicketEvent` and returns the created record
- `AgentEventService.create(data)` writes to `AgentEvent` and returns the created record
- `DecisionEventService.create(data)` writes to `DecisionEvent` and returns the created record
- All three services are called by `KodaDomainWriter` after relevant operations (ticket actions → TicketEvent, agent queries → AgentEvent, explicit decisions → DecisionEvent)
- Event creation is included in the `WriteResult.provenance` output
- Creating an event with a non-existent `projectId` throws `ForbiddenError` (`code: 'PROJECT_NOT_FOUND'`)
- `ActorResolver` maps current Koda auth (`User.role`, agent credentials, and project slug context) into the phase actor model before any permission check runs
- Only actors with role `admin`, `developer`, or `agent` on the target project can call event write operations (role checked before `KodaDomainWriter` entry)
- `GET /admin/outbox` requires role `admin` and returns 403 for all other roles

### US-003: Outbox Service — Enqueue + Process
**Size:** Complex | **AC count:** 8 | **Files:** 4 | **Depends on:** US-002, SPEC-000/US-004

**ACs:**
- `OutboxService.enqueue(eventType, eventId, projectId, payload)` persists an `OutboxEvent` record with `status = 'pending'` and returns the created record
- `OutboxService.processPending(limit?)` picks up to `limit` (default 50) `pending` events ordered by `createdAt ASC`
- After successful fan-out, `OutboxService.markCompleted()` sets status to `completed'` and populates `processedAt`
- After 3 failed attempts, `OutboxService.markDeadLetter()` sets status to `dead_letter'` and records `lastError`
- `KodaDomainWriter` calls `OutboxService.enqueue()` after every canonical write (synchronously, before returning)
- The outbox processor job runs on a schedule (cron or `setInterval`) and is idempotent (re-running a completed event is safe — skips events already `completed' or `processing'`)
- If `OutboxFanOutRegistry.dispatch()` throws, the event is marked failed and retried (not dead-lettered on first failure)
- Dead-lettered events are queryable via `GET /admin/outbox?status=dead_letter` (admin-only, role checked)

### US-004: Timeline Query API
**Size:** Medium | **AC count:** 7 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `GET /projects/:slug/timeline` returns events filtered by `from`, `to`, `actorId`, `eventTypes` (query params)
- `GET /projects/:slug/timeline?ticketId=X` returns all TicketEvents for that ticket, newest first
- `GET /projects/:slug/timeline?actorId=X` returns all events by that actor
- Results are paginated via `cursor` (last event ID returned as `nextCursor`)
- `GET /projects/:slug/timeline` without filters returns the last 50 events
- Timeline results include all fields from the event record plus a computed `eventType` field
- Requesting timeline for a non-existent or unauthorized project returns 403 after slug resolution

### US-006: Outbox Fan-Out Registry + Phase 2–4 Handler Wiring
**Size:** Complex | **AC count:** 8 | **Files:** 5 | **Depends on:** US-003, SPEC-002/US-001, SPEC-002/US-002, SPEC-003/US-001, SPEC-004/US-001

> **Note:** This story exists in Phase 1 because Phase 2–4 services register their fan-out handlers at startup. Without this story, later phases' handlers are never wired to the outbox dispatcher.

**ACs:**
- `OutboxFanOutRegistry.register(eventType, handler)` adds a handler and it is called on subsequent `dispatch()` calls for that `eventType`
- Calling `register()` for the same `eventType` twice adds both handlers (not replaces)
- On app startup, all handlers from `DEFAULT_HANDLERS` are registered via `OutboxFanOutRegistry.register()`
- When `dispatch()` is called with `eventType='ticket_event'`, all handlers registered for `ticket_event` are executed in registration order (sequential, not parallel)
- If a handler throws, the error is caught, logged, and the next handler runs (one handler failure does not stop others)
- The `document_indexed` event includes `{ sourceId, content, metadata }` as `payload` — sufficient for `LexicalIndex.addDocument()` to work without additional lookups
- The `graphify_import` event includes `{ projectId, nodeCount, linkCount }` as `payload` — sufficient for `EntityGraphService.onGraphifyImport()` to work
- Handler registration is testable: a test can `register()` a mock handler and assert it is called when `dispatch()` fires

### US-007: OutboxEvent Table Migration (Idempotent)
**Size:** Simple | **AC count:** 4 | **Files:** 2 | **Depends on:** US-001

**ACs:**
- Prisma migration creates `OutboxEvent` table with all fields defined in §4
- Migration uses `@@index([status, createdAt])` and `@@index([projectId, createdAt])`
- Migration is idempotent (can be `apply`ed twice without error)
- Migration does NOT drop or alter existing tables (`TicketEvent`, `AgentEvent`, `DecisionEvent` remain intact)
- `prisma validate` passes after migration application

### US-005: Temporal Context in Agent Responses
**Size:** Medium | **AC count:** 5 | **Files:** 2 | **Depends on:** US-004

**ACs:**
- When `getProjectContext()` is called with `intent: 'diagnose'`, the response includes a `recentEvents` block with the last 10 relevant events
- When `getProjectContext()` is called with `intent: 'answer'` and the query references a ticket ID, the response includes that ticket's status change history
- The `recentEvents` block in context uses `TimelineService.getProjectTimeline()` internally
- `recentEvents` in context is ordered by `createdAt DESC` and includes `actorId`, `action`, and `createdAt` for each event
- The temporal block is excluded from context when `intent: 'plan'` (performance — timeline is large)
