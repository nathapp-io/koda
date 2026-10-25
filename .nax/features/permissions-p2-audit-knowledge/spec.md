# SPEC: Permissions P2j — Audit Entries for the Knowledge Writers

## Summary

This feature makes the knowledge writers in `apps/api` record an `AuditEntry`. It uses the recorder and the rules from `permissions-p2-audit-core`: `AuditRecorder.record` inside the write's transaction, and `AuditRecorder.audited` when there is none. The writes:
- **KB routes.** `POST /projects/:slug/kb/documents`, `DELETE /projects/:slug/kb/documents/:sourceId`, `POST /projects/:slug/kb/import/graphify` and `POST /projects/:slug/kb/optimize` (`RagController`).
- **Memory routes.** `POST /memory`, `POST /memory/extract` and `POST /memory/decisions` (`MemoryController`), through one change to `PrismaMemoryItemRepository.upsert`.
- **Memory tools and system writers.** The `koda_add_memory` and `koda_record_decision` assistant tools, the outbox extraction (`MemoryOutboxSubscriber`, `system.memory.extract-from-event`) and the nightly governance cleanup (`MemoryGovernanceProcessor`, `system.memory.govern`).
- **Code-intel indexing.** `POST /code-intel/index` (`CodeIntelController`) and the push-driven commit index (`CodeIntelOutboxSubscriber`, `system.codeintel.index-commit`).

The derived indexes (the KB ticket index, the entity graph, the FTS optimizers) record nothing; the Bookkeeping table names them.

This is the tenth of twelve features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order: context, context-guard, audit-entry, audit-core, audit-fleet-routes, audit-fleet-ops, audit-fleet-system, web, audit-vcs-ci, **audit-knowledge**, audit-delivery, audit-coverage.

## Motivation

