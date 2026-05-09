# Koda API — Deep Code Review Report

**Date:** 2026-05-09  
**Reviewer:** Claude Code (automated deep review)  
**Scope:** Full codebase — `apps/api/src`, `apps/api/prisma`  
**Categories:** Security · Memory Leaks · Performance

---

## Table of Contents

1. [Summary](#summary)
2. [Security](#security)
   - [CRITICAL](#security-critical)
   - [HIGH](#security-high)
   - [MEDIUM](#security-medium)
3. [Memory Leaks](#memory-leaks)
   - [CRITICAL](#memory-critical)
   - [HIGH](#memory-high)
   - [MEDIUM](#memory-medium)
4. [Performance](#performance)
   - [HIGH](#performance-high)
   - [MEDIUM](#performance-medium)
5. [Prioritised Action List](#prioritised-action-list)
6. [Positive Findings](#positive-findings)

---

## Summary

| Category | CRITICAL | HIGH | MEDIUM | TOTAL |
|----------|:--------:|:----:|:------:|:-----:|
| Security | 2 | 1 | 5 | **8** |
| Memory Leaks | 3 | 2 | 4 | **9** |
| Performance | 0 | 4 | 9 | **13** |
| **Total** | **5** | **7** | **18** | **30** |

---

## Security

### Security — CRITICAL

#### S1 · Unauthenticated Webhook Registration and Deletion

**File:** `apps/api/src/webhook/webhook.controller.ts` lines 25–59  
**Severity:** CRITICAL

Both the `POST /projects/:slug/webhooks` and `DELETE /api/webhooks/:id` endpoints are decorated with `@Public()` and have no auth guard or permission check. Any unauthenticated caller can:

- Register arbitrary webhooks pointing to attacker-controlled URLs to exfiltrate project events.
- Delete existing webhooks to silently disrupt integrations.

**Current code:**
```typescript
@Post('projects/:slug/webhooks')
@HttpCode(201)
@Public()
async register(@Param('slug') slug: string, @Body() dto: CreateWebhookDto) { ... }

@Delete('api/webhooks/:id')
@HttpCode(204)
@Public()
async remove(@Param('id') id: string) { ... }
```

**Fix:**
```typescript
@Post('projects/:slug/webhooks')
@HttpCode(201)
@RequiredPermission([CaslPermissionAction.CREATE, 'Webhook'])
async register(
  @Param('slug') slug: string,
  @Body() dto: CreateWebhookDto,
  @Principal() principal: KodaPrincipal,
) { ... }

@Delete('api/webhooks/:id')
@HttpCode(204)
@RequiredPermission([CaslPermissionAction.DELETE, 'Webhook'])
async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal) { ... }
```

---

#### S2 · CI Webhook Endpoint Has No Signature Verification

**File:** `apps/api/src/ci-webhook/ci-webhook.controller.ts` lines 13–26  
**Severity:** CRITICAL

The `POST /projects/:slug/ci-webhook` endpoint is `@Public()` with no HMAC signature check. An attacker can forge CI failure events to auto-create arbitrary tickets with malicious content, spam the system, or bypass CI security gates entirely.

**Fix:** Mirror the VCS webhook pattern — require an `x-ci-signature` header and verify it with HMAC-SHA256 before processing the payload.

```typescript
@Post('projects/:slug/ci-webhook')
@HttpCode(200)
@Public()
async handleCiWebhook(
  @Param('slug') slug: string,
  @Body() payload: CiWebhookPayloadDto,
  @Headers('x-ci-signature') signature?: string,
) {
  const secret = await this.ciWebhookService.getSecret(slug);
  if (!secret) throw new AuthException({}, 'ci_webhook');
  const valid = this.webhookService.verifySignature(JSON.stringify(payload), signature ?? '', secret);
  if (!valid) throw new AuthException({}, 'ci_webhook');
  ...
}
```

---

### Security — HIGH

#### S3 · Raw SQL Query With String Interpolation

**File:** `apps/api/src/rag/entity-store.ts` lines 154–156  
**Severity:** HIGH

`$queryRaw` is used with a tagged template literal that interpolates `${projectId}`. While Prisma's tagged template provides parameterisation, the pattern is fragile and deviates from type-safe query builders. If refactored carelessly (e.g. switching to a string argument), it becomes a direct SQL injection vector.

**Current code:**
```typescript
const docs = await this.prisma.client.$queryRaw<...>`
  SELECT id, label, type, source_file FROM code_document WHERE project_id = ${projectId}
`;
```

**Fix:**
```typescript
const docs = await this.prisma.client.codeDocument.findMany({
  where: { projectId },
  select: { id: true, label: true, type: true, sourceFile: true },
});
```

---

### Security — MEDIUM

#### S4 · VCS Webhook Secret Null-Bypass

**File:** `apps/api/src/vcs/vcs-webhook.controller.ts` lines 33–41  
**Severity:** MEDIUM

If `connection.webhookSecret` is `null` or `undefined`, the HMAC compare becomes `verifySignature(body, '', '')`. An attacker sending a request with an empty or absent `x-signature` header will pass verification.

**Fix:**
```typescript
if (!connection.webhookSecret) {
  throw new AuthException({}, 'vcs_webhook');
}
const isValid = this.webhookService.verifySignature(
  JSON.stringify(payload),
  signature,
  connection.webhookSecret,
);
```

---

#### S5 · Full Principal Serialised Into Debug Log

**File:** `apps/api/src/auth/guards/combined-auth.guard.ts` line 38  
**Severity:** MEDIUM

`JSON.stringify(request['user'])` writes the complete principal object (including roles and potential PII) to debug logs, which may be captured by log aggregators or surfaced in observability tooling.

**Fix:**
```typescript
this.combinedLogger.debug(`API key auth succeeded, userId=${(request['user'] as KodaPrincipal)?.id}`);
```

---

#### S6 · Webhook Secret Has No Minimum-Length Constraint

**File:** `apps/api/src/webhook/webhook.dto.ts`  
**Severity:** MEDIUM

`secret` is validated only with `@IsString()`. A 1-character secret trivially weakens HMAC-based webhook verification.

**Fix:**
```typescript
@IsString()
@MinLength(32, { message: 'Webhook secret must be at least 32 characters' })
secret!: string;
```

---

#### S7 · Password Validation — Minimum Length Only

**File:** `apps/api/src/auth/dto/register.dto.ts` line 16  
**Severity:** MEDIUM

Password is accepted at 8 characters with no complexity requirement. Modern NIST guidance recommends at least 12 characters and a breach-corpus check.

**Fix:**
```typescript
@IsString()
@MinLength(12)
@Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/, {
  message: 'Password must include uppercase, lowercase, number, and symbol',
})
declare password: string;
```

---

#### S8 · JWT Default Expiry Window Is Too Long

**File:** `apps/api/src/auth/auth.module.ts` lines 26–36  
**Severity:** MEDIUM

Default access token expiry is `7d` and refresh token is `30d`. A stolen access token is valid for a full week without any revocation mechanism.

**Fix:** Reduce defaults:
```typescript
expiresIn: authConfig?.jwtExpiresIn ?? '15m',        // access token
expiresIn: authConfig?.jwtRefreshExpiresIn ?? '7d',  // refresh token
```

---

## Memory Leaks

### Memory — CRITICAL

#### M1 · VcsPollingService — Intervals Never Cleared on Shutdown

**File:** `apps/api/src/vcs/vcs-polling.service.ts` lines 31, 88  
**Severity:** CRITICAL

The service implements `OnModuleInit` but **not** `OnModuleDestroy`. One `setInterval` is registered per VCS connection via `SchedulerRegistry.addInterval()`. On application shutdown or module reload, these intervals keep running, preventing GC and consuming CPU.

**Fix:**
```typescript
export class VcsPollingService implements OnModuleInit, OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    const connections = await this.db.vcsConnection.findMany({
      where: { syncMode: 'polling', isActive: true },
    });
    for (const conn of connections) {
      this.unschedulePolling(conn.id);
    }
  }
}
```

---

#### M2 · CronOptimizeStrategy — setInterval Not Cleared in onDestroy

**File:** `apps/api/src/rag/strategies/cron-optimize.strategy.ts` lines 25–28  
**Severity:** CRITICAL

A `setInterval` is created in the constructor and registered with `SchedulerRegistry`. The `onDestroy()` method exists but does **not** call `clearInterval`. The closure captures `this`, keeping the entire strategy object alive.

**Fix:**
```typescript
export class CronOptimizeStrategy implements FtsOptimizeStrategy {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(...) {
    this.intervalId = setInterval(() => void this.optimizeDirtyTables(), this.intervalMs);
    this.schedulerRegistry.addInterval('fts-optimize', this.intervalId);
  }

  async onDestroy(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    await this.optimizeDirtyTables();
  }
}
```

---

#### M3 · CacheManager — Expired Entries Never Evicted; lruSize Unused

**File:** `apps/api/src/cache/cache.module.ts` lines 36–37  
**Severity:** CRITICAL

`CacheManager` stores all entries in an unbounded `Map<string, CacheEntry>`. The `get()` method checks TTL on read but **never removes the stale entry**. The `lruSize` configuration option is parsed but never enforced. Over time the map grows without bound.

**Fix:**
```typescript
@Injectable()
export class CacheManager implements OnModuleDestroy {
  private readonly store = new Map<string, CacheEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly maxSize: number;

  constructor(options: CacheModuleMemoryOptions) {
    this.maxSize = options.lruSize ?? 10_000;
    this.cleanupInterval = setInterval(() => this.evict(), 60_000);
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.deleteKey(key);
    }
    // LRU eviction when over capacity
    if (this.store.size > this.maxSize) {
      const overflow = this.store.size - this.maxSize;
      [...this.store.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, overflow)
        .forEach(([k]) => this.deleteKey(k));
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.store.clear();
    this.tagIndex.clear();
  }
}
```

---

### Memory — HIGH

#### M4 · VcsWebhookService — recentCommitHashes Cleanup Is Passive Only

**File:** `apps/api/src/vcs/vcs-webhook.service.ts` lines 110, 622–625  
**Severity:** HIGH

Stale entries in `recentCommitHashes` are cleaned up inside `handlePush()`. During idle periods (no incoming webhooks) the map is never swept, so hash entries accumulate indefinitely.

**Fix:** Add a background interval and implement `OnModuleDestroy`:
```typescript
export class VcsWebhookService implements OnModuleDestroy {
  private cleanupInterval = setInterval(() => this.cleanupStaleEntries(), 5 * 60_000);

  private cleanupStaleEntries(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [key, ts] of this.recentCommitHashes) {
      if (ts < cutoff) this.recentCommitHashes.delete(key);
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.recentCommitHashes.clear();
  }
}
```

---

#### M5 · HybridRetrieverService — graphifyEnabledCache Never Pruned

**File:** `apps/api/src/rag/hybrid-retriever.service.ts` lines 76, 486  
**Severity:** HIGH

`resolveGraphifyEnabled()` stores per-project TTL entries, but expired entries are only **overwritten** on the next access — they are never deleted. With thousands of projects the cache grows proportionally to the distinct project count, never shrinking.

**Fix:** Delete the stale entry on miss and add an `onModuleDestroy` sweep:
```typescript
private async resolveGraphifyEnabled(projectId: string): Promise<boolean> {
  const cached = this.graphifyEnabledCache.get(projectId);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    this.graphifyEnabledCache.delete(projectId); // delete stale
  }
  const value = await this.fetchGraphifyEnabled(projectId);
  this.graphifyEnabledCache.set(projectId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

async onModuleDestroy(): Promise<void> {
  this.tableCache.clear();
  this.graphifyEnabledCache.clear();
}
```

---

### Memory — MEDIUM

#### M6 · OutboxFanOutRegistry — No Handler Deduplication or Removal

**File:** `apps/api/src/outbox/outbox-fan-out-registry.ts` lines 199–203  
**Severity:** MEDIUM

`register()` always appends to the handler array without deduplication. On hot reload or repeated module initialisation, the same closure (capturing the old service instance) is added again. Old instances are kept alive through these closures.

**Fix:**
```typescript
register(eventType: string, handler: OutboxHandler): void {
  const existing = this.handlers.get(eventType) ?? [];
  if (!existing.includes(handler)) {
    this.handlers.set(eventType, [...existing, handler]);
  }
}

unregister(eventType: string, handler: OutboxHandler): void {
  const filtered = (this.handlers.get(eventType) ?? []).filter(h => h !== handler);
  filtered.length ? this.handlers.set(eventType, filtered) : this.handlers.delete(eventType);
}
```

---

#### M7 · LexicalIndex — Per-Project BM25 Indexes Never Evicted

**File:** `apps/api/src/rag/lexical-index.ts` lines 41, 237–250  
**Severity:** MEDIUM

Once a project's BM25 index is created it is never removed, even after the project is deleted or goes inactive. Memory grows linearly with the number of distinct projects ever queried.

**Fix:** Implement LRU eviction with a configurable max (e.g. 1 000 project indexes):
```typescript
private readonly MAX_INDEXES = 1_000;
private readonly lastAccessed = new Map<string, number>();

private getOrCreateProjectIndex(projectId: string): ProjectIndex {
  this.lastAccessed.set(projectId, Date.now());
  if (!this.indexes.has(projectId)) {
    if (this.indexes.size >= this.MAX_INDEXES) this.evictOldest();
    this.indexes.set(projectId, this.emptyIndex());
  }
  return this.indexes.get(projectId)!;
}

private evictOldest(): void {
  const oldest = [...this.lastAccessed.entries()].sort((a, b) => a[1] - b[1])[0];
  if (oldest) { this.indexes.delete(oldest[0]); this.lastAccessed.delete(oldest[0]); }
}
```

---

#### M8 · EntityStore — Nested Entity Maps Grow Without Bound

**File:** `apps/api/src/rag/entity-store.ts` lines 25, 32–39  
**Severity:** MEDIUM

`Map<projectId, Map<entityId, Entity>>` is never cleared. Deleted or inactive projects retain their entity maps indefinitely.

**Fix:** Expose a `clear(projectId)` method and call it from the project-deletion event handler.

---

#### M9 · CounterOptimizeStrategy — counters Map Entries Never Removed

**File:** `apps/api/src/rag/strategies/counter-optimize.strategy.ts` lines 12, 18–30  
**Severity:** MEDIUM

Counter entries for deleted or inactive projects remain in the `counters` Map. Add explicit cleanup:

```typescript
async onDestroy(): Promise<void> {
  this.counters.clear();
}

clearProject(projectId: string): void {
  this.counters.delete(projectId);
}
```

---

## Performance

### Performance — HIGH

#### P1 · N+1: Sequential Graph Node/Link Writes

**File:** `apps/api/src/rag/graph-store.service.ts` lines 54–72, 80–89, 118–122  
**Severity:** HIGH

Node upserts, link creates, and link deletes are each executed **one at a time inside a loop**, producing O(n) database round-trips per import operation. A single import of 500 nodes generates 500+ sequential queries.

**Fix:** Use a single `$transaction` with batched operations:
```typescript
await this.prisma.client.$transaction([
  ...nodes.map(node => this.prisma.client.graphNode.upsert({ where: ..., update: ..., create: ... })),
  ...links.map(link => this.prisma.client.graphLink.create({ data: link })),
]);
```
For very large batches, chunk into groups of 500.

---

#### P2 · N+1: Sequential Agent Role and Capability Inserts

**File:** `apps/api/src/agents/agents.service.ts` lines 172–188  
**Severity:** HIGH

Agent role and capability entries are created one per loop iteration. Replace with `createMany()` inside a transaction:
```typescript
await this.db.$transaction([
  this.db.agentRoleEntry.createMany({ data: validatedRoles.map(r => ({ agentId, role: r })) }),
  this.db.agentCapabilityEntry.createMany({ data: capabilities.map(c => ({ agentId, capability: c })) }),
]);
```

---

#### P3 · N+1: Per-Symbol Entity Graph Lookups

**File:** `apps/api/src/code-intel/impact-analysis.service.ts` lines 165–182, 224–245  
**Severity:** HIGH

`getRelatedEntities()` is called once per symbol/service inside a sequential loop. For a file with 100 symbols this produces 100+ sequential database calls on every impact analysis request.

**Fix:** Collect all IDs first, then batch-load with a single `IN` query:
```typescript
const allIds = symbols.map(s => s.id);
const allRelated = await this.entityGraph.getRelatedEntitiesBatch(projectId, allIds, 1);
```

---

#### P4 · Missing Database Indexes on Core Models

**File:** `apps/api/prisma/schema.prisma`  
**Severity:** HIGH

The following frequently-filtered columns have no index, causing full-table scans as data grows:

| Model | Missing Indexes |
|-------|----------------|
| `Ticket` | `@@index([projectId, status])`, `@@index([projectId, assignedToUserId])`, `@@index([projectId, assignedToAgentId])`, `@@index([externalVcsId])` |
| `Comment` | `@@index([ticketId])`, `@@index([authorUserId])` |
| `TicketActivity` | `@@index([ticketId])`, `@@index([ticketId, createdAt])` |
| `TicketLink` | `@@index([externalRef])` |
| `VcsSyncLog` | `@@index([vcsConnectionId, createdAt])` |

**Example fix in schema:**
```prisma
model Ticket {
  // ... existing fields ...
  @@index([projectId, status])
  @@index([projectId, assignedToUserId])
  @@index([projectId, assignedToAgentId])
  @@index([externalVcsId])
}
```

---

### Performance — MEDIUM

#### P5 · Sequential Async Loops in Context Builder

**File:** `apps/api/src/context/context-builder.service.ts` lines 241–252, 255–272  
**Severity:** MEDIUM

`getRelatedEntities()` is called per ticket and `getChangeImpact()` per repo ref in sequential `for` loops. These are independent calls and can be parallelised.

**Fix:**
```typescript
const paths = await Promise.all(ticketIds.map(id => this.entityGraph.getRelatedEntities(projectId, id, 2)));
const impacts = await Promise.all(repoRefs.map(ref => this.impactAnalysisService.getChangeImpact({ ...ref })));
```

---

#### P6 · No Timeout on External fetch() Calls

**Files and lines:**

| File | Line | External Target |
|------|------|----------------|
| `apps/api/src/rag/providers/openai-embedding.provider.ts` | 14, 30 | OpenAI API |
| `apps/api/src/rag/providers/ollama-embedding.provider.ts` | 17 | Local Ollama |
| `apps/api/src/vcs/factory.ts` | 37, 52 | GitHub / GitLab API |

**Severity:** MEDIUM

None of these `fetch()` calls set a timeout. A slow or unresponsive upstream will hang the request indefinitely, exhausting the connection pool.

**Fix:**
```typescript
// OpenAI / GitHub (external network)
signal: AbortSignal.timeout(30_000)

// Ollama (local service)
signal: AbortSignal.timeout(10_000)
```

---

#### P7 · Redundant JSON.stringify in Token Estimation

**File:** `apps/api/src/context/context-builder.service.ts` lines 147, 157, 283–286  
**Severity:** MEDIUM

The same large context objects are serialised multiple times in `enforceTokenBudget()` to estimate token counts. Each `JSON.stringify` on a large payload is a blocking CPU operation.

**Fix:** Serialise once and pass the string to `estimateTokenCount`:
```typescript
const serialised = JSON.stringify(ctx);
const totalTokens = estimateTokenCount(serialised);
```
Or cache the token count alongside the object when it is first constructed.

---

#### P8 · JSON.parse Per Webhook in Filter Loop

**File:** `apps/api/src/webhook/webhook-dispatcher.service.ts` lines 18–22, 38  
**Severity:** MEDIUM

`JSON.parse(webhook.events)` is called once per webhook inside the filter loop. With N registered webhooks this is N parse operations per dispatch event. The payload is also re-stringified per webhook.

**Fix:**
```typescript
// Parse once per webhook at load time; stringify payload once before the loop
const body = JSON.stringify(payload);
for (const webhook of matchingWebhooks) {
  await this.send(webhook, body);
}
```

---

#### P9 · JSON.parse in Outbox Hot Path

**File:** `apps/api/src/outbox/outbox.service.ts` line 66  
**Severity:** MEDIUM

Every outbox event triggers `JSON.parse(String(event.payload ?? '{}'))`. The outbox may process hundreds of events per second; this is a per-event CPU cost.

**Fix:** Store the payload pre-parsed, or parse once at retrieval time and carry the parsed object through the processing pipeline.

---

#### P10 · Unbounded findMany() Without Pagination

**Files:**

| File | Lines | Query |
|------|-------|-------|
| `apps/api/src/rag/graph-store.service.ts` | 19–20 | `graphNode.findMany` / `graphLink.findMany` |
| `apps/api/src/memory/canonical-state.service.ts` | 134–145, 198–210 | `ticketEvent.findMany`, `memoryItem.findMany` |
| `apps/api/src/code-intel/impact-analysis.service.ts` | 197–212 | `entityLink.findMany`, `entityNode.findMany` |

**Severity:** MEDIUM

None of these queries have a `take` limit. For large projects these will load entire tables into memory, potentially causing OOM.

**Fix:** Add `take: limit` (and cursor pagination if needed) to all unbounded `findMany` calls. For graph data, enforce a hard cap of e.g. `take: 10_000`.

---

#### P11 · Synchronous File Read at Module Load Time

**File:** `apps/api/src/retrieval/load-queries.ts` lines 14–15  
**Severity:** MEDIUM

`readFileSync` is called during module initialisation, blocking the Node.js event loop on startup.

**Fix:** Switch to async lazy loading:
```typescript
let cachedQueries: EvalQuery[] | null = null;

export async function loadEvalQueries(): Promise<EvalQuery[]> {
  if (!cachedQueries) {
    const raw = await readFile(fixturePath, 'utf-8');
    cachedQueries = JSON.parse(raw) as EvalQuery[];
  }
  return cachedQueries;
}
```

---

#### P12 · Re-fetch After Update in Agents Service

**File:** `apps/api/src/agents/agents.service.ts` lines 147–150  
**Severity:** MEDIUM (low complexity fix)

An agent is updated, then immediately re-fetched in a separate query to include relations. The `update` call can return relations directly.

**Fix:**
```typescript
const agent = await this.db.agent.update({
  where: { id },
  data: { ... },
  include: { roles: true, capabilities: true },
});
```

---

## Prioritised Action List

### Immediate — Block on these

| # | Item | Severity |
|---|------|----------|
| 1 | Add auth + permission guards to webhook `POST`/`DELETE` endpoints (S1) | CRITICAL |
| 2 | Add HMAC signature verification to CI webhook endpoint (S2) | CRITICAL |
| 3 | Add `OnModuleDestroy` to `VcsPollingService` to clear all intervals (M1) | CRITICAL |
| 4 | Fix `CronOptimizeStrategy` to `clearInterval` in `onDestroy` (M2) | CRITICAL |
| 5 | Implement background eviction in `CacheManager`; honour `lruSize` (M3) | CRITICAL |

### Fix Soon — High priority

| # | Item | Severity |
|---|------|----------|
| 6 | Null-guard VCS webhook secret before HMAC compare (S4) | HIGH |
| 7 | Add periodic cleanup + `OnModuleDestroy` to `VcsWebhookService` (M4) | HIGH |
| 8 | Delete stale entries from `graphifyEnabledCache` on read miss (M5) | HIGH |
| 9 | Batch graph node/link writes in a single `$transaction` (P1) | HIGH |
| 10 | Batch agent role/capability inserts with `createMany` (P2) | HIGH |
| 11 | Batch entity-graph lookups with a single `IN` query (P3) | HIGH |
| 12 | Add missing Prisma indexes (`Ticket`, `Comment`, `TicketActivity`, etc.) (P4) | HIGH |

### Fix When Possible — Medium priority

| # | Item | Severity |
|---|------|----------|
| 13 | Add `AbortSignal.timeout` to all external `fetch()` calls (P6) | MEDIUM |
| 14 | Remove full principal from debug log; log `userId` only (S5) | MEDIUM |
| 15 | Add `@MinLength(32)` to webhook secret DTO (S6) | MEDIUM |
| 16 | Raise password policy to 12+ chars with complexity (S7) | MEDIUM |
| 17 | Reduce JWT default expiry to `15m` access / `7d` refresh (S8) | MEDIUM |
| 18 | Parallelise sequential loops in `ContextBuilderService` (P5) | MEDIUM |
| 19 | Add `take` limit to all unbounded `findMany` queries (P10) | MEDIUM |
| 20 | Fix JSON.parse/stringify hot paths (outbox, webhooks, token estimation) (P7–P9) | MEDIUM |
| 21 | Replace `readFileSync` with async lazy load (P11) | MEDIUM |
| 22 | Add handler deduplication + `unregister` to `OutboxFanOutRegistry` (M6) | MEDIUM |
| 23 | Implement LRU eviction in `LexicalIndex` (M7) | MEDIUM |
| 24 | Add `clear(projectId)` to `EntityStore` and `CounterOptimizeStrategy` (M8, M9) | MEDIUM |

---

## Positive Findings

The following security and quality practices were confirmed as implemented correctly:

- **No hardcoded secrets** found anywhere in the codebase.
- **No `console.log`** statements — all logging goes through the NestJS `Logger`.
- **Auth controller rate limiting** — `@Throttle` applied to login, register, and refresh endpoints.
- **API key hashing** — stored as HMAC-SHA256, never plaintext.
- **`@Public()` decorator pattern** — consistently used and enforced by the combined auth guard.
- **VCS webhook HMAC verification** — correctly implemented for VCS push events.
- **Path traversal safety** — all file reads use hardcoded fixture paths, not user input.
- **DTO validation** — `ValidationPipe` with `class-validator` decorators used throughout.
- **Project slug/key validation** — strong regex patterns enforced in `CreateProjectDto`.
- **RAG endpoints** — project membership check applied before all retrieval operations.
