# Eliminate `forwardRef` in apps/api Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all 23 `forwardRef` usages in `apps/api` by converting the four circular module dependencies into a one-directional (acyclic) module graph.

**Architecture:** The cycles are driven by four root causes: (A) a "pull" Outbox fan-out hub that constructor-injects consumer services from four other modules; (B) a Rag↔Retrieval cycle caused by an eval endpoint living in the wrong controller; (C) an intra-`RagModule` provider cycle between `RagService` and `IncrementalGraphDiffService`; and (D) a `ProjectsModule` "god-module" that everyone imports for slug/membership lookup. We fix each by inverting control (push registration), relocating a controller, extracting a shared low-level writer, and extracting a leaf lookup module + event-based cache invalidation.

**Tech Stack:** NestJS 11, TypeScript strict, Jest, Prisma, Bun workspaces (Turborepo).

## Global Constraints

- Work only inside `apps/api/`. Do not touch `apps/web` or `apps/cli`.
- Run all commands from `apps/api/`. Test runner: `bun run test` (jest, ignores integration tests).
- Type-check with `bun run type-check` from `apps/api/`.
- After each phase, the app must boot cleanly: NestJS throws at bootstrap on a real remaining cycle, so a clean `bun run test` (which builds the DI graph in `Test.createTestingModule`) plus `bun run type-check` is the proof.
- No emojis in code or comments. Prefer immutability. No `console.log`.
- Do NOT edit generated files under `apps/cli/src/generated/`.
- The `document_indexed` `DEFAULT_HANDLERS` entry in `OutboxFanOutRegistry` stays where it is — it has no cross-module dependency.
- A handler must be registered before the `OutboxProcessor` first dispatches. `OutboxProcessor` is scheduler-driven and only runs after bootstrap, so registering in a subscriber's `onModuleInit()` is safe (this mirrors the existing `LexicalIndexWarmup`/`EntityStoreWarmup` pattern in `rag/rag.module.ts`).

---

## Phase Ordering & Leverage

Execute in this order. Each phase is independently shippable and leaves the build green.

1. **Phase 1 — Invert the Outbox hub (push model).** Highest leverage: removes ~12 edges and makes `OutboxModule` a leaf. This unblocks Phases 2 and 4.
2. **Phase 3 — Break the `RagService` ↔ `IncrementalGraphDiffService` intra-module cycle.** Self-contained inside `RagModule`.
3. **Phase 2 — Break `RagModule` ↔ `RetrievalModule`.** Relocate one controller endpoint.
4. **Phase 4 — Extract `ProjectAccessModule` leaf + invert cache invalidation.** Removes the remaining `ProjectsModule` cycles.

---

## File Structure

**Phase 1 — new subscriber files (one responsibility each: register outbox handlers for their module):**
- Create `apps/api/src/memory/memory-outbox.subscriber.ts`
- Create `apps/api/src/code-intel/code-intel-outbox.subscriber.ts`
- Create `apps/api/src/entity-graph/entity-graph-outbox.subscriber.ts`
- Create `apps/api/src/webhook/webhook-outbox.subscriber.ts`
- Modify `apps/api/src/outbox/outbox-fan-out-registry.ts` (strip cross-module injections)
- Modify module files: `outbox`, `memory`, `code-intel`, `entity-graph`, `webhook`, `rag`, `koda-domain-writer`

**Phase 3:**
- Create `apps/api/src/rag/vector-index-writer.ts`
- Modify `rag/rag.service.ts`, `rag/incremental-graph-diff.service.ts`, `rag/rag.module.ts`

**Phase 2:**
- Modify `rag/rag.controller.ts`, `rag/rag.module.ts`, `retrieval/retrieval.module.ts`
- Create `apps/api/src/retrieval/retrieval.controller.ts`

**Phase 4:**
- Create `apps/api/src/projects/project-access.module.ts`
- Create `apps/api/src/projects/project-access.service.ts`
- Modify `projects/projects.service.ts`, `projects/projects.module.ts`, `memory/memory.module.ts`, `context/context.module.ts`, `agents/agents.module.ts`, `code-intel/*`, and consumers of `ProjectsService.findProjectIdBySlug`/`assertProjectMembership`

---

# Phase 1 — Invert the Outbox fan-out (push model)

**Root cause:** `OutboxFanOutRegistry` constructor-injects `ExtractionService`, `PrismaMemoryItemRepository`, `AstIndexService`, `CodeCommitOutboxHandler`, `EntityGraphService`, and `WebhookDeliveryHandler`. This forces `OutboxModule` to import Memory, CodeIntel, EntityGraph, and Webhook — all of which import `OutboxModule` back. We move each handler into a subscriber owned by the module that has the dependency; each subscriber depends one-way on `OutboxFanOutRegistry`.

**End state:** `OutboxModule` imports only `PrismaModule` + `ScheduleModule`. The registry keeps only `register`/`unregister`/`dispatch`/`getHandlers` mechanics + `DEFAULT_HANDLERS`.

> **PHASING CORRECTION (discovered during execution):** Adding a plain `consumer → OutboxModule` import (Tasks 1.1–1.4) while `OutboxModule` still imports that consumer creates an ESM temporal-dead-zone cycle that stack-overflows NestJS's module scanner — `code-intel.module.spec`, `vcs.module.spec`, etc. fail with "module at index [N] is undefined". Each subscriber task should therefore ALSO remove its matching `OutboxModule → consumer` import in the same change. Because Tasks 1.1–1.3 were already committed without that removal, a consolidation step (Task 1.3-fix) removes the Memory/EntityGraph/CodeIntel imports from `OutboxModule` together and restores a green tree. `WebhookModule` stays in `OutboxModule`'s imports (as the original both-`forwardRef` cycle, which is valid) until Task 1.4 lands its subscriber. The registry's now-unused `@Optional()` cross-module injections resolve to `undefined` harmlessly until Task 1.5 strips them.

### Task 1.1: Memory outbox subscriber

**Files:**
- Create: `apps/api/src/memory/memory-outbox.subscriber.ts`
- Test: `apps/api/src/memory/memory-outbox.subscriber.spec.ts`
- Modify: `apps/api/src/memory/memory.module.ts`

**Interfaces:**
- Consumes: `OutboxFanOutRegistry.register(eventType: string, handler: (payload: unknown) => void | Promise<void>): void` (from `outbox/outbox-fan-out-registry.ts`); `ExtractionService.extractFromEvent(event: CanonicalEvent): MemoryExtractedItem[]`; `PrismaMemoryItemRepository.upsert(input: MemoryItemInput): Promise<...>`.
- Produces: `MemoryOutboxSubscriber` (registers `ticket_event` and `agent_event` handlers on module init).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/memory/memory-outbox.subscriber.spec.ts
import { Test } from '@nestjs/testing';
import { MemoryOutboxSubscriber } from './memory-outbox.subscriber';
import { ExtractionService } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