`permissions-p2-audit-vcs-ci` (PR #334, deployed `aa59d201` on 2026-10-26) closed the VCS and CI writers. A KB document a Developer replaced, a memory fact an agent superseded through MCP, a decision a thread recorded on approval and a nightly cleanup that expired a project's memory still leave no entry. Review findings C/SEC-1 and C/SEC-2 (redesign doc §2) were about exactly these writes: a KB write or a memory write that replaces another principal's row. P1 closed the permission side; the Audit log is the only place that shows who replaced what, and when.

`permissions-p2-audit-integrations` was split by domain before drafting (audit-vcs-ci spec, Motivation). This feature is the knowledge domain: KB documents and RAG, memory, entity graph, code intel. The fleet knowledge routes and index passes (`fleet.knowledge.*`, `system.knowledge.index`) were recorded by audit-fleet-ops and audit-fleet-system; `KnowledgePoller` only enqueues and records nothing (audit-fleet-system, Out of Scope).

**Rulings that bind this feature** (user, 2026-10-24):
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction. The package's `AuditInterceptor` and `@Audit` decorator are not used.
- **The coverage guard and the walker test belong to the last P2 feature** (`permissions-p2-audit-coverage`). This feature does not add them.

The user skipped the design questions for the integrations split ("skip questions and proceed", 2026-10-25), and asked for this spec without questions on 2026-10-26. Every call below that is not in the rulings or the design is the designer's.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **A KB write records after the LanceDB write succeeds.** KB documents live in the LanceDB table, which has no transaction to share with `AuditEntry`. `RagController` runs the store call first and then `this.audit.audited(async () => undefined, () => entries)`, a transaction holding only the entries. A failed store call records nothing. A `record` that rejects after a successful store call leaves the KB change in place and the route answers an error status. Recording first (the `fleet.knowledge.repo.reindex` order) would leave an entry for a write that then failed; holding a Postgres transaction open across an embedding call would hit Prisma's 5 s interactive-transaction timeout.
- **A graphify import records after the import, the same way.** `RagService.importGraphify` writes the graph in `PrismaRagRepository.applyGraphDiff`'s own `$transaction` and the LanceDB rows outside it, then stamps `graphifyLastImportedAt`. The route records `kb.graphify.import` after `importGraphify` resolves. An empty `nodes` list returns before any write and records nothing, as today.
- **A KB delete records one entry per source that had rows, right after that source's delete.** `DELETE …/kb/documents/:sourceId` without `source` deletes both user sources (`doc`, `manual`). The route already reads each source's creators before deleting. In its loop, after each `deleteBySource` resolves for a source with at least one row, it records `kb.document.delete` through `audited`; a source with none records nothing. So a second source's failure leaves the first source's delete with its entry.
- **`PrismaMemoryItemRepository.upsert` moves to `PrismaService.withTransaction`.** Today it opens `this.prisma.client.$transaction(…, { isolationLevel: 'Serializable' })`, which is outside the AsyncLocalStorage the transaction manager reads, so `AuditRecorder.record` inside it throws "must run inside a transaction". It becomes `this.prisma.withTransaction(async (tx) => { const db = tx as unknown as PrismaClient; … }, { isolationLevel: 'Serializable' })` (the callback keeps writing through its own `tx`, with the cast `prisma-memory-item.repository.ts:177` already makes, so a bare `PrismaService` in a test still gets one real transaction), the pattern `api-data.md` names as the only valid manual transaction ("when you need explicit transaction options"). `PrismaModule` builds `PrismaService` with the same AsyncLocalStorage the `PrismaTransactionManager` uses, so inside the callback `txManager.isInTransaction()` is true and `record` writes through the same transaction. The reads, the no-op restatement, `beforeSupersede` and the supersede-then-create order are unchanged. Inside an outer transaction it joins it (the isolation option then has no effect); no caller does that today.
- **A memory write records through an `onWritten` hook, inside the upsert's transaction.** `MemoryUpsertOptions` gains `onWritten?: (written: MemoryWritten) => Promise<void>`, awaited after the `create`, with the created item and the item it superseded (or `null`). It is not called on the identical-restatement no-op. Each caller passes `memoryAuditHook(this.audit, key)` from the new `src/memory/memory-audit.ts`, which records the entry. This is the `beforeSupersede` hook's pattern, and the `onCreated` / `onWritten` callbacks of audit-vcs-ci and audit-core.
- **A memory entry never prints the fact.** Subject, predicate and object are user-written text (the tools mask them in previews). The summary is the kind and, for a replacement, the superseded item's id: `created FACT`, or `created DECISION, superseded <id>`.
- **Each memory entry point records its own key.** `POST /memory` and `koda_add_memory` record `memory.create`; `POST /memory/extract` records `memory.extract`, one entry per item it writes; `POST /memory/decisions` and `koda_record_decision` record `memory.decision.record`. The replace check's `memory.update` is a permission, not a separate write, so a replacement records under the entry point's key and names the superseded id.
- **A tool entry carries the tool's context.** Through MCP the actor is the agent, origin `mcp` (`directWrite`). Through a thread approval `AssistantToolExecutor.executeAction` runs the tool as `SYSTEM/assistant` on behalf of the requester (`onBehalfOf` `{ type: 'USER', id }`), origin `thread`, with the action's approval block (`assistant-tool.executor.ts:104`), and `record` copies all three. `MemoryWriteTools` passes its injected `AuditRecorder` to both tool factories.
- **The outbox extraction records as `SYSTEM/memory`.** Fan-out handlers run inside `runAsSystem('outbox')` (`fan-out-publisher.ts:75`). `MemoryOutboxSubscriber`'s two handlers run their body inside `runAsSystemWriter(this, …)` (`system.memory.extract-from-event` → `memory`), so the item and its entry are the memory component's; `runAsSystem` inherits the outbox record's `correlationId`. This follows audit-fleet-system's call "an entry under a `system.*` key always carries that component's actor".
- **Governance records one entry per project per run that changed rows.** `MemoryGovernanceService.runCleanup` makes one small write per item outside any transaction, and wrapping a whole project's cleanup in one transaction would risk the timeout. `MemoryGovernanceProcessor.cleanUpAllProjects` records `system.memory.govern` on the project after `runCleanup` resolves, through `audited(async () => result, entriesOf)` with `entriesOf` returning `[]` when all four counts are 0. A rejected `record` lands in the existing per-project `catch`: logged, the next project runs, and the run throws its summary error at the end, as for any cleanup failure today.
- **The code-intel route records inside the index transaction.** `AstIndexService.indexCommit` already runs its deletes and upserts in one `txManager.run` (`ast-index.service.ts:89`). It gains an optional last parameter `onIndexed?: (result: { symbolsIndexed: number; filesIndexed: number }) => Promise<void>`, awaited inside that `run` after the last upsert, and only when `files` was not empty (a file that fails to parse still has its old symbols deleted, so it counts as a write; `files: []` writes nothing and records nothing). `CodeIntelController.indexCommit` passes a callback that records `codeintel.index.write`. `CodeCommitOutboxHandler` passes none.
- **A derived index records nothing when the write it derives from carries the entry.** `KbTicketLifecycleSubscriber` (`system.kb.ticket-index`) re-indexes a ticket a ticket write already recorded. `EntityGraphOutboxSubscriber` (`system.entity-graph.write`) projects ticket events and graphify imports, which record. The `system.rag.optimize` strategies compact the FTS table. Recording each would add one entry per ticket event beside the ticket's own. They are the Bookkeeping table's input for the coverage guard.
- **The push-driven commit index records once per indexed commit.** A push's `code_commit` outbox rows are bookkeeping (audit-vcs-ci), so nothing upstream records the symbols a push writes. `CodeCommitOutboxHandler.process` gains an optional last parameter `onIndexed`, forwarded to `indexCommit` as its fifth argument. `CodeIntelOutboxSubscriber.handleCodeCommit` runs inside `runAsSystemWriter(this, …)` (`system.codeintel.index-commit` → `codeintel`) and passes a callback that records `system.codeintel.index-commit`, on both its handler path and its direct `astIndexService.indexCommit` fallback. A commit with no files to index, no connection or no key records nothing. Removing a commit's deleted files (`removeFiles`) is bookkeeping. This follows audit-fleet-system's "a knowledge pass records once, when it completes".
- **`AuditRecorder` is a required constructor dependency, last.** `RagController`, `MemoryController`, `MemoryWriteTools`, `MemoryOutboxSubscriber`, `MemoryGovernanceProcessor` and `CodeIntelController` take it as their new last parameter. `CodeIntelOutboxSubscriber` takes it right after `registry`, before its two `@Optional()` parameters. `addMemoryTool` and `recordDecisionTool` take it as a new `audit` field of their `deps`.
- **`projectId` is the row's project.** The KB route's project, the memory item's `projectId`, the governed project, the code-intel route's project.

### Keys and summaries (`src/memory/memory-audit.ts`, US-002)

```typescript
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { MemoryItem } from './memory-item-repository';

/** What an upsert wrote: the new item and the active item it superseded, if any. */
export interface MemoryWritten {
  item: MemoryItem;
  superseded: MemoryItem | null;
}

/** The keys a memory write records: the entry point that wrote it. */
export type MemoryAuditKey = 'memory.create' | 'memory.extract' | 'memory.decision.record' | 'system.memory.extract-from-event';

/** `created <KIND>`, or `created <KIND>, superseded <id>`; never the subject, predicate or object. */
export function memoryWriteSummary(written: MemoryWritten): string;

/** An `onWritten` hook that records `key` on the new item, inside the upsert's transaction. */
export function memoryAuditHook(audit: AuditRecorder, key: MemoryAuditKey): (written: MemoryWritten) => Promise<void>;
```

### The summary and resource contract

| Write | Key | `resourceType` | `resourceId` | `projectId` | `summary` |
|:--|:--|:--|:--|:--|:--|
| KB document added | `kb.document.add` | `kb-document` | `<source>:<sourceId>` | the project | `added <source> document` |
| KB document rows deleted (per source with rows) | `kb.document.delete` | `kb-document` | `<source>:<sourceId>` | the project | `deleted <n> <source> rows` |
| graphify import | `kb.graphify.import` | `project` | the project id | the project | `imported <n> nodes, cleared <m>` |
| KB table optimized | `kb.optimize` | `project` | the project id | the project | `kb table optimized` |
| memory item via `POST /memory` or `koda_add_memory` | `memory.create` | `memory-item` | the new item's id | the item's project | `memoryWriteSummary` |
| memory item via `POST /memory/extract` | `memory.extract` | `memory-item` | the new item's id | the item's project | `memoryWriteSummary` |
| decision via `POST /memory/decisions` or `koda_record_decision` | `memory.decision.record` | `memory-item` | the new item's id | the item's project | `memoryWriteSummary` |
| memory item from an outbox event | `system.memory.extract-from-event` | `memory-item` | the new item's id | the item's project | `memoryWriteSummary` |
| governance cleanup that changed rows | `system.memory.govern` | `project` | the project id | the project | `expired <a>, downranked <b>, deduplicated <c>, superseded <d>` |
| code-intel index | `codeintel.index.write` | `code-repo` | the request's `repoId` | the project | `indexed <s> symbols in <f> files` |
| commit indexed from a push | `system.codeintel.index-commit` | `code-repo` | the payload's `repoId` | the payload's `projectId` | `indexed <s> symbols in <f> files` |

`<source>` is `doc` or `manual`; `<n>` is the number of rows the source had before the delete (the length of `findSourceCreators`' answer). `<n>` and `<m>` of the import are `importGraphify`'s `imported` and `cleared`. `<a>`..`<d>` are `GovernanceResult`'s four counts. `<s>` and `<f>` are `symbolsIndexed` and `filesIndexed`. The table never prints KB content or metadata, a memory subject, predicate or object, a decision's topic, text or rationale, a graphify label or file, a source file's content or path, or a commit hash.

**Actors.** The KB, memory and code-intel routes record as the request's actor, origin `rest`. `koda_add_memory` and `koda_record_decision` record as the tool call's context (MCP: the agent, origin `mcp`; a thread approval: `SYSTEM/assistant` on behalf of the requester, origin `thread`, with the approval block). The outbox extraction records as `SYSTEM/memory`, governance as `SYSTEM/memory` (`runAsSystemWriter` in `scheduledCleanup`, unchanged), the push index as `SYSTEM/codeintel`. A tool entry from a thread carries an `onBehalfOf`: the requester for an approved action, the agent for an agent's direct write (`assistant-tool.executor.ts:202`, approval mode none); this feature sets none itself.

### The writers

| Story | Service.method | Today | Change |
|:--|:--|:--|:--|
| US-001 | `RagController.addDocument` | `ragService.indexDocument`, no transaction, `rag.controller.ts:129` | after it returns an id, `audit.audited` records `kb.document.add`; an `indexed: false` answer records nothing |
| US-001 | `RagController.deleteDocument` | `deleteBySource` per source, `:190` | in the loop, after each `deleteBySource` for a source whose `findSourceCreators` answer was not empty, `audit.audited` records `kb.document.delete` |
| US-001 | `RagController.importGraphify` | `ragService.importGraphify`, `:247` | after it resolves, `audit.audited` records `kb.graphify.import` |
| US-001 | `RagController.optimizeTable` | `ragService.optimizeTable`, `:262` | after it resolves, `audit.audited` records `kb.optimize` |
| US-002 | `PrismaMemoryItemRepository.upsert` | `this.prisma.client.$transaction(…, Serializable)`, `prisma-memory-item.repository.ts:175` | `this.prisma.withTransaction(…, { isolationLevel: 'Serializable' })`; awaits `options.onWritten` after `create` |
| US-002 | `MemoryController.write`, `extractFromEvent`, `recordDecision`, `createMemory` | `repository.upsert` / `extractionService.recordDecision` with `{ beforeSupersede }` | the options gain `onWritten: memoryAuditHook(this.audit, <key>)` |
| US-003 | `addMemoryTool(deps).execute`, `recordDecisionTool(deps).execute` | `deps.memory.upsert` / `deps.extraction.recordDecision` with `{ beforeSupersede }` | the options gain `onWritten: memoryAuditHook(deps.audit, <key>)` |
| US-003 | `MemoryWriteTools.onModuleInit` | passes `memory`, `extraction`, `guard` | also passes `audit` |
| US-003 | `MemoryOutboxSubscriber.handleTicketEvent`, `handleAgentEvent` | `persistExtractedItems` → `upsert(input)`, as `SYSTEM/outbox` | body inside `runAsSystemWriter(this, …)`; `upsert(input, { onWritten: memoryAuditHook(this.audit, 'system.memory.extract-from-event') })` |
| US-003 | `MemoryGovernanceProcessor.cleanUpAllProjects` | `governanceService.runCleanup(project.id)` per project | after `runCleanup` resolves, `audit.audited(async () => result, entriesOf)` records `system.memory.govern` when a count is above 0 |
| US-004 | `AstIndexService.indexCommit` | one `txManager.run` for deletes and upserts, `ast-index.service.ts:89` | optional last `onIndexed`, awaited inside that `run` after the last upsert |
| US-004 | `CodeIntelController.indexCommit` | `astIndexService.indexCommit` with four arguments | passes `onIndexed` that records `codeintel.index.write` |
| US-004 | `CodeCommitOutboxHandler.process` | `astIndexService.indexCommit` with four arguments, `code-commit-outbox-handler.ts:84` | optional last `onIndexed`, forwarded as `indexCommit`'s fifth argument |
| US-004 | `CodeIntelOutboxSubscriber.handleCodeCommit` | `codeCommitHandler.process(p)` or `astIndexService.indexCommit(…)`, as `SYSTEM/outbox` | inside `runAsSystemWriter(this, …)`; both calls pass `onIndexed` that records `system.codeintel.index-commit` |

### Bookkeeping writes (record nothing)

This list is input for the coverage guard's allowlist in `permissions-p2-audit-coverage`; this feature does not build the guard.

| Write | Where |
|:--|:--|
| a ticket's KB document indexed or removed after a ticket event (`system.kb.ticket-index`) | `KbTicketLifecycleSubscriber` |
| FTS table optimization (`system.rag.optimize`) | `CronOptimizeStrategy`, `CounterOptimizeStrategy`, `ManualOptimizeStrategy` |
| entity nodes and links projected from ticket events and graphify imports (`system.entity-graph.write`) | `EntityGraphOutboxSubscriber`, `EntityGraphService` |
| the in-memory entity store refresh on `graphify_import` | `RagModule`'s fan-out handler |
| a commit's deleted files' symbols removed (`removeFiles`) | `CodeCommitOutboxHandler` |
| the code rows a graphify disable deletes (`deleteAllBySourceType(…, 'code')`) | `ProjectsService.update` (covered by `project.update`) |
| a ticket's KB document indexed by a transition | `TicketTransitionsService` (covered by the transition's entry) |
| `KodaDomainWriter.indexDocument`, `importGraphify` | no production caller at `aa59d201` |
| `PrismaMemoryItemRepository.updateDirect` (governance's writes, covered by its entry), `softDelete`, `reject` | `MemoryGovernanceService`; `softDelete` and `reject` have no route |
| a memory upsert that restates the active item (same object and source) | `PrismaMemoryItemRepository.upsert` |
| `graphifyLastImportedAt` | `RagService.importGraphify` (covered by the import's entry) |

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `record` rejects after a KB add, delete, import or optimize | the KB change stays (LanceDB has no rollback); the route answers an error status | US-001 |
| a delete whose second source's `deleteBySource` throws | the first source's rows are gone with their entry; the second source records nothing; the route answers an error status, as today | US-001 |
| a KB add that indexes nothing (`indexDocument` returned `null`) | 201 `indexed: false`; no entry | US-001 |
| a KB add or delete refused by the replace or delete check | 403; no write; no entry | US-001 |
| a KB delete of a `sourceId` with no rows | 200 `deleted: true`; no entry | US-001 |
| a graphify import with an empty `nodes` list, or on a project without `graphifyEnabled` | 200 with zeros, or 400; no entry | US-001 |
| `record` rejects inside a memory upsert | the transaction rolls back: no new item, and a superseded item stays active; the route answers an error status | US-002 |
| a memory write that restates the active item | no write; no entry; the route answers as today | US-002 |
| a memory write refused by the replace check (`MemoryReplaceRefusedError`) | 403; no write; no entry | US-002 |
| `POST /memory/extract` whose extracted items are all `DECISION` | no write; no entry | US-002 |
| `record` rejects inside a tool's upsert | the tool's write rolls back; the tool answers its error as for any store failure today | US-003 |
| `record` rejects inside the outbox extraction | that item's upsert rolls back and the handler throws; the fan-out marks the record failed and retries it, as for any handler error today | US-003 |
| a governance run that changes nothing in a project | no entry for that project | US-003 |
| `record` rejects after a project's cleanup | the cleanup's writes stay; logged; the next project runs; the run throws its summary error at the end | US-003 |
| `record` rejects inside the code-intel index | the transaction rolls back: no symbol of the commit is written and the old ones stay; the route answers an error status | US-004 |
| `record` rejects inside a push's index | the transaction rolls back and the handler throws; the fan-out marks the outbox record failed and retries it | US-004 |
| a push with no files to index, no VCS connection or no encryption key | no index; no entry | US-004 |
| `POST /code-intel/index` with `files: []` | 201 with zero counts; no write; no entry | US-004 |

### Integration

Verified at main `aa59d201`. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `AuditRecorder.record(input)` and `AuditRecorder.audited(fn, entriesOf)` (`entriesOf` may return `[]`), `AuditRecordInput { key; resourceType; resourceId; projectId?; summary? }` — `src/audit/audit-recorder.service.ts`. `record` throws for a key outside the catalog and outside a transaction (`txManager.isInTransaction()`), and reads the actor, origin, approval and correlation id from `currentContext()`.
- `runAsSystemWriter(writer, fn)`, `currentContext()` — `src/action-context/action-context.ts`. `memory` is in `SYSTEM_ACTOR_IDS` (second segment of `system.memory.*`). `MemoryOutboxSubscriber` is `@SystemWriter('system.memory.extract-from-event')` and `MemoryGovernanceProcessor` is `@SystemWriter('system.memory.govern')`, unchanged.
- `FanOutPublisher.publish` runs every handler inside `runAsSystem('outbox', …)` — `src/outbox/fan-out-publisher.ts:75`.
- `PrismaService.client` is a proxy that answers the AsyncLocalStorage transaction client inside `txManager.run` (`@nathapp/nestjs-prisma` `patchWithTransactionProxy`), so the stores' `this.prisma.client` calls join an ambient `run`. `PrismaService.withTransaction(callback, options)` opens `$transaction(…, options)` and runs the callback inside that same AsyncLocalStorage (`prisma.service.js:87`), or joins an active transaction.
- `RagService.indexDocument(projectId, doc): Promise<string | null>`, `deleteBySource`, `findSourceCreators`, `importGraphify(projectId, nodes, links): Promise<{ imported; cleared }>`, `optimizeTable` — `src/rag/rag.service.ts`; unchanged.
- `MemoryUpsertOptions.beforeSupersede` — `src/memory/prisma-memory-item.repository.ts`; `ExtractionService.recordDecision(input, repository, options?)` passes `options` straight to `upsert` — `src/memory/extraction.service.ts:216`; unchanged.
- `MemoryGovernanceService.runCleanup(projectId): Promise<GovernanceResult>` — `src/memory/memory-governance.service.ts`; unchanged.
- `mockAuditRecorder` — `src/common/test-helpers/global-stubs.module.ts`; `audited` calls its `fn`, `record` resolves. `GlobalStubsModule` provides it as `AuditRecorder`, so `memory.module.spec.ts`, `code-intel.module.spec.ts` and `assistant.module.spec.ts` keep compiling. `AuditLogModule` is `@Global()`.
- Every key in the contract table is in `PERMISSION_CATALOG` (`src/permissions/catalog.ts`).
- `withTestActor(actor, fn)`, `fixtureDb(app)`, `expectGuardActive(app)` — `test/helpers/action-context.ts`; `bootHttpApp`, `data`, `loginToken`, `resetThrottle`, `TEST_PASSWORD` — `test/helpers/http-app.ts`.
- Test precedent: `test/integration/rag/permissions-kb-routes.integration.spec.ts` (KB routes over HTTP, rows read back through `app.get(RagService).listDocuments`), `test/integration/memory/permissions-memory-routes.integration.spec.ts` (memory routes over HTTP, and an MCP `tools/call` with `MCP_ENABLED=true` and an agent key), `test/integration/memory/outbox-fanout-extraction.integration.spec.ts` (a published `ticket_event` reaching `MemoryOutboxSubscriber`), `test/integration/memory/memory-governance-paging.integration.spec.ts`, and `test/integration/code-intel/code-intel-project-roles.integration.spec.ts` (`POST /api/code-intel/index` with `projectSlug`).

Changed (baseline → target):
- `PrismaMemoryItemRepository.upsert(item, options?)` — Baseline: a raw `this.prisma.client.$transaction(fn, { isolationLevel: 'Serializable' })`. Target: `this.prisma.withTransaction(fn, { isolationLevel: 'Serializable' })`, and `MemoryUpsertOptions` gaining `onWritten?: (written: MemoryWritten) => Promise<void>`.
- `AstIndexService.indexCommit(repoId, commitHash, files, projectId)` → `indexCommit(repoId, commitHash, files, projectId, onIndexed?: (result: { symbolsIndexed: number; filesIndexed: number }) => Promise<void>)`.
- `addMemoryTool(deps: { memory; guard })` and `recordDecisionTool(deps: { memory; extraction; guard })` → each `deps` gains `audit: AuditRecorder`.
- The constructors of `RagController`, `MemoryController`, `MemoryWriteTools`, `MemoryOutboxSubscriber`, `MemoryGovernanceProcessor` and `CodeIntelController` — Baseline: no `AuditRecorder`. Target: a required `AuditRecorder` as the last parameter.

## Out of Scope

- The delivery integrations (outbound webhooks and delivery, skills, notifications and ticket watch, outbox, email, fleet health, the assistant action finalize, the role seeder, the remaining assistant tools) are out of scope (feature `permissions-p2-audit-delivery`).
- The runtime coverage guard and the walker test over write surfaces are out of scope (feature `permissions-p2-audit-coverage`). The Bookkeeping table is its input.
- Recording the derived indexes (`KbTicketLifecycleSubscriber`, `EntityGraphOutboxSubscriber`, the `system.rag.optimize` strategies, `RagModule`'s `graphify_import` handler) and a push's `removeFiles` is out of scope; the write each derives from carries the entry.
- The fleet knowledge routes, `KnowledgeRepoIndexer` passes and `KnowledgePoller` are out of scope; audit-fleet-ops and audit-fleet-system settled them.
- Making a KB write and its entry atomic is out of scope: LanceDB has no transaction to share, so the entry is written after the store call and a failed `record` leaves the KB change in place.
- Wrapping a project's governance cleanup in one transaction is out of scope; its entry is written after the cleanup resolves.
- Recording a memory read, a KB search, a context query, a timeline read or a code-intel read is out of scope; only committed writes are recorded.
- Recording refused or failed attempts (401, 403, 404, 409, validation errors) is out of scope.
- Adding catalog keys (one per memory kind, one for a replacement) is out of scope; each write records under its existing key and the summary names the kind and the superseded id.
- Changing a route's status codes, response bodies or `@Requires` keys, the replace and delete checks, the memory dedup key, the Serializable isolation or the KB row ownership rules is out of scope; `openapi.json` does not change.
- A retry of a Serializable conflict (`P2034`) in `upsert` is out of scope; a conflict, like any Prisma error inside `upsert`, now surfaces through `PrismaService.withTransaction`'s error mapping (`P2002` as a 409, an unmapped code such as `P2034` as a 500).
- An `onBehalfOf` on the outbox extraction's entries (the event's actor) is out of scope; the shared `correlationId` joins them.
- A before/after diff of values in `AuditEntry` is out of scope.
- US-001 only: a test of a delete whose second source's `deleteBySource` throws is out of scope; the per-source record order is pinned by AC6.
- US-004 only: tests of a push with no files to index, no VCS connection or no encryption key are out of scope; those early returns are unchanged and never reach `indexCommit`.
- US-001 only: a separate test of a rejected `record` after a delete, a graphify import or an optimize is out of scope; each is the same record-after-the-store-call step AC4 pins for an add.

## Stories

1. **US-001: KB route writes are audited** — `Workdir: apps/api` — No dependencies. `RagController` records `kb.document.add`, `kb.document.delete`, `kb.graphify.import` and `kb.optimize` after each store call succeeds.
2. **US-002: Memory route writes are audited** — `Workdir: apps/api` — No dependencies. `src/memory/memory-audit.ts`; `PrismaMemoryItemRepository.upsert` runs on the transaction manager and awaits `onWritten`; `MemoryController`'s three write routes pass it.
3. **US-003: Memory tools, outbox extraction and governance are audited** — `Workdir: apps/api` — Depends on US-002. `koda_add_memory`, `koda_record_decision`, `MemoryOutboxSubscriber` and `MemoryGovernanceProcessor`.
4. **US-004: Code-intel indexing is audited** — `Workdir: apps/api` — No dependencies. `AstIndexService.indexCommit` gains `onIndexed`; `CodeIntelController` records `codeintel.index.write` and `CodeIntelOutboxSubscriber` records `system.codeintel.index-commit`.

Four stories, one capability: each wires the same recorder into a different knowledge writer, and none is useful as a separate PR. US-003 follows US-002 because it uses US-002's `memoryAuditHook` and the `onWritten` option.

### Context Files

**US-001**
- `apps/api/src/rag/rag.controller.ts`
- `apps/api/src/rag/rag.service.ts`
- `apps/api/test/integration/rag/permissions-kb-routes.integration.spec.ts`

**US-002**
- `apps/api/src/memory/prisma-memory-item.repository.ts`
- `apps/api/src/memory/memory.controller.ts`
- `apps/api/src/memory/extraction.service.ts`
- `apps/api/test/integration/memory/permissions-memory-routes.integration.spec.ts`
- `apps/api/test/integration/memory/decision-replacement-atomic.integration.spec.ts`

**US-003**
- `apps/api/src/fleet/assistant/tools/memory-write-tools.ts`
- `apps/api/src/memory/memory-outbox.subscriber.ts`
- `apps/api/src/memory/memory-governance.processor.ts`
- `apps/api/test/integration/memory/outbox-fanout-extraction.integration.spec.ts`
- `apps/api/src/memory/memory-audit.ts` — created by US-002, used here

**US-004**
- `apps/api/src/code-intel/ast-index.service.ts`
- `apps/api/src/code-intel/code-intel.controller.ts`
- `apps/api/src/code-intel/code-intel-outbox.subscriber.ts`
- `apps/api/src/code-intel/code-commit-outbox-handler.ts`
- `apps/api/test/integration/code-intel/code-intel-project-roles.integration.spec.ts`

### Creates

**US-001**
- `apps/api/test/integration/audit/audit-kb-routes.integration.spec.ts`

**US-002**
- `apps/api/src/memory/memory-audit.ts`
- `apps/api/src/memory/memory-audit.spec.ts`
- `apps/api/test/integration/audit/audit-memory-routes.integration.spec.ts`

**US-003**
- `apps/api/test/integration/audit/audit-memory-system.integration.spec.ts`

**US-004**
- `apps/api/test/integration/audit/audit-code-intel.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/src/rag/rag.controller.ts` — injects AuditRecorder as the last constructor parameter; addDocument, deleteDocument, importGraphify and optimizeTable record the contract's entries through audit.audited after their store call resolves; the replace and delete checks, the early returns and the responses are unchanged.
- `apps/api/src/rag/rag.controller.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } (from global-stubs.module.ts) so the real RagController resolves, and it gains the US-001 AC-13 case; the existing assertions are kept.
- `apps/api/src/projects/project-membership.guard.routes.spec.ts` — its testing module (controllers TicketsController, ProjectsController, RagController) gains { provide: AuditRecorder, useValue: mockAuditRecorder } so RagController resolves; the existing assertions are kept.
- `apps/api/test/integration/graphify-kb-validation/graphify-kb-validation.integration.spec.ts` — its testing module with RagController gains { provide: AuditRecorder, useValue: mockAuditRecorder }; the existing assertions are kept.
- `apps/api/test/integration/rag/rag-api-project-id-validation.integration.spec.ts` — its testing module with RagController gains { provide: AuditRecorder, useValue: mockAuditRecorder }; the existing assertions are kept.
- `apps/api/src/rag/kb-documents-membership.routes.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder } so the real RagController resolves; the existing assertions are kept.

**US-002**
- `apps/api/src/memory/prisma-memory-item.repository.ts` — upsert runs inside this.prisma.withTransaction(fn, { isolationLevel: 'Serializable' }) instead of a raw this.prisma.client.$transaction; MemoryUpsertOptions gains onWritten, awaited with { item, superseded } after the create and not on the restatement no-op; the reads, the no-op rule, beforeSupersede and the supersede-then-create order are unchanged.
- `apps/api/src/memory/memory.controller.ts` — injects AuditRecorder as the last constructor parameter; write, recordDecision and createMemory add onWritten: memoryAuditHook(this.audit, key) to the upsert options, with memory.create for POST /memory, memory.extract for POST /memory/extract and memory.decision.record for POST /memory/decisions; the checks and responses are unchanged.
- `apps/api/src/memory/prisma-memory-item.repository.additional.spec.ts` — its mocked PrismaService gains withTransaction (calling the callback with the mocked client and recording the options) in place of the mocked $transaction for the upsert cases, the hook cases accept the added onWritten option, and it gains the US-002 AC-14 case; the asserted behaviours are kept.
- `apps/api/src/memory/memory.controller.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }, the exact { beforeSupersede: expect.any(Function) } option assertions become expect.objectContaining({ beforeSupersede: expect.any(Function), onWritten: expect.any(Function) }), and it gains the US-002 AC-8 case; the rest are kept.
- `apps/api/test/integration/memory/memory-controller.unit.spec.ts` — its direct new MemoryController(...) passes mockAuditRecorder for the new last parameter; the existing assertions are kept.

**US-003**
- `apps/api/src/fleet/assistant/tools/add-memory-tool.ts` — deps gains audit: AuditRecorder, and execute adds onWritten: memoryAuditHook(deps.audit, 'memory.create') to the upsert options; parse, preview and the refusal mapping are unchanged.
- `apps/api/src/fleet/assistant/tools/record-decision-tool.ts` — deps gains audit: AuditRecorder, and execute adds onWritten: memoryAuditHook(deps.audit, 'memory.decision.record') to the recordDecision options; parse, preview and the refusal mapping are unchanged.
- `apps/api/src/fleet/assistant/tools/memory-write-tools.ts` — injects AuditRecorder as the last constructor parameter and passes it as audit to addMemoryTool and recordDecisionTool.
- `apps/api/src/memory/memory-outbox.subscriber.ts` — injects AuditRecorder as the last constructor parameter; handleTicketEvent and handleAgentEvent run their body inside runAsSystemWriter(this, …), and persistExtractedItems passes { onWritten: memoryAuditHook(this.audit, 'system.memory.extract-from-event') } to upsert; registration and extraction are unchanged.
- `apps/api/src/memory/memory-governance.processor.ts` — injects AuditRecorder as the last constructor parameter; cleanUpAllProjects, after each runCleanup resolves, calls this.audit.audited(async () => result, entriesOf), recording system.memory.govern on the project when a count is above 0 (the cleanup itself stays outside that transaction); the per-project catch and the summary error are unchanged.
- `apps/api/src/fleet/assistant/tools/add-memory-tool.spec.ts` — its addMemoryTool deps gain audit: mockAuditRecorder, both exact option assertions ({ beforeSupersede: expect.any(Function) } and toEqual({ beforeSupersede })) also accept onWritten: expect.any(Function), and it gains the US-003 AC-9 case; the rest are kept.
- `apps/api/src/fleet/assistant/tools/record-decision-tool.spec.ts` — its recordDecisionTool deps gain audit: mockAuditRecorder, both exact { beforeSupersede } option assertions also accept onWritten: expect.any(Function), and it gains the US-003 AC-10 case; the rest are kept.
- `apps/api/src/fleet/assistant/tools/origin-tools.spec.ts` — its addMemoryTool and recordDecisionTool deps gain audit: mockAuditRecorder; the existing assertions are kept.
- `apps/api/src/memory/memory-outbox.subscriber.spec.ts` — its direct new MemoryOutboxSubscriber(...) passes mockAuditRecorder as the new last argument, and it gains the US-003 AC-11 case; the existing assertions are kept.
- `apps/api/test/integration/memory/outbox-fanout-extraction.integration.spec.ts` — its testing module with MemoryOutboxSubscriber gains { provide: AuditRecorder, useValue: mockAuditRecorder } so the subscriber resolves; the existing assertions are kept.
- `apps/api/test/integration/memory/outbox-envelope.integration.spec.ts` — its direct new MemoryOutboxSubscriber(publisher, new ExtractionService(), memoryRepository) passes mockAuditRecorder as the new last argument; the existing assertions are kept.
- `apps/api/src/memory/memory-governance.processor.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }, and it gains the US-003 AC-12 and AC-13 cases; the existing assertions are kept.

**US-004**
- `apps/api/src/code-intel/ast-index.service.ts` — indexCommit gains the optional last onIndexed parameter, awaited with { symbolsIndexed, filesIndexed } inside its existing txManager.run after the last upsert when files was not empty; parsing, the replace-not-merge rule and the result are unchanged.
- `apps/api/src/code-intel/code-intel.controller.ts` — injects AuditRecorder as the last constructor parameter; indexCommit passes astIndexService.indexCommit an onIndexed callback that records codeintel.index.write; the response is unchanged.
- `apps/api/src/code-intel/code-intel.controller.spec.ts` — its testing module's providers gain { provide: AuditRecorder, useValue: mockAuditRecorder }, and the indexCommit call assertion accepts the added fifth argument (expect.any(Function)); the rest are kept.
- `apps/api/src/code-intel/code-intel-search.controller.spec.ts` — both its testing modules with CodeIntelController gain { provide: AuditRecorder, useValue: mockAuditRecorder }; the existing assertions are kept.
- `apps/api/src/code-intel/ast-index.service.spec.ts` — gains the US-004 AC-5, AC-6 and AC-9 cases; the existing assertions are kept.
- `apps/api/src/code-intel/code-commit-outbox-handler.ts` — process gains the optional last onIndexed parameter and passes it to astIndexService.indexCommit as the fifth argument; the skips, the fetch and removeFiles are unchanged.
- `apps/api/src/code-intel/code-intel-outbox.subscriber.ts` — injects AuditRecorder right after registry (before the two optional parameters); handleCodeCommit runs inside runAsSystemWriter(this, …) and passes an onIndexed callback that records system.codeintel.index-commit to codeCommitHandler.process and to the direct astIndexService.indexCommit fallback; registration and the skip rules are unchanged.
- `apps/api/src/code-intel/code-intel-outbox.subscriber.spec.ts` — its direct new CodeIntelOutboxSubscriber(...) calls pass mockAuditRecorder as the second argument, its exact indexCommit and process call assertions accept the added onIndexed argument (expect.any(Function)), and it gains the US-004 AC-7 case; the rest are kept.
- `apps/api/src/code-intel/code-commit-outbox-handler.spec.ts` — its exact indexCommit call assertion accepts a fifth argument (undefined when process is called without onIndexed), and it gains the US-004 AC-8 case; the rest are kept.
- `apps/api/src/code-intel/code-commit-outbox-handler.removed-files.spec.ts` — its exact indexCommit call assertion accepts a fifth argument (undefined when process is called without onIndexed); the rest are kept.
- `apps/api/test/integration/ast-index/code-commit-handler.integration.spec.ts` — its testing module with CodeIntelOutboxSubscriber gains { provide: AuditRecorder, useValue: mockAuditRecorder }, and its exact indexCommit call assertion accepts the added onIndexed argument (expect.any(Function)); the rest are kept.

### Seams

- US-002 creates `src/memory/memory-audit.ts` and the `onWritten` option; US-003 calls `memoryAuditHook` from the tools and the outbox subscriber and depends on US-002. No other story calls a symbol a later story creates.
- Every story's integration ACs enter through the real wiring of the booted `AppModule`: a route over HTTP (the KB, memory and code-intel routes), an MCP `tools/call` (the two tools), a `ticket_event` published through `app.get(FanOutPublisher).publish` (the outbox extraction), or `app.get(MemoryGovernanceProcessor).scheduledCleanup()` (governance). Each asserts the stored `AuditEntry` row, so it proves the writer reaches the recorder rather than a stub.
- The thread-approval path of the two tools is pinned by the unit ACs over each tool's `execute` (US-003 AC9, AC10), which assert the hook is passed with the tool's key.

## Acceptance Criteria

Integration ACs boot `AppModule` against the test database with `bootHttpApp({ registrationEnabled: false })`. `root` registers first and is the Owner; `dev` and `viewer` are created through `POST /api/admin/users` and added to the spec's project with roles `developer` and `viewer`. For the US-004 push ACs, `process.env.VCS_ENCRYPTION_KEY` is set to `'ab'.repeat(32)` before boot (restored in `afterAll`), a GitHub connection is created on the project with `POST /api/projects/ci-intel/vcs` as `root` (`{ provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_x', syncMode: 'webhook' }`), and `src/vcs/factory` is mocked partially, keeping its other exports: `vi.mock('../../../src/vcs/factory', async (orig) => ({ ...(await orig()), createVcsProvider: vi.fn() }))`, with `createVcsProvider` returning a stub whose `fetchCommitFiles` the AC sets; a push is `app.get(FanOutPublisher).publish(outboxRecord('code_commit', { repoId: 'acme/app', commitHash, ref: 'refs/heads/main', changedFiles, projectId }))` (`test/helpers/outbox-record.ts`) inside `withTestActor({ type: 'SYSTEM', id: 'outbox' })`. Each spec creates its own project (the US-001 spec: slug `kb-audit`, key `KBA`; US-002: `mem-audit`, `MAU`; US-003: `mem-sys`, `MSY`; US-004: `ci-intel`, `CIN`) and reads `AuditEntry` rows back through `fixtureDb(app).auditEntry.findMany({ where: { resourceId } })`. KB rows are read back through `app.get(RagService).listDocuments(projectId, 500)`; memory rows through `fixtureDb(app).memoryItem.findMany({ where: { projectId } })`. A memory fact body is `{ projectId, kind: 'FACT', subject: 'svc', predicate: 'owner', object: 'Private fact', sourceId: 'note-1' }` (a `sourceId` is what makes an identical repeat a restatement: the no-op compares the stored `sourceId`, and an absent one is stored `null`). An MCP tool call is `POST /api/mcp` with `MCP_ENABLED=true` set before boot (restored in `afterAll`), an agent's API key added to the project with role `developer`, `Accept: application/json, text/event-stream` and a JSON-RPC `tools/call`, as `permissions-memory-routes.integration.spec.ts` sends one. `process.env.EMBEDDING_PROVIDER` is set to `'fake'` before `bootHttpApp` and restored in `afterAll`, as `permissions-kb-routes.integration.spec.ts` does, so KB indexing (and the ticket indexing a ticket fixture triggers) never reaches Ollama. `resetThrottle(app)` is called in `beforeEach`. "An entry" means an `AuditEntry` row; "no entry" means `findMany` for the resource (and key, where named) returns an empty array; "unchanged" compares a `count` taken before and after the call. "Spied to reject" means `vi.spyOn(app.get(AuditRecorder), 'record')` with an implementation that rejects with `new Error('audit down')` the first call whose `input.key` is the key the AC's writer records and delegates every other call to the original; the spy is restored after the AC.

### US-001: KB route writes are audited

1. [integration] `POST /api/projects/kb-audit/kb/documents` as `dev` with `{ source: 'manual', sourceId: 'runbook', content: 'Private content' }` returns 201 with `indexed` `true` and leaves one entry for `manual:runbook` with `key` `kb.document.add`, `resourceType` `kb-document`, `projectId` the project's id, `actorType` `USER`, `actorId` dev's id, `origin` `rest` and `summary` `added manual document`.
2. [integration] `POST …/kb/documents` as `dev` with `{ source: 'doc', sourceId: 'private-doc', content: 'Private content' }` leaves an entry for `doc:private-doc` whose `summary` does not include `Private content`.
3. [integration] `POST …/kb/documents` as `dev` replacing a `manual` row `root` created with sourceId `root-doc` returns 403 and the count of `kb.document.add` entries for `manual:root-doc` is unchanged.
4. [integration] `POST …/kb/documents` with sourceId `failing-add`, while `record` is spied to reject, returns an error status, and `listDocuments` still holds a `manual` row with sourceId `failing-add`.
5. [integration] `DELETE /api/projects/kb-audit/kb/documents/del-1?source=manual` as `root`, after `root` added a `manual` row with sourceId `del-1`, returns 200 and leaves one entry for `manual:del-1` with `key` `kb.document.delete`, `actorId` root's id and `summary` `deleted 1 manual rows`.
6. [integration] `DELETE …/kb/documents/both` as `root` with no `source`, after one `doc` row and one `manual` row with sourceId `both` were added, leaves one `kb.document.delete` entry for `doc:both` and one for `manual:both`.
7. [integration] `DELETE …/kb/documents/nothing-here` as `root` returns 200 and leaves no entry for `manual:nothing-here` or `doc:nothing-here`; `DELETE …/kb/documents/root-doc?source=manual` as `dev`, on a row `root` created, returns 403 and leaves no `kb.document.delete` entry for `manual:root-doc`.
8. [integration] `POST /api/projects/kb-audit/kb/import/graphify` as `root`, with `graphifyEnabled` set `true` on the project through `fixtureDb(app)`, and `{ nodes: [{ id: 'n1', label: 'Private label', type: 'module' }, { id: 'n2', label: 'Other', type: 'module' }], links: [] }`, returns 200 and leaves one entry for the project's id with `key` `kb.graphify.import`, `resourceType` `project` and `summary` `imported 2 nodes, cleared <the response's cleared>`, whose `summary` does not include `Private label`.
9. [integration] `POST …/kb/import/graphify` with `{ nodes: [] }` returns 200 and the count of `kb.graphify.import` entries for the project is unchanged.
10. [integration] `POST …/kb/import/graphify`, after `graphifyEnabled` is set `false` on the project through `fixtureDb(app)`, returns 400 and the count of `kb.graphify.import` entries for the project is unchanged.
11. [integration] `POST /api/projects/kb-audit/kb/optimize` as `root` returns 200 and leaves one entry for the project's id with `key` `kb.optimize`, `resourceType` `project` and `summary` `kb table optimized`.
12. [integration] `POST …/kb/optimize` as `dev` returns 403 and the count of `kb.optimize` entries for the project is unchanged.
13. [unit] `RagController.addDocument` with a stub `RagService` whose `indexDocument` resolves `null` and a stub recorder answers `indexed: false` and calls neither the recorder's `audited` nor its `record`.