describe('MemoryOutboxSubscriber', () => {
  it('registers ticket_event and agent_event on init and persists extracted items', async () => {
    const registry = new OutboxFanOutRegistry();
    const extraction = {
      extractFromEvent: jest.fn().mockReturnValue([
        { projectId: 'p1', kind: 'fact', subject: 's', predicate: 'p', object: 'o', sourceType: 'ticket', sourceId: 't1', confidence: 1 },
      ]),
    } as unknown as ExtractionService;
    const repo = { upsert: jest.fn().mockResolvedValue(undefined) } as unknown as PrismaMemoryItemRepository;

    const subscriber = new MemoryOutboxSubscriber(registry, extraction, repo);
    subscriber.onModuleInit();

    expect(registry.getHandlers('ticket_event').length).toBe(1);
    expect(registry.getHandlers('agent_event').length).toBe(1);

    await registry.dispatch({
      eventType: 'ticket_event',
      payload: { type: 'ticket_event', id: 'e1', ticketId: 't1', projectId: 'p1', actorId: 'a1', action: 'created', data: {}, timestamp: new Date().toISOString() },
    });

    expect(extraction.extractFromEvent).toHaveBeenCalled();
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- memory-outbox.subscriber`
Expected: FAIL — `Cannot find module './memory-outbox.subscriber'`.

- [ ] **Step 3: Write the subscriber**

```typescript
// apps/api/src/memory/memory-outbox.subscriber.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ExtractionService, MemoryExtractedItem } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItemInput } from './memory-item-repository';
import { MemoryKind } from '../common/enums';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

@Injectable()
export class MemoryOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(MemoryOutboxSubscriber.name);

  constructor(
    private readonly registry: OutboxFanOutRegistry,
    private readonly extractionService: ExtractionService,
    private readonly memoryRepository: PrismaMemoryItemRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handleTicketEvent.bind(this));
    this.registry.register('agent_event', this.handleAgentEvent.bind(this));
    this.logger.debug('Memory outbox handlers registered');
  }

  private async persistExtractedItems(items: MemoryExtractedItem[]): Promise<void> {
    for (const item of items) {
      const input: MemoryItemInput = {
        projectId: item.projectId,
        kind: item.kind as MemoryKind,
        subject: item.subject,
        predicate: item.predicate,
        object: item.object,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        confidence: item.confidence,
        ttlAt: item.ttlAt ?? null,
      };
      await this.memoryRepository.upsert(input);
    }
  }

  private async handleTicketEvent(payload: unknown): Promise<void> {
    const event = payload as { type: string; id: string; ticketId?: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
    const items = this.extractionService.extractFromEvent({
      ...event,
      type: 'ticket_event' as const,
      timestamp: new Date(event.timestamp),
    });
    await this.persistExtractedItems(items);
  }

  private async handleAgentEvent(payload: unknown): Promise<void> {
    const event = payload as { type: string; id: string; agentId: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
    const items = this.extractionService.extractFromEvent({
      ...event,
      type: 'agent_event' as const,
      timestamp: new Date(event.timestamp),
    });
    await this.persistExtractedItems(items);
  }
}
```

- [ ] **Step 4: Register the subscriber in `MemoryModule`**

Edit `apps/api/src/memory/memory.module.ts`: add the import for `OutboxModule` and `MemoryOutboxSubscriber`, add `OutboxModule` to `imports`, and add `MemoryOutboxSubscriber` to `providers`.

```typescript
// add imports at top
import { OutboxModule } from '../outbox/outbox.module';
import { MemoryOutboxSubscriber } from './memory-outbox.subscriber';

// in @Module: imports becomes
imports: [PrismaModule, forwardRef(() => ProjectsModule), OutboxModule],
// in providers add MemoryOutboxSubscriber (alongside existing providers)
```

Note: the `forwardRef(() => ProjectsModule)` on the same line is removed later in Phase 4. Leave it for now. Adding a plain (non-forwardRef) `OutboxModule` import is safe because after Task 1.5, `OutboxModule` no longer imports `MemoryModule`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- memory-outbox.subscriber`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/memory/memory-outbox.subscriber.ts apps/api/src/memory/memory-outbox.subscriber.spec.ts apps/api/src/memory/memory.module.ts
git commit -m "refactor(outbox): push memory outbox handlers via MemoryOutboxSubscriber"
```

### Task 1.2: EntityGraph outbox subscriber

**Files:**
- Create: `apps/api/src/entity-graph/entity-graph-outbox.subscriber.ts`
- Test: `apps/api/src/entity-graph/entity-graph-outbox.subscriber.spec.ts`
- Modify: `apps/api/src/entity-graph/entity-graph.module.ts`

**Interfaces:**
- Consumes: `OutboxFanOutRegistry.register`; `EntityGraphService.onTicketEvent(event)`; `EntityGraphService.onGraphifyImport(projectId, nodes, links)`.
- Produces: `EntityGraphOutboxSubscriber` (registers `ticket_event`, `graphify_import`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/entity-graph/entity-graph-outbox.subscriber.spec.ts
import { EntityGraphOutboxSubscriber } from './entity-graph-outbox.subscriber';
import { EntityGraphService } from './entity-graph.service';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

describe('EntityGraphOutboxSubscriber', () => {
  it('registers ticket_event and graphify_import and forwards to EntityGraphService', async () => {
    const registry = new OutboxFanOutRegistry();
    const svc = {
      onTicketEvent: jest.fn().mockResolvedValue(undefined),
      onGraphifyImport: jest.fn().mockResolvedValue(undefined),
    } as unknown as EntityGraphService;

    new EntityGraphOutboxSubscriber(registry, svc).onModuleInit();

    expect(registry.getHandlers('ticket_event').length).toBe(1);
    expect(registry.getHandlers('graphify_import').length).toBe(1);

    await registry.dispatch({
      eventType: 'graphify_import',
      payload: { projectId: 'p1', nodes: [{ nodeId: 'n1', type: 't', label: 'l' }], links: [] },
    });
    expect(svc.onGraphifyImport).toHaveBeenCalledWith('p1', [{ nodeId: 'n1', type: 't', label: 'l', tags: undefined, metadata: undefined }], []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- entity-graph-outbox.subscriber`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the subscriber**

```typescript
// apps/api/src/entity-graph/entity-graph-outbox.subscriber.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EntityGraphService } from './entity-graph.service';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

@Injectable()
export class EntityGraphOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(EntityGraphOutboxSubscriber.name);

  constructor(
    private readonly registry: OutboxFanOutRegistry,
    private readonly entityGraphService: EntityGraphService,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handleTicketEvent.bind(this));
    this.registry.register('graphify_import', this.handleGraphifyImport.bind(this));
    this.logger.debug('EntityGraph outbox handlers registered');
  }

  private async handleTicketEvent(payload: unknown): Promise<void> {
    const p = payload as {
      type: string; id: string; ticketId?: string; projectId: string;
      actorId: string; action: string; data: Record<string, unknown>; timestamp: string;
    };
    await this.entityGraphService.onTicketEvent({
      type: 'ticket_event',
      id: p.id,
      ticketId: p.ticketId,
      projectId: p.projectId,
      actorId: p.actorId,
      action: p.action,
      data: p.data ?? {},
      timestamp: new Date(p.timestamp),
    });
  }

  private async handleGraphifyImport(payload: unknown): Promise<void> {
    const p = payload as {
      projectId: string;
      nodes?: Array<{ nodeId: string; type: string; label: string; tags?: string[]; metadata?: Record<string, unknown> }>;
      links?: Array<{ sourceId: string; targetId: string; relation: string }>;
    };
    const nodes = (p.nodes ?? []).map((n) => ({
      nodeId: n.nodeId,
      type: n.type,
      label: n.label,
      tags: n.tags,
      metadata: n.metadata,
    }));
    const links = (p.links ?? []).map((l) => ({
      sourceId: l.sourceId,
      targetId: l.targetId,
      relation: l.relation,
    }));
    await this.entityGraphService.onGraphifyImport(p.projectId, nodes, links);
  }
}
```

- [ ] **Step 4: Register in `EntityGraphModule`**

Edit `apps/api/src/entity-graph/entity-graph.module.ts`: import `OutboxModule` and `EntityGraphOutboxSubscriber`, add `OutboxModule` to `imports`, add `EntityGraphOutboxSubscriber` to `providers`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- entity-graph-outbox.subscriber`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/entity-graph/entity-graph-outbox.subscriber.ts apps/api/src/entity-graph/entity-graph-outbox.subscriber.spec.ts apps/api/src/entity-graph/entity-graph.module.ts
git commit -m "refactor(outbox): push entity-graph outbox handlers via subscriber"
```

### Task 1.3: CodeIntel outbox subscriber

**Files:**
- Create: `apps/api/src/code-intel/code-intel-outbox.subscriber.ts`
- Test: `apps/api/src/code-intel/code-intel-outbox.subscriber.spec.ts`
- Modify: `apps/api/src/code-intel/code-intel.module.ts`

**Interfaces:**
- Consumes: `OutboxFanOutRegistry.register`; `CodeCommitOutboxHandler.process(payload: Record<string, unknown>): Promise<void>`; `AstIndexService.indexCommit(repoId, commitHash, changedFiles, projectId)`.
- Produces: `CodeIntelOutboxSubscriber` (registers `code_commit`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/code-intel/code-intel-outbox.subscriber.spec.ts
import { CodeIntelOutboxSubscriber } from './code-intel-outbox.subscriber';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { AstIndexService } from './ast-index.service';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

describe('CodeIntelOutboxSubscriber', () => {
  it('registers code_commit and delegates to CodeCommitOutboxHandler when present', async () => {
    const registry = new OutboxFanOutRegistry();
    const handler = { process: jest.fn().mockResolvedValue(undefined) } as unknown as CodeCommitOutboxHandler;

    new CodeIntelOutboxSubscriber(registry, handler, undefined).onModuleInit();
    expect(registry.getHandlers('code_commit').length).toBe(1);

    await registry.dispatch({ eventType: 'code_commit', payload: { repoId: 'r', commitHash: 'c', projectId: 'p' } });
    expect(handler.process).toHaveBeenCalledTimes(1);
  });

  it('falls back to AstIndexService.indexCommit when no CodeCommitOutboxHandler', async () => {
    const registry = new OutboxFanOutRegistry();
    const ast = { indexCommit: jest.fn().mockResolvedValue(undefined) } as unknown as AstIndexService;

    new CodeIntelOutboxSubscriber(registry, undefined, ast).onModuleInit();
    await registry.dispatch({
      eventType: 'code_commit',
      payload: { repoId: 'r', commitHash: 'c', projectId: 'p', changedFiles: [{ path: 'a.ts', content: 'x' }] },
    });
    expect(ast.indexCommit).toHaveBeenCalledWith('r', 'c', [{ path: 'a.ts', content: 'x' }], 'p');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- code-intel-outbox.subscriber`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the subscriber** (body moved verbatim from the registry's `handleCodeCommit`)

```typescript
// apps/api/src/code-intel/code-intel-outbox.subscriber.ts
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AstIndexService, SourceFile } from './ast-index.service';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

@Injectable()
export class CodeIntelOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(CodeIntelOutboxSubscriber.name);

  constructor(
    private readonly registry: OutboxFanOutRegistry,
    @Optional() private readonly codeCommitHandler?: CodeCommitOutboxHandler,
    @Optional() private readonly astIndexService?: AstIndexService,
  ) {}

  onModuleInit(): void {
    if (this.codeCommitHandler || this.astIndexService) {
      this.registry.register('code_commit', this.handleCodeCommit.bind(this));
      this.logger.debug('CodeIntel outbox handler registered');
    }
  }

  private async handleCodeCommit(payload: unknown): Promise<void> {
    const p = payload as Record<string, unknown>;
    const repoId = p.repoId as string | undefined;
    const commitHash = p.commitHash as string | undefined;
    const projectId = p.projectId as string | undefined;
    const webhookOnly = p.webhookOnly as boolean | undefined;
    const changedFiles = (p.changedFiles as SourceFile[] | undefined)
      ?? (p.files as SourceFile[] | undefined);

    if (this.codeCommitHandler) {
      this.logger.debug('code_commit: delegating to CodeCommitOutboxHandler');
      await this.codeCommitHandler.process(p);
      return;
    }

    if (webhookOnly) {
      this.logger.warn('code_commit: webhook payload requires CodeCommitOutboxHandler, but it is not registered');
      return;
    }

    if (!changedFiles || !Array.isArray(changedFiles) || changedFiles.length === 0) {
      this.logger.debug('code_commit: no changed files provided');
      return;
    }

    if (!repoId || !commitHash || !projectId) {
      this.logger.debug('code_commit: missing required fields (repoId, commitHash, projectId)');
      return;
    }

    if (!this.astIndexService) return;

    this.logger.log(`code_commit: indexing ${repoId} ${commitHash} (${changedFiles.length} files)`);
    await this.astIndexService.indexCommit(repoId, commitHash, changedFiles, projectId);
  }
}
```

- [ ] **Step 4: Register in `CodeIntelModule`**

Edit `apps/api/src/code-intel/code-intel.module.ts`: import `OutboxModule` and `CodeIntelOutboxSubscriber`, add `OutboxModule` to `imports`, add `CodeIntelOutboxSubscriber` to `providers`. (The `forwardRef(() => RagModule)` and `forwardRef(() => ProjectsModule)` on the imports line are addressed in later phases — leave them.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- code-intel-outbox.subscriber`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/code-intel/code-intel-outbox.subscriber.ts apps/api/src/code-intel/code-intel-outbox.subscriber.spec.ts apps/api/src/code-intel/code-intel.module.ts
git commit -m "refactor(outbox): push code-intel outbox handler via subscriber"
```

### Task 1.4: Webhook outbox subscriber

**Files:**
- Create: `apps/api/src/webhook/webhook-outbox.subscriber.ts`
- Test: `apps/api/src/webhook/webhook-outbox.subscriber.spec.ts`
- Modify: `apps/api/src/webhook/webhook.module.ts`

**Interfaces:**
- Consumes: `OutboxFanOutRegistry.register`; `WebhookDeliveryHandler.handle(input: WebhookDeliveryPayload): Promise<void>`.
- Produces: `WebhookOutboxSubscriber` (registers `webhook_delivery`).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/webhook/webhook-outbox.subscriber.spec.ts
import { WebhookOutboxSubscriber } from './webhook-outbox.subscriber';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

describe('WebhookOutboxSubscriber', () => {
  it('registers webhook_delivery and forwards payload to WebhookDeliveryHandler', async () => {
    const registry = new OutboxFanOutRegistry();
    const deliveryHandler = { handle: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookDeliveryHandler;

    new WebhookOutboxSubscriber(registry, deliveryHandler).onModuleInit();
    expect(registry.getHandlers('webhook_delivery').length).toBe(1);

    const payload = { deliveryId: 'd1' };
    await registry.dispatch({ eventType: 'webhook_delivery', payload });
    expect(deliveryHandler.handle).toHaveBeenCalledWith(payload);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- webhook-outbox.subscriber`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the subscriber**

```typescript
// apps/api/src/webhook/webhook-outbox.subscriber.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WebhookDeliveryHandler, WebhookDeliveryPayload } from './webhook-delivery.handler';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

@Injectable()
export class WebhookOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(WebhookOutboxSubscriber.name);

  constructor(
    private readonly registry: OutboxFanOutRegistry,
    private readonly webhookDeliveryHandler: WebhookDeliveryHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register('webhook_delivery', this.handleWebhookDelivery.bind(this));
    this.logger.debug('Webhook outbox handler registered');
  }

  private async handleWebhookDelivery(payload: unknown): Promise<void> {
    await this.webhookDeliveryHandler.handle(payload as WebhookDeliveryPayload);
  }
}
```

- [ ] **Step 4: Register in `WebhookModule`, change its Outbox import to plain, AND make `OutboxModule` a leaf**

Per the PHASING CORRECTION above, this task must break the last Outbox cycle by removing the reverse edge in the SAME change (otherwise a plain `Webhook→Outbox` edge coexisting with `Outbox→Webhook` re-creates the ESM TDZ cycle).

Edit `apps/api/src/webhook/webhook.module.ts`:
- Remove `forwardRef` from the import list and from `@nestjs/common` if now unused.
- Change `imports: [PrismaModule, forwardRef(() => OutboxModule)]` to `imports: [PrismaModule, OutboxModule]`.
- Add `WebhookOutboxSubscriber` to `providers`.
- Delete the two-line `// OutboxModule imports WebhookModule via forwardRef ...` comment.

Edit `apps/api/src/outbox/outbox.module.ts`:
- Remove `forwardRef(() => WebhookModule)` from `imports` and delete the `import { WebhookModule } ...` line and the unused `forwardRef` from `@nestjs/common`. After this, `imports: [PrismaModule, ScheduleModule]` — `OutboxModule` is now a pure leaf.
- (The Memory/EntityGraph/CodeIntel imports were already removed by Task 1.3-fix.)

The registry's `@Optional() webhookDeliveryHandler` now resolves to `undefined` and its internal `webhook_delivery` handler no longer registers — the `WebhookOutboxSubscriber` registers it instead. Behavior preserved.

- [ ] **Step 5: Verify — focused test + FULL suite**

Run the focused test: `npx jest webhook-outbox.subscriber` → PASS.
Run the FULL unit suite: `npx jest --testPathIgnorePatterns=integration 2>&1 | tail -15` → all suites/tests must pass (this is the real gate — `OutboxModule` is now a leaf, so the whole Outbox cycle set must be resolved). Also `bun run type-check` clean.
Note: `bun run test -- <pattern>` does NOT filter in this environment — use `npx jest <path>`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/webhook/webhook-outbox.subscriber.ts apps/api/src/webhook/webhook-outbox.subscriber.spec.ts apps/api/src/webhook/webhook.module.ts apps/api/src/outbox/outbox.module.ts
git commit -m "refactor(outbox): push webhook delivery handler via subscriber; make OutboxModule a leaf"
```

### Task 1.5: Strip cross-module injections from `OutboxFanOutRegistry` and make `OutboxModule` a leaf

**Files:**
- Modify: `apps/api/src/outbox/outbox-fan-out-registry.ts`
- Modify: `apps/api/src/outbox/outbox-fan-out-registry.spec.ts`
- Modify: `apps/api/src/outbox/outbox.module.ts`

**Interfaces:**
- Produces: `OutboxFanOutRegistry` with a **zero-argument constructor** and only `register`/`unregister`/`dispatch`/`getHandlers`/`consumeLastDispatchFailureCount` + the `document_indexed` `DEFAULT_HANDLERS` entry.

- [ ] **Step 1: Update the registry spec first (drive the new shape)**

In `apps/api/src/outbox/outbox-fan-out-registry.spec.ts` (verified: 17 `it()` cases), delete:
- the `describe('AC45: graphify_import payload structure', ...)` block (its handler moved to Task 1.2's subscriber), and
- the `describe('webhook_delivery fan-out', ...)` block — this block contains **AC1, AC2, and AC3**; AC2/AC3 specifically assert the old constructor-injected `webhookDeliveryHandler` behavior, which no longer exists, so the whole block goes (moved to Task 1.4's subscriber).

Keep AC39, AC40, the duplicate/unregister cases, **AC41 (DEFAULT_HANDLERS length)**, AC42, AC43, **AC44 (document_indexed payload — no cross-module dep)**, and AC25. Confirm every remaining `new OutboxFanOutRegistry(...)` is called with **no arguments**.

- [ ] **Step 2: Run the spec to verify the removed-behavior tests are gone and the rest still reference the old constructor**

Run: `bun run test -- outbox-fan-out-registry`
Expected: PASS on the kept mechanics tests (registry still has its injected fields at this point, but they are all `@Optional()` so a no-arg construction already works). If any kept test failed, it means it depended on a removed behavior — move that assertion to the relevant subscriber spec.

- [ ] **Step 3: Rewrite the registry — remove all cross-module imports and constructor params**

Replace the top imports and the constructor/`onModuleInit`/moved handler methods. The file becomes:

```typescript
// apps/api/src/outbox/outbox-fan-out-registry.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface OutboxHandler {
  eventType: string;
  handler: (payload: unknown) => void | Promise<void>;
}

export const DEFAULT_HANDLERS: OutboxHandler[] = [
  {
    eventType: 'document_indexed',
    handler: async (payload: unknown) => {
      const p = payload as { sourceId: string; content: string; metadata: Record<string, unknown> };
      new Logger('OutboxFanOutRegistry').debug(`document_indexed: ${p.sourceId}`);
    },
  },
];

@Injectable()
export class OutboxFanOutRegistry implements OnModuleInit {
  private readonly logger = new Logger(OutboxFanOutRegistry.name);
  private handlers: Map<string, Array<(payload: unknown) => void | Promise<void>>> = new Map();
  private lastDispatchFailureCount = 0;

  constructor() {
    for (const { eventType, handler } of DEFAULT_HANDLERS) {
      this.register(eventType, handler);
    }
  }

  onModuleInit(): void {
    const total = [...this.handlers.values()].reduce((sum, list) => sum + list.length, 0);
    this.logger.log(`Registered ${total} handlers across ${this.handlers.size} event types`);
  }

  register(eventType: string, handler: (payload: unknown) => void | Promise<void>): void {
    const existing = this.handlers.get(eventType) || [];
    if (!existing.includes(handler)) {
      this.handlers.set(eventType, [...existing, handler]);
    }
  }

  unregister(eventType: string, handler: (payload: unknown) => void | Promise<void>): void {
    const existing = this.handlers.get(eventType) || [];
    const filtered = existing.filter((h) => h !== handler);
    if (filtered.length > 0) {
      this.handlers.set(eventType, filtered);
    } else {
      this.handlers.delete(eventType);
    }
  }

  async dispatch(input: { eventType: string; payload: unknown }): Promise<void> {
    this.lastDispatchFailureCount = 0;
    const handlers = this.handlers.get(input.eventType) || [];
    this.logger.debug(`Dispatching eventType=${input.eventType}, found ${handlers.length} handlers`);
    for (const handler of handlers) {
      try {
        await Promise.resolve(handler(input.payload));
      } catch (error) {
        this.logger.error(`Handler for ${input.eventType} failed`, error);
        this.lastDispatchFailureCount += 1;
      }
    }
  }

  getHandlers(eventType: string): Array<(payload: unknown) => void | Promise<void>> {
    return this.handlers.get(eventType) || [];
  }

  consumeLastDispatchFailureCount(): number {
    const failures = this.lastDispatchFailureCount;
    this.lastDispatchFailureCount = 0;
    return failures;
  }
}
```

Note: the `onModuleInit` count now reflects `document_indexed` (1) plus whatever subscribers registered. `AC41: getHandlers() length equals DEFAULT_HANDLERS.length` still passes because `DEFAULT_HANDLERS` is unchanged, and `AC44: document_indexed payload` still passes because that handler stays in the registry.

- [ ] **Step 4: Make `OutboxModule` a leaf**

Edit `apps/api/src/outbox/outbox.module.ts`:
- Remove imports of `MemoryModule`, `CodeIntelModule`, `WebhookModule`, and `EntityGraphModule`, and remove `forwardRef` from `@nestjs/common`.
- Delete the multi-line cycle comment.
- `imports` becomes:

```typescript
imports: [PrismaModule, ScheduleModule],
```

**Also (added during execution):** once `OutboxModule` no longer imports `EntityGraphModule`, the temporary `forwardRef(() => OutboxModule)` that Task 1.2 added to `apps/api/src/entity-graph/entity-graph.module.ts` becomes an unnecessary forwardRef — convert it to a plain `OutboxModule` import in this task (and drop `forwardRef` from that file's `@nestjs/common` import if now unused). Task 1.2 had to use forwardRef there only because `OutboxModule` still plain-imported `EntityGraphModule`; removing that import here resolves it.

Providers and exports are unchanged (`OutboxService`, `OutboxFanOutRegistry`, `OutboxProcessor`, `PrismaOutboxRepository`, `OUTBOX_REPOSITORY`; exports `OutboxService`, `OutboxFanOutRegistry`).

- [ ] **Step 5: Fix `RagModule` and `KodaDomainWriterModule` Outbox imports to plain**

Edit `apps/api/src/rag/rag.module.ts`: change `forwardRef(() => OutboxModule)` to `OutboxModule` in the `imports` array; delete the two-line cycle comment above it. (Keep `forwardRef(() => RetrievalModule)` — removed in Phase 2.)

Edit `apps/api/src/koda-domain-writer/koda-domain-writer.module.ts`: change `forwardRef(() => OutboxModule)` to `OutboxModule`. (Keep `forwardRef(() => RagModule)` — removed in Phase 3/verification.)

- [ ] **Step 6: Type-check and run the full api test suite**

Run: `bun run type-check`
Expected: no errors.

Run: `bun run test`
Expected: PASS. The DI graph now builds with `OutboxModule` as a leaf; if any module still forms an Outbox cycle, `Test.createTestingModule(...).compile()` would throw "Nest cannot create the module instance. A circular dependency..." — a clean run confirms the hub is broken.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/outbox/ apps/api/src/rag/rag.module.ts apps/api/src/koda-domain-writer/koda-domain-writer.module.ts
git commit -m "refactor(outbox): make OutboxModule a leaf; strip cross-module handler injection"
```

---

# Phase 3 — Break `RagService` ↔ `IncrementalGraphDiffService`

**Root cause:** `IncrementalGraphDiffService` calls only two low-level vector primitives on `RagService`: `deleteBySource(projectId, sourceId)` and `indexDocument(projectId, doc)`. `RagService` calls `incrementalDiff.diffAndApply(...)`. Both live in `RagModule`, so this is a provider construction cycle expressed with `@Inject(forwardRef())` on both sides. We extract those two primitives into a `VectorIndexWriter` provider that both depend on; the back-edge disappears.

**Confirmed signatures (from `rag/rag.service.ts`):**
- `async indexDocument(projectId: string, doc: IndexDocumentInput): Promise<void>` (line 404)
- `async deleteBySource(projectId: string, sourceId: string): Promise<void>` (line 680)

### Task 3.1: Extract `VectorIndexWriter`

**Files:**
- Create: `apps/api/src/rag/vector-index-writer.ts`
- Test: `apps/api/src/rag/vector-index-writer.spec.ts`
- Modify: `apps/api/src/rag/rag.service.ts`, `apps/api/src/rag/incremental-graph-diff.service.ts`, `apps/api/src/rag/rag.module.ts`

**Interfaces:**
- Produces: `VectorIndexWriter` with `indexDocument(projectId: string, doc: IndexDocumentInput): Promise<void>` and `deleteBySource(projectId: string, sourceId: string): Promise<void>` — the same signatures currently on `RagService`.
- Consumes: whatever `RagService.indexDocument`/`deleteBySource` currently depend on internally (embedding client, LanceDB/vector store, the sequencing mutex referenced near line 320). **Before writing code, read `rag/rag.service.ts` lines 300–700 to capture the exact private dependencies and the sequencing lock so they move together.**

- [ ] **Step 1: Read the two method bodies and their private helpers**

Run: `sed -n '300,720p' apps/api/src/rag/rag.service.ts`
Record: the fields/injected deps used inside `indexDocument` and `deleteBySource` (embedding service, vector store, the "sequence overlapping reload()" mutex noted in the file), and any private helpers they call. These move into `VectorIndexWriter`.

- [ ] **Step 2: Write the failing characterization test**

```typescript
// apps/api/src/rag/vector-index-writer.spec.ts
import { VectorIndexWriter } from './vector-index-writer';

describe('VectorIndexWriter', () => {
  it('exposes indexDocument and deleteBySource', () => {
    expect(typeof VectorIndexWriter.prototype.indexDocument).toBe('function');
    expect(typeof VectorIndexWriter.prototype.deleteBySource).toBe('function');
  });
});
```

(Extend this test with the concrete embedding/vector-store mocks discovered in Step 1 to assert the moved behavior — e.g. `indexDocument` embeds then upserts, `deleteBySource` deletes by source id. Mirror the assertions currently in `rag/rag.service.spec.ts` for these two methods so behavior is pinned before moving.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- vector-index-writer`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `VectorIndexWriter`** — move the `indexDocument`/`deleteBySource` bodies and their private helpers/deps out of `RagService` into this `@Injectable()`. Keep the exact signatures and the sequencing lock.

- [ ] **Step 5: Delegate from `RagService`**

In `rag/rag.service.ts`: inject `private readonly vectorIndexWriter: VectorIndexWriter` and replace the two method bodies with delegation:

```typescript
async indexDocument(projectId: string, doc: IndexDocumentInput): Promise<void> {
  return this.vectorIndexWriter.indexDocument(projectId, doc);
}

async deleteBySource(projectId: string, sourceId: string): Promise<void> {
  return this.vectorIndexWriter.deleteBySource(projectId, sourceId);
}
```

Update the internal caller at `rag.service.ts:873` if it called the private helper directly — it should call `this.vectorIndexWriter.indexDocument(...)` or the retained public method.

- [ ] **Step 6: Repoint `IncrementalGraphDiffService` and remove its forwardRef**

In `rag/incremental-graph-diff.service.ts`:
- Replace `import { RagService } from './rag.service';` with `import { VectorIndexWriter } from './vector-index-writer';`.
- Change the constructor param `@Inject(forwardRef(() => RagService)) private readonly rag: RagService` to `private readonly vectorIndex: VectorIndexWriter`.
- Remove `Inject, forwardRef` from the `@nestjs/common` import if now unused.
- Replace the three call sites: `this.rag.deleteBySource(...)` → `this.vectorIndex.deleteBySource(...)` (lines 83, 87) and `this.rag.indexDocument(...)` → `this.vectorIndex.indexDocument(...)` (line ~175).

- [ ] **Step 7: Remove the reciprocal forwardRef in `RagService`**

In `rag/rag.service.ts`: the constructor param `@Optional() @Inject(forwardRef(() => IncrementalGraphDiffService)) private readonly incrementalDiff?: IncrementalGraphDiffService` — since `IncrementalGraphDiffService` no longer depends on `RagService`, drop the `forwardRef`: `@Optional() @Inject(IncrementalGraphDiffService) private readonly incrementalDiff?: IncrementalGraphDiffService` (or plain `@Optional() private readonly incrementalDiff?: IncrementalGraphDiffService`). Remove `forwardRef` from the `@nestjs/common` import if now unused.

- [ ] **Step 8: Register `VectorIndexWriter` in `RagModule`**

In `rag/rag.module.ts`: add `VectorIndexWriter` to `providers` (before `RagService` for readability) and to `exports` if any other module needs it (it does not yet — keep it internal).

- [ ] **Step 9: Type-check and test**

Run: `bun run type-check` — Expected: no errors.
Run: `bun run test -- rag` — Expected: PASS (rag.service, incremental-graph-diff, vector-index-writer specs).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/rag/vector-index-writer.ts apps/api/src/rag/vector-index-writer.spec.ts apps/api/src/rag/rag.service.ts apps/api/src/rag/incremental-graph-diff.service.ts apps/api/src/rag/rag.module.ts apps/api/src/rag/rag.service.spec.ts
git commit -m "refactor(rag): extract VectorIndexWriter to break RagService<->IncrementalGraphDiff cycle"
```

---

# Phase 2 — Break `RagModule` ↔ `RetrievalModule`

**Root cause:** `RagController` injects `EvaluationService` (from `RetrievalModule`) for the `POST rag/evaluate/retrieval` endpoint (`rag.controller.ts:209`). `EvaluationService` only needs `HybridRetrieverService` (from `RagModule`). So `RagModule → RetrievalModule → RagModule`. Move the endpoint into `RetrievalModule`, which keeps its one-way dependency on `RagModule`.

### Task 2.1: Relocate the retrieval-eval endpoint

**Files:**
- Create: `apps/api/src/retrieval/retrieval.controller.ts`
- Test: `apps/api/src/retrieval/retrieval.controller.spec.ts`
- Modify: `apps/api/src/rag/rag.controller.ts`, `apps/api/src/rag/rag.controller.spec.ts`, `apps/api/src/rag/rag.module.ts`, `apps/api/src/retrieval/retrieval.module.ts`

**Interfaces:**
- Consumes: `EvaluationService.runQueries(queries: EvalQuery[]): Promise<EvalSummary>`; `loadEvalQueries` from `retrieval/load-queries`.
- Produces: a controller exposing the same route + payload the current `RagController.evaluateRetrieval` exposes.

- [ ] **Step 1: Read the current endpoint to copy it exactly**

Run: `sed -n '200,240p' apps/api/src/rag/rag.controller.ts`
Record the decorators (route path `evaluate/retrieval`, guards, `@ApiOperation`, DTO/body shape, and the `loadEvalQueries` dynamic import at line 222) so the moved controller is byte-identical in behavior. Preserve the full route path (if `RagController` has `@Controller('rag')`, the moved controller must use `@Controller('rag')` too, or the public URL changes — keep the URL identical).

- [ ] **Step 2: Write the failing test for the new controller**

```typescript
// apps/api/src/retrieval/retrieval.controller.spec.ts
import { Test } from '@nestjs/testing';
import { RetrievalController } from './retrieval.controller';
import { EvaluationService } from './evaluation.service';

describe('RetrievalController', () => {
  it('delegates evaluateRetrieval to EvaluationService.runQueries', async () => {
    const evaluationService = { runQueries: jest.fn().mockResolvedValue({ precisionAt5: 1 }) } as unknown as EvaluationService;
    const moduleRef = await Test.createTestingModule({
      controllers: [RetrievalController],
      providers: [{ provide: EvaluationService, useValue: evaluationService }],
    }).compile();
    const controller = moduleRef.get(RetrievalController);
    // Call with the same argument shape the old RagController.evaluateRetrieval used.
    const result = await controller.evaluateRetrieval(/* same params as original */);
    expect(evaluationService.runQueries).toHaveBeenCalled();
    expect(result).toEqual({ precisionAt5: 1 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- retrieval.controller`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `RetrievalController`** — copy `evaluateRetrieval` (and only that handler) verbatim from `RagController`, including decorators, guards, body DTO, and the `const { loadEvalQueries } = await import('./load-queries');` line (adjust the relative path from `../retrieval/load-queries` to `./load-queries`).

- [ ] **Step 5: Remove the endpoint + `EvaluationService` from `RagController`**

In `rag/rag.controller.ts`: delete the `evaluateRetrieval` method, the `import { EvaluationService } ...` line, and the `private readonly evaluationService: EvaluationService` constructor param. In `rag/rag.controller.spec.ts`: remove the `EvaluationService` provider mock and any `evaluateRetrieval` test cases (they now live in the retrieval controller spec).

- [ ] **Step 6: Rewire modules**

In `rag/rag.module.ts`: remove `RetrievalModule` from `imports` and delete its `import { RetrievalModule } ...` line. Remove `forwardRef` from `@nestjs/common` if now unused (Phase 1 already removed the Outbox forwardRef; after this, RagModule may have no forwardRef left).

In `retrieval/retrieval.module.ts`: change `imports: [forwardRef(() => RagModule)]` to `imports: [RagModule]`, remove `forwardRef` from `@nestjs/common`, and add `controllers: [RetrievalController]`.

- [ ] **Step 7: Type-check and test**

Run: `bun run type-check` — Expected: no errors.
Run: `bun run test -- retrieval rag.controller` — Expected: PASS.

- [ ] **Step 8: Verify the route still exists**

Run: `bun run api:export-spec` then `grep -c "evaluate/retrieval" ../../openapi.json`
Expected: count ≥ 1 (the endpoint URL is unchanged). Commit the regenerated `openapi.json` if it changed.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/retrieval/ apps/api/src/rag/rag.controller.ts apps/api/src/rag/rag.controller.spec.ts apps/api/src/rag/rag.module.ts openapi.json
git commit -m "refactor(retrieval): move retrieval-eval endpoint into RetrievalModule; drop Rag<->Retrieval forwardRef"
```

---

# Phase 4 — Extract `ProjectAccessModule` leaf + invert cache invalidation

**Root cause:** Two independent problems keep `ProjectsModule` in cycles:
1. **Inbound:** many modules import the full `ProjectsModule` just to call `ProjectsService.findProjectIdBySlug(slug)` and `ProjectsService.assertProjectMembership(projectId, principal)` (e.g. `code-intel.controller.ts:39,48`).
2. **Outbound:** `ProjectsService` imports `HybridRetrieverService` (RagModule) only to call `invalidateGraphifyEnabledCache(id)` on `graphifyEnabled` change (`projects.service.ts:161,201`), plus mandatory `RagService`.

We split the read-only lookup/authorization into a leaf `ProjectAccessModule` (no outbound deps), and invert the cache-invalidation call through the now-leaf Outbox.

### Task 4.1: Extract `ProjectAccessService` into a leaf module

**Files:**
- Create: `apps/api/src/projects/project-access.service.ts`
- Create: `apps/api/src/projects/project-access.module.ts`
- Test: `apps/api/src/projects/project-access.service.spec.ts`
- Modify: `apps/api/src/projects/projects.service.ts` (delegate), `apps/api/src/projects/projects.module.ts`

**Interfaces:**
- Produces: `ProjectAccessService` with `findProjectIdBySlug(slug: string): Promise<string>` (throws on not-found, matching current behavior) and `assertProjectMembership(projectId: string, principal: KodaPrincipal): Promise<void>` — same signatures currently on `ProjectsService` (verified: `projects.service.ts:167,173`). Backed only by `PrismaProjectRepository`.
- `ProjectAccessModule`: `imports: [PrismaModule]`, `providers/exports: [ProjectAccessService, PrismaProjectRepository, { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository }]`. No `RagModule`/`CodeIntelModule`/`AgentsModule` imports — this is a leaf.

- [ ] **Step 1: Read the two methods to move**

Run: `grep -n "findProjectIdBySlug\|assertProjectMembership" apps/api/src/projects/projects.service.ts` then read those method bodies. They depend only on `this.projectRepo` (PrismaProjectRepository) and principal types — confirm no `ragService`/`hybridRetrieverService` usage inside them (per earlier analysis they use neither).

- [ ] **Step 2: Write the failing test**

```typescript
// apps/api/src/projects/project-access.service.spec.ts
import { ProjectAccessService } from './project-access.service';
import { PrismaProjectRepository } from './prisma-project.repository';

describe('ProjectAccessService', () => {
  it('findProjectIdBySlug returns the repo result', async () => {
    const repo = { /* mock the exact method findProjectIdBySlug uses */ } as unknown as PrismaProjectRepository;
    const svc = new ProjectAccessService(repo);
    // assert against the same behavior the current ProjectsService.findProjectIdBySlug has
    expect(typeof svc.findProjectIdBySlug).toBe('function');
    expect(typeof svc.assertProjectMembership).toBe('function');
  });
});
```

(Flesh out the mock/assertions by mirroring the existing `ProjectsService` spec cases for these two methods.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test -- project-access.service`
Expected: FAIL — module not found.

- [ ] **Step 4: Create `ProjectAccessService`** — move the two method bodies verbatim (they depend only on `PrismaProjectRepository` and principal helpers). Create `ProjectAccessModule` as the leaf described in Interfaces.

- [ ] **Step 5: Delegate from `ProjectsService`**

In `projects.service.ts`: inject `private readonly access: ProjectAccessService` and replace the two methods with delegation:

```typescript
findProjectIdBySlug(slug: string): Promise<string> {
  return this.access.findProjectIdBySlug(slug);
}
assertProjectMembership(projectId: string, principal: KodaPrincipal): Promise<void> {
  return this.access.assertProjectMembership(projectId, principal);
}
```

In `projects.module.ts`: add `ProjectAccessModule` to `imports` and re-export `ProjectAccessService` so existing `ProjectsService` consumers are unaffected.

- [ ] **Step 6: Type-check and test**

Run: `bun run type-check && bun run test -- project-access projects`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/projects/project-access.service.ts apps/api/src/projects/project-access.module.ts apps/api/src/projects/project-access.service.spec.ts apps/api/src/projects/projects.service.ts apps/api/src/projects/projects.module.ts
git commit -m "refactor(projects): extract leaf ProjectAccessModule (slug + membership)"
```

### Task 4.2: Repoint slug/membership consumers to the leaf

**Files:**
- Modify: `apps/api/src/code-intel/code-intel.controller.ts` + its module; and any other file using `ProjectsService.findProjectIdBySlug`/`assertProjectMembership`.

- [ ] **Step 1: Find all consumers**

Run: `grep -rln "findProjectIdBySlug\|assertProjectMembership" apps/api/src --include="*.ts" | grep -v ".spec.ts" | grep -v "projects/"`
Record each file. For each, if it injects `ProjectsService` **only** for these two methods, switch it to `ProjectAccessService`.

- [ ] **Step 2: Repoint `code-intel.controller.ts`**

Change `import { ProjectsService } from '../projects/projects.service';` → `import { ProjectAccessService } from '../projects/project-access.service';`, rename the constructor param and its `this.projectsService.*` call sites (lines 39, 48) to `this.projectAccess.*`. In `code-intel.module.ts`: replace `forwardRef(() => ProjectsModule)` with `ProjectAccessModule`. Update `code-intel.controller.spec.ts` and `code-intel-search.controller.spec.ts` to provide `ProjectAccessService` instead of `ProjectsService`.

- [ ] **Step 3: Repeat for Context, Memory, Agents consumers** found in Step 1, replacing the full `ProjectsModule` import with `ProjectAccessModule` wherever only slug/membership is used. In `context.module.ts` remove `forwardRef(() => ProjectsModule)`; in `memory.module.ts` remove `forwardRef(() => ProjectsModule)` (added in Task 1.1 note); in `agents.module.ts` keep only what is still needed.

- [ ] **Step 4: Type-check and test**

Run: `bun run type-check && bun run test -- code-intel context memory agents`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/code-intel apps/api/src/context apps/api/src/memory apps/api/src/agents
git commit -m "refactor(projects): repoint slug/membership consumers to ProjectAccessModule leaf"
```

### Task 4.3: Invert `graphifyEnabled` cache invalidation via Outbox

**Files:**
- Modify: `apps/api/src/projects/projects.service.ts`, `apps/api/src/projects/projects.module.ts`
- Create: `apps/api/src/rag/hybrid-retriever-cache.subscriber.ts` (+ spec)
- Modify: `apps/api/src/rag/rag.module.ts`

**Interfaces:**
- Consumes: `OutboxService.enqueue(event: OutboxEventInput): Promise<OutboxEventData>` (already exported by the leaf `OutboxModule`). **`OutboxEventInput` (verified in `outbox/domain/outbox-event.domain.ts`) requires all four fields: `{ projectId: string; eventType: string; eventId: string; payload: unknown }`.** Also `OutboxFanOutRegistry.register`; `HybridRetrieverService.invalidateGraphifyEnabledCache(projectId: string): void`.
- Produces: outbox event `project_graphify_changed` with payload `{ projectId: string }`; a `HybridRetrieverCacheSubscriber` in `RagModule` that invalidates the cache on that event.

- [ ] **Step 1: Write the failing subscriber test**

```typescript
// apps/api/src/rag/hybrid-retriever-cache.subscriber.spec.ts
import { HybridRetrieverCacheSubscriber } from './hybrid-retriever-cache.subscriber';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

describe('HybridRetrieverCacheSubscriber', () => {
  it('invalidates graphify cache on project_graphify_changed', async () => {
    const registry = new OutboxFanOutRegistry();
    const hybrid = { invalidateGraphifyEnabledCache: jest.fn() } as unknown as HybridRetrieverService;
    new HybridRetrieverCacheSubscriber(registry, hybrid).onModuleInit();
    await registry.dispatch({ eventType: 'project_graphify_changed', payload: { projectId: 'p1' } });
    expect(hybrid.invalidateGraphifyEnabledCache).toHaveBeenCalledWith('p1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- hybrid-retriever-cache.subscriber`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the subscriber**

```typescript
// apps/api/src/rag/hybrid-retriever-cache.subscriber.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

@Injectable()
export class HybridRetrieverCacheSubscriber implements OnModuleInit {
  constructor(
    private readonly registry: OutboxFanOutRegistry,
    private readonly hybridRetriever: HybridRetrieverService,
  ) {}

  onModuleInit(): void {
    this.registry.register('project_graphify_changed', (payload: unknown) => {
      const p = payload as { projectId: string };
      this.hybridRetriever.invalidateGraphifyEnabledCache(p.projectId);
    });
  }
}
```

Register `HybridRetrieverCacheSubscriber` in `rag.module.ts` providers. `RagModule` already imports `OutboxModule` (plain, from Phase 1).

- [ ] **Step 4: Emit the event from `ProjectsService` instead of calling HybridRetriever**

In `projects.service.ts`:
- Remove `import { HybridRetrieverService } ...` and the `@Inject(forwardRef(() => HybridRetrieverService)) private hybridRetrieverService?: HybridRetrieverService` constructor param; remove `forwardRef, Inject` from `@nestjs/common` if now unused.
- Inject `private readonly outbox: OutboxService` (import from `../outbox/outbox.service`).
- Add `import { randomUUID } from 'node:crypto';` at the top (Node 22 global; used for the required `eventId`).
- Replace the two call sites (`update` ~line 161, `remove` ~line 201). Where it previously called `this.hybridRetrieverService?.invalidateGraphifyEnabledCache(id)`, enqueue instead — passing **all four required `OutboxEventInput` fields** (`projectId`, `eventType`, `eventId`, `payload`), matching the pattern in `tickets/tickets.service.ts:60`:

```typescript
await this.outbox.enqueue({
  projectId: updatedProject.id,
  eventType: 'project_graphify_changed',
  eventId: randomUUID(),
  payload: { projectId: updatedProject.id },
});
```

In `remove`, use `deletedProject.id` for both `projectId` and `payload.projectId`. A fresh `eventId` per call is correct: each toggle must trigger its own invalidation (no idempotency collapsing).

- [ ] **Step 5: Rewire `ProjectsModule` imports**

In `projects.module.ts`: add `OutboxModule` to `imports`. Remove `forwardRef(() => RagModule)` if `ProjectsService` no longer imports anything from RagModule. **Check `RagService` usage first:** `grep -n "ragService\|RagService" projects/projects.service.ts` — if `RagService` is still used, keep a plain `RagModule` import (no forwardRef needed now that Rag→Projects no longer loops back through Outbox/CodeIntel). Also remove `forwardRef(() => CodeIntelModule)` and `forwardRef(() => AgentsModule)` if `ProjectsController` no longer needs them; if it does, convert to plain imports (verify each is acyclic by running the suite).

- [ ] **Step 6: Type-check and full test**

Run: `bun run type-check && bun run test`
Expected: PASS. No `forwardRef` remains — the whole suite compiling the DI graph is proof of an acyclic module graph.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/rag/hybrid-retriever-cache.subscriber.ts apps/api/src/rag/hybrid-retriever-cache.subscriber.spec.ts apps/api/src/rag/rag.module.ts apps/api/src/projects/projects.service.ts apps/api/src/projects/projects.module.ts
git commit -m "refactor(projects): invalidate hybrid-retriever cache via outbox event; drop last forwardRef"
```

### Task 4.4: Convert all remaining defensive forwardRefs to plain imports

Once Phases 1–3 and Tasks 4.1–4.3 land, the following module-level `forwardRef`s were only defensive (their cycles are now broken) and must be converted to plain imports. Do them one file at a time, running the suite after each so a real remaining cycle surfaces immediately.

**Files & exact edits (remove `forwardRef(() => X)` → `X`, and drop unused `forwardRef` from the `@nestjs/common` import):**

- [ ] **`apps/api/src/context/context.module.ts`** — convert `forwardRef(() => MemoryModule)`, `forwardRef(() => RagModule)`, `forwardRef(() => CodeIntelModule)` to plain (the `forwardRef(() => ProjectsModule)` was already removed in Task 4.2). After: `imports: [PrismaModule, MemoryModule, RagModule, EntityGraphModule, CodeIntelModule, MonitoringModule, ProjectAccessModule]`.
  Run: `bun run test -- context` → Expected: PASS.

- [ ] **`apps/api/src/code-intel/code-intel.module.ts`** — convert `forwardRef(() => RagModule)` to plain (the `ProjectsModule` one became `ProjectAccessModule` in Task 4.2, `OutboxModule` was added plain in Task 1.3).
  Run: `bun run test -- code-intel` → Expected: PASS.

- [ ] **`apps/api/src/koda-domain-writer/koda-domain-writer.module.ts`** — convert `forwardRef(() => RagModule)` to plain (the `OutboxModule` one was fixed in Task 1.5). After: `imports: [PrismaModule, RagModule, OutboxModule, EventsModule, AuthModule]`.
  Run: `bun run test -- koda-domain-writer` → Expected: PASS.

- [ ] **`apps/api/src/agents/agents.module.ts`** — convert `forwardRef(() => ContextModule)` to plain (Context→Projects/Memory cycles are gone). After: `imports: [PrismaModule, KodaDomainWriterModule, AuthModule, ContextModule]`.
  Run: `bun run test -- agents` → Expected: PASS.

- [ ] **Commit**

```bash
git add apps/api/src/context/context.module.ts apps/api/src/code-intel/code-intel.module.ts apps/api/src/koda-domain-writer/koda-domain-writer.module.ts apps/api/src/agents/agents.module.ts
git commit -m "refactor(api): convert remaining defensive forwardRefs to plain imports"
```

**If any of these still throws a circular-dependency error at `compile()`**, that reveals a real cycle the earlier phases missed — stop and trace it with `grep -rn "import.*<CyclingModule>" apps/api/src` before forcing a `forwardRef` back in. The goal is zero.

---

# Final Verification

- [ ] **Step 1: Assert zero `forwardRef` remain**

Run: `grep -rn "forwardRef" apps/api/src --include="*.ts" | grep -v ".spec.ts"`
Expected: **no output**.

- [ ] **Step 2: Full quality gate**

Run: `bun run type-check && bun run lint && bun run test`
Expected: all PASS.

- [ ] **Step 3: Boot the app to confirm the DI container assembles with no cycle**

Run the api in dev (`bun run dev` filtered to api, or the app's start script) and confirm it boots without "A circular dependency" warnings, then stop it.

- [ ] **Step 4: Regenerate the OpenAPI spec and CLI client (contract may have moved endpoints)**

Run: `bun run generate`
Commit any changes to `openapi.json` and `apps/cli/src/generated/`.

- [ ] **Step 5: Final commit / open PR**

```bash
git add -A
git commit -m "chore(api): finalize forwardRef elimination; regenerate spec + cli client"
```

---

## Self-Review Notes (for the executor)

- **Registration timing:** every handler now registers in a subscriber `onModuleInit`. This runs before the scheduler-driven `OutboxProcessor` dispatches, so no event is missed. If you add a subscriber, confirm its module is actually loaded by `AppModule` (transitively) or its handlers will silently never register.
- **`@Optional()` on CodeIntel subscriber:** preserved from the original registry logic (`this.codeCommitHandler || this.astIndexService`) so behavior in test modules that provide only one of them is unchanged.
- **Type consistency:** the moved method signatures (`indexDocument`, `deleteBySource`, `findProjectIdBySlug`, `assertProjectMembership`, `invalidateGraphifyEnabledCache`, `onTicketEvent`, `onGraphifyImport`, `handle`, `process`, `indexCommit`, `runQueries`) are copied verbatim from the current sources — do not rename them.
- **Event name `project_graphify_changed`** is new; it must match exactly between `ProjectsService.enqueue` (Task 4.3 Step 4) and the subscriber `register` (Task 4.3 Step 3).
- **Phase independence:** if you must stop early, Phases 1–3 each leave a green build with strictly fewer `forwardRef`s. Only after Phase 4 is the count zero.