### US-002: Memory route writes are audited

1. [integration] `POST /api/memory` as `dev` with the fact body returns 201 and leaves one entry for the new item's id with `key` `memory.create`, `resourceType` `memory-item`, `projectId` the project's id, `actorType` `USER`, `actorId` dev's id, `origin` `rest` and `summary` `created FACT`.
2. [integration] `POST /api/memory` as `dev` with the fact body and `subject` `svc-p` leaves an entry for the new item whose `summary` includes none of `svc-p`, `owner` or `Private fact`.
3. [integration] `POST /api/memory` as `dev` sent twice with the fact body and `subject` `svc-r` answers the same item id both times and leaves exactly one `memory.create` entry for that id.
4. [integration] `POST /api/memory` as `dev` with the fact body, `subject` `svc-s` and `object` `v2`, after `dev` wrote `svc-s` with `object` `v1`, leaves one entry for the new item with `summary` `created FACT, superseded <the v1 item's id>`.
5. [integration] `POST /api/memory` as `dev` with `subject` `svc2`, after `root` wrote an active item for `svc2` / `owner`, returns 403 and the count of `memory.create` entries is unchanged.
6. [integration] `POST /api/memory` as `dev` with `subject` `svc3`, `object` `v2`, after `dev` wrote `svc3` / `owner` with `object` `v1`, while `record` is spied to reject, returns an error status, leaves no item with `object` `v2`, and the `v1` item is still `active`.
7. [integration] `POST /api/memory/extract` as `dev` with `{ projectId, type: 'ticket_event', id: 'evt-1', ticketId: <a ticket of the project>, action: 'status_changed', data: { newStatus: 'IN_PROGRESS' } }` leaves, for each `memoryItem` row of the project with `sourceId` `evt-1`, one `memory.extract` entry whose `resourceId` is that row's id, with `resourceType` `memory-item` and `actorId` dev's id, and at least one such row exists.
8. [unit] `MemoryController.extractFromEvent` with a stub `ExtractionService` whose `extractFromEvent` returns only `DECISION` items, a stub repository and a stub recorder, returns those items filtered out (`items` `[]`) and calls neither the repository's `upsert` nor the recorder's `record`.
9. [integration] `POST /api/memory/decisions` as `dev` with `{ projectId, topic: 'Private topic', decision: 'Private decision' }` leaves one entry for the response's `memoryId` with `key` `memory.decision.record`, `actorId` dev's id and `summary` `created DECISION`, whose `summary` includes neither `Private topic` nor `Private decision`.
10. [integration] Two `POST /api/memory/decisions` as `dev` on topic `t2` (`decision` `First`, then `Second`) leave one entry for the second response's `memoryId` with `summary` `created DECISION, superseded <the first response's memoryId>`.
11. [integration] `POST /api/memory/decisions` as `dev` on topic `atomic`, while `record` is spied to reject, returns an error status and leaves no `DECISION` item with predicate `atomic`.
12. [unit] `memoryWriteSummary({ item: <kind 'FACT'>, superseded: null })` returns `created FACT`, and `memoryWriteSummary({ item: <kind 'DECISION'>, superseded: <id 'm-0'> })` returns `created DECISION, superseded m-0`.
13. [unit] `memoryAuditHook(recorder, 'memory.extract')` called with `{ item: { id: 'm-1', projectId: 'p-1', kind: 'FACT' }, superseded: null }` calls the stub recorder's `record` once with `key` `memory.extract`, `resourceType` `memory-item`, `resourceId` `m-1`, `projectId` `p-1` and `summary` `created FACT`.
14. [unit] `PrismaMemoryItemRepository.upsert` with a mocked `PrismaService` whose `withTransaction` calls its callback with a mocked client and records the options it was given, and whose client's `findFirst` answers an item with the same object and source, passes `{ isolationLevel: 'Serializable' }` to `withTransaction` and does not call `onWritten`.

### US-003: Memory tools, outbox extraction and governance are audited

1. [integration] An MCP `tools/call` of `koda_add_memory` by the agent with `{ project: 'mem-sys', kind: 'FACT', subject: 'tool', predicate: 'owner', object: 'Private tool fact' }` answers a text starting `memory:<id> saved` and leaves one entry for that id with `key` `memory.create`, `actorType` `AGENT`, `actorId` the agent's id, `origin` `mcp` and `summary` `created FACT`.
2. [integration] An MCP `tools/call` of `koda_record_decision` by the agent with `{ project: 'mem-sys', topic: 'tool-topic', decision: 'Private tool decision' }` answers a text starting `decision memory:<id> recorded` and leaves one entry for that id with `key` `memory.decision.record`, `actorType` `AGENT` and `origin` `mcp`.
3. [integration] An MCP `tools/call` of `koda_add_memory` by the agent with `{ project: 'mem-sys', kind: 'FACT', subject: 'tool-fail', predicate: 'owner' }`, while `record` is spied to reject, answers an error result and leaves no item with subject `tool-fail`.
4. [integration] `app.get(FanOutPublisher).publish(<outbox record of a ticket_event { id: 'evt-sys', ticketId: <a ticket>, projectId, actorId: root's id, action: 'status_changed', data: { newStatus: 'IN_PROGRESS' }, timestamp }>)` inside `withTestActor({ type: 'SYSTEM', id: 'outbox' })` leaves one `system.memory.extract-from-event` entry for each item it wrote, each with `actorType` `SYSTEM`, `actorId` `memory` and `origin` `system`.
5. [integration] Publishing one such `ticket_event` record twice, for a second ticket, leaves exactly one `system.memory.extract-from-event` entry per memory item with that ticket's subject.
6. [integration] Publishing such a `ticket_event` record for a third ticket, while `record` is spied to reject, rejects, and no memory item has `subject` `ticket:<that ticket's id>`.
7. [integration] `app.get(MemoryGovernanceProcessor).scheduledCleanup()`, with one active item of the project whose `ttlAt` is in the past (written through `fixtureDb(app)`), leaves one entry for the project's id with `key` `system.memory.govern`, `resourceType` `project`, `actorType` `SYSTEM`, `actorId` `memory` and `summary` `expired 1, downranked 0, deduplicated 0, superseded 0`, and the item's `status` is `rejected`.
8. [integration] `scheduledCleanup()` run twice, with one expired item of the project before the first run, leaves exactly one `system.memory.govern` entry for the project.
9. [unit] `addMemoryTool({ memory, guard, audit })` with a stub `memory.upsert` that calls `options.onWritten` with `{ item: { id: 'm-1', projectId: 'p-1', kind: 'FACT' }, superseded: null }`, and a stub recorder, has `execute` call the recorder's `record` once with `key` `memory.create` and `resourceId` `m-1`.
10. [unit] `recordDecisionTool({ memory, extraction, guard, audit })` with a stub `extraction.recordDecision` that calls its options' `onWritten` with a `DECISION` item `m-2`, and a stub recorder, has `execute` call the recorder's `record` once with `key` `memory.decision.record` and `resourceId` `m-2`.
11. [unit] `MemoryOutboxSubscriber` with a stub repository whose `upsert` captures `currentContext()` and its options, after `onModuleInit` and a `publish` of a `ticket_event` inside `runAsSystem('outbox', …)`, captures an actor `{ type: 'SYSTEM', id: 'memory' }` and an `onWritten` function.
12. [unit] `MemoryGovernanceProcessor.scheduledCleanup` with a stub `ProjectsService` answering projects `p-1` and `p-2`, a stub `runCleanup` answering four zero counts for `p-1` and `expiredCount` 2 for `p-2`, and a stub recorder whose `audited` runs its `fn` and records what `entriesOf` returns, calls `record` once, for `p-2` with `summary` `expired 2, downranked 0, deduplicated 0, superseded 0`.
13. [unit] AC12's processor, with `runCleanup` answering `expiredCount` 1 for both projects and a stub recorder whose `record` rejects for the `p-1` entry only, still records `p-2`'s entry and then rejects with an error whose message starts `Governance cleanup failed for 1 project(s)`.

### US-004: Code-intel indexing is audited

1. [integration] `POST /api/code-intel/index` as `root` with `{ repoId: 'acme/widgets', commitHash: 'c1', projectSlug: 'ci-intel', files: [{ path: 'src/private.ts', content: 'export function alpha(): number { return 1; }' }] }` returns 201 and leaves one entry for `acme/widgets` with `key` `codeintel.index.write`, `resourceType` `code-repo`, `projectId` the project's id, `actorType` `USER`, `actorId` root's id, `origin` `rest` and `summary` `indexed <the response's symbolsIndexed> symbols in 1 files`.
2. [integration] `POST /api/code-intel/index` as `root` for repo `acme/secret` with commit `c9` and file `src/private.ts` declaring `secretFn` leaves an entry for `acme/secret` whose `summary` includes neither `src/private.ts`, `secretFn` nor `c9`.
3. [integration] `POST /api/code-intel/index` for `acme/widgets` with commit `c2` and `src/private.ts` now declaring `beta`, while `record` is spied to reject, returns an error status, and `GET /api/code-intel/symbols?projectSlug=ci-intel&q=alpha` still finds `alpha` and `q=beta` finds nothing.
4. [integration] `POST /api/code-intel/index` by a project `viewer` returns 403 and the count of `codeintel.index.write` entries for `acme/widgets` is unchanged.
5. [unit] `AstIndexService.indexCommit(repoId, commitHash, files, projectId, onIndexed)` with stub collaborators and a transaction manager whose `run` sets a flag while its function runs, calls `onIndexed` once with `{ symbolsIndexed, filesIndexed }` equal to the returned result's, while the flag is set.
6. [unit] `AstIndexService.indexCommit` called with four arguments resolves its result as today, without an `onIndexed` call.
7. [unit] `CodeIntelOutboxSubscriber` with a stub `CodeCommitOutboxHandler` whose `process` captures `currentContext()` and calls its `onIndexed` with `{ symbolsIndexed: 3, filesIndexed: 1 }`, and a stub recorder, after `onModuleInit` and a `publish` of a `code_commit` record `{ repoId: 'acme/w', commitHash: 'c1', projectId: 'p-1', changedFiles: ['a.ts'] }` inside `runAsSystem('outbox', …)`, captures an actor `{ type: 'SYSTEM', id: 'codeintel' }` and calls `record` once with `key` `system.codeintel.index-commit`, `resourceType` `code-repo`, `resourceId` `acme/w`, `projectId` `p-1` and `summary` `indexed 3 symbols in 1 files`.
8. [unit] `CodeCommitOutboxHandler.process(payload, onIndexed)` with stubs that resolve a connection, a key and one fetched file passes `onIndexed` to `astIndexService.indexCommit` as its fifth argument.
9. [unit] `AstIndexService.indexCommit(repoId, commitHash, [], projectId, onIndexed)` with stub collaborators resolves zero counts without calling `onIndexed`.
10. [integration] A push for commit `p1` with `changedFiles` `['src/push.ts']`, the stub's `fetchCommitFiles` returning `src/push.ts` declaring `pushedFn`, resolves and leaves one entry for `acme/app` with `key` `system.codeintel.index-commit`, `resourceType` `code-repo`, `projectId` the project's id, `actorType` `SYSTEM`, `actorId` `codeintel`, `origin` `system` and `summary` `indexed <n> symbols in 1 files`, and `GET /api/code-intel/symbols?projectSlug=ci-intel&q=pushedFn` finds `pushedFn`.
11. [integration] A push for commit `p2` with `src/push2.ts` declaring `pushedTwo`, while `record` is spied to reject, rejects, and `GET /api/code-intel/symbols?projectSlug=ci-intel&q=pushedTwo` finds nothing.
