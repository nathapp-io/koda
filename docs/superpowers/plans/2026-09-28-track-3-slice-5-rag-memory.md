# Track 3 Slice 5 — RAG & Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close review findings M15, M16 (retriever half), M17, M18, M19 and M21, plus the RAG LOWs and the LanceDB filter-guard dedup. After this slice, a deleted ticket leaves the knowledge base. Bad `createdAtOverride` values can no longer poison ranking. Hits found only by full-text search are no longer dropped. Similarity tiers mean what they say. A crash between the graph write and the vector write heals itself. Memory governance no longer skips rows while paging.

**Architecture:** Most fixes stay inside the module that owns the defect: `rag/` for the vector store, hybrid retriever, graph diff and optimize strategies; `memory/` for governance; `context/` for the query DTO. Two additions: a small `KbTicketLifecycleSubscriber` on the existing `ticket_event` fan-out, and a `GraphNode.vectorStale` column. The column makes the graph → vector write retry-safe: the Prisma graph write and the stale marks commit in one transaction, and every import re-indexes leftover stale nodes first. The dead `LexicalIndex` and its 50k-row startup warmup are deleted.

**Tech Stack:** NestJS 10 + `@nathapp/nestjs-*` (common, data, prisma, outbox), Prisma on Postgres, LanceDB (`@lancedb/lancedb`, in-memory fallback in tests), class-validator / class-transformer, Jest (unit + real-Postgres integration), `@hey-api/openapi-ts` generated CLI client.

**Spec:** `docs/superpowers/specs/2026-09-27-track-3-review-remediation-design.md`, section "Slice 5 — RAG & memory" and its "Tests and the eval gate" bullets. Source findings: `docs/20260925-review-whole-repo.md` lines 289-297 (M15-M21 table and verification note) and 351-354 (RAG LOWs).

**Branch:** `feat/track3-rag-memory` in the git worktree `repos/koda-slice5`, branched from `main` `8fc552bb`. **Slice 2b is under development at the same time** in the main checkout (`repos/koda`, branch `feat/track3-inbound-webhooks`). The two slices touch no common source file (2b: `ci-webhook/`, `vcs/`, `webhook/`, `webhook-security/`; this slice: `rag/`, `memory/`, `context/`, `tickets/state-machine/`, `apps/cli/src/commands/{kb,context}.ts`). The only overlap is the generated `openapi.json` and `apps/cli/src/generated/**`; whichever PR merges second regenerates them after rebasing (Task 9). **Do not read, write, check out or run anything inside `repos/koda` (the main checkout) for any task in this plan.** All work, commits and test runs happen in `repos/koda-slice5`.

---

## Global Constraints

- API stays single-instance. Postgres only. String-typed enum / JSON-as-String columns stay.
- Follow `nathapp-nestjs-patterns`: `JsonResponse.Ok`, `AppException` subclasses (`ValidationAppException`, `ForbiddenAppException`, `NotFoundAppException` from `@nathapp/nestjs-common`), repository -> service -> controller, outbox `record()` inside `txManager.run`.
- TDD for every task: failing test first, then implementation.
- DB-backed behaviour gets integration tests on real Postgres (`KODA_DB_TESTS=1`).
- **Test commands (verified 2026-09-28):** unit specs run with `cd apps/api && bun run test -- <path>`. DB-backed specs (`test/integration/**`, `test/e2e/**`) run with `cd apps/api && bun run test:scoped <path>...`: it sets `KODA_DB_TESTS=1` for those paths and runs under `bun --no-env-file`. **Never use `bun run test:integration -- <path>`**: its baked-in `--testPathPattern` overrides the path, so it runs all ~103 integration and e2e files. **Never run bare `bun test`** (Bun's runner, not Jest).
- **Test database isolation (this slice only):** Slice 2b runs its DB tests against `localhost:5433/koda_test` at the same time, and every DB-mode Jest run does `prisma db push --force-reset` on its database. This worktree therefore points its `.env.test` at a separate `koda_slice5_test` database (Task 0), and that edit is never committed. The guard in `test/helpers/test-database-url.ts` accepts any local `*_test` name.
- Contract changes regenerate `openapi.json` and the CLI client in the same PR (`bun run generate` at the repo root). Never hand-edit `openapi.json` or `apps/cli/src/generated/**`.
- All ten CI checks are required on `main` (`changes`, `lint`, `type-check`, `web build`, `policy-gates`, `test`, `integration`, `e2e`, `evaluate`, `smoke`).
- **Eval gate (spec, verbatim):** "The CI `evaluate` job must stay green; the PR records `precision@5_avg` before and after. A drop is investigated, never fixed by lowering the threshold." (`CI_THRESHOLD = 0.70` in `apps/api/scripts/evaluate-retrieval.ts`.)
- **M16 (spec):** "`createdAtOverride` accepted only when `Number.isFinite(Date.parse(value))` (else ignored with a warning); `calcRawRecencyScore` and `normalizeMinMax` treat non-finite inputs as 0."
- **M17 (spec):** "`nativeFtsRows` (and fallback FTS rows) are added to `recordMap`."
- **M18 (spec):** "Tiers use the raw cosine similarity of the vector hit against the existing `SIMILARITY_*` thresholds. FTS-only hits are capped at `low`. Ranking is unchanged."
- **M19 (spec):** delete LanceDB vectors for removed and updated nodes; then one Prisma transaction (node upserts, in-memory-deduped links + `createMany({ skipDuplicates })`, `GraphNode.vectorStale = true` on changed nodes; new column `Boolean @default(false)`); then index stale nodes, clearing the flag per node. "Every run first re-indexes leftover `vectorStale` nodes."
- **M21 (spec):** "`expireMemories`, `deduplicate` and `applySupersession` page by `id > lastId` keyset over `status: 'active'`. Cross-page dedup uses a SQL `groupBy` on the dedup key." `downrankStaleLowConfidence` is out of scope (spec "Out of scope").
- **RAG LOWs (spec):** `.catch(log)` on the three fire-and-forget `optimize()` calls; delete `LexicalIndex` (class, `LexicalIndexWarmup`, its startup load and outbox handler registration, the optional `lexicalIndex` calls in `vector-store.service.ts`) followed by an orphan pass; `GetContextQueryDto` gets validators and goes through `parseQuery`; `GET /kb/documents?limit=` validated `@IsInt @Min(1) @Max(500)`.
- `nestjs-i18n` is not a direct dependency of `apps/api`. Do not import `I18nValidationException`.

## Already fixed on `main` (verified 2026-09-28 at `8fc552bb`; pin, do not rebuild)

The spec was written against `c5a955af`. It still lists these, but the H7 remediation (#128-#132) already fixed them:

1. **M15 "`indexDocument` becomes an upsert"**: `LanceTableManager.addRecord` (`apps/api/src/rag/lance-table-manager.ts:395-402`) already deletes by `source_id` and then adds, inside `exclusive(tableName, ...)`. Both `VectorStore.indexDocument` and `HybridRetrieverService.indexDocument` write through it. Task 4 adds a test that pins this behaviour and changes no code.
2. **"`evaluate-retrieval.ts` seeding idempotent" LOW**: the script seeds through `HybridRetrieverService.indexDocument` -> `addRecord`, so it is already idempotent. Covered by the same pin.
3. **M17 in `VectorStore.search`**: `vector-store.service.ts:349` already puts `nativeFtsRows` into `recordMap`. M17 remains open **only in `HybridRetrieverService.search`**, where `nativeFtsRows` is block-scoped inside the `try` and never reaches `recordMap` (`hybrid-retriever.service.ts:147-226`).

## Findings that shape the design

- **M16 has two write sites now.** The review says "VectorStore ignores the override", but since H7 `VectorStore.indexDocument` (`vector-store.service.ts:212-214`) and `HybridRetrieverService.indexDocument` (`hybrid-retriever.service.ts:103-105`) both read it. One helper (`resolveCreatedAt`) serves both. An accepted override is stored normalised to ISO-8601, so every later `new Date(created_at)` parses it.
- **M21: on data written by the current code, `deduplicate` and `applySupersession` are close to no-ops.** `buildActiveKey` returns `${kind}:${subject}:${predicate}`, which is exactly the dedup key, and `@@unique([projectId, activeKey])` allows one row with a non-null `activeKey` per key. A group can only contain several active rows when legacy or direct-SQL rows have `activeKey = null`. The fix still follows the spec because the offset-paging defect is real (it skips rows in `expireMemories`, which moves rows out of `status: 'active'` while paging). The integration test builds the cross-page duplicate with one `activeKey = null` row.
- **M19 pre-mark (addition to the spec's step 1).** Suppose step 1 deletes an updated node's vectors and step 2 then fails. A later import that sends the node's *stored* content sees no change, so the node would never be re-indexed. This plan therefore marks updated and removed nodes `vectorStale = true` (one `updateMany`) **before** deleting their vectors. A removed node's flag disappears with the row when step 2 commits. When step 2 fails, the node stays in the graph, marked stale, and the next run heals it.
- **`document_indexed` outbox events have one other producer** (`koda-domain-writer.service.ts:207`). After `LexicalIndexWarmup` is deleted, that type has zero handlers. `FanOutPublisher.publish` with no handlers returns successfully (`fan-out-publisher.ts:63-74`), so those rows publish as no-ops. The producer stays: it is a domain event, and removing it is out of scope.
- **`ticket_event` fan-out re-runs every handler on retry** (`fan-out-publisher.ts:21-27`). The new KB handler must be idempotent and must not fail forever. For a project that no longer exists or is soft-deleted, it returns without calling `deleteBySource`, because that call would throw `ForbiddenAppException` on every retry.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task that owns the code.

1. **A ticket deleted while its close-time auto-index is still running** must not end up back in the KB. `autoIndexTicket` is fire-and-forget (`ticket-transitions.service.ts:169-202`). If the delete handler runs first, a late `indexDocument` would re-add the doc. Guard: `autoIndexTicket` skips a ticket whose re-read row has `deletedAt` set. Test: Task 4.
2. **`TICKET_DELETED` for a soft-deleted or missing project** must complete the outbox event, not dead-letter it after retries. Test: Task 4.
3. **An existing LanceDB row whose `created_at` does not parse** (written before this fix) must not turn ranking into NaN. It must also not slip through a `timeWindow` filter (today `NaN < start` is false, so it passes both bounds). Tests: Task 2.
4. **A failed graph write after vectors were deleted** must not leave an unchanged node without a vector (the pre-mark above). Test: Task 5 (integration).
5. **Duplicate links with a `null` relation.** Postgres treats NULLs as distinct in `@@unique([projectId, sourceId, targetId, relation])`, so `skipDuplicates` does not catch them. The in-memory dedup treats `null` and `undefined` as `''`. Test: Task 5 (integration).

---

## File Structure

| File | Change | Responsibility |
|:--|:--|:--|
| `apps/api/.env.test` | Local edit, **never committed** | Point DB-mode Jest at `koda_slice5_test` (Task 0) |
| `apps/api/src/rag/strategies/optimize-in-background.ts` | Create | `optimizeInBackground(table, projectId, logger)`: fire-and-forget with `.catch(log)` |
| `apps/api/src/rag/strategies/optimize-strategies.spec.ts` | Create | Rejecting `optimize()` is logged, never unhandled |
| `apps/api/src/rag/strategies/{counter,manual,cron}-optimize.strategy.ts` | Modify | `onFirstAccess` uses the helper |
| `apps/api/src/rag/vector-store.service.ts` | Modify | `deleteBySource` uses `isSafeFilterValue`; `indexDocument` uses `resolveCreatedAt`; drop `lexicalIndex` (Task 7) |
| `apps/api/src/rag/vector-store.filter-guard.spec.ts` | Create | Quote / control char / empty `sourceId` rejected before LanceDB |
| `apps/api/src/rag/created-at-override.ts` | Create | `resolveCreatedAt(metadata)` |
| `apps/api/src/rag/created-at-override.spec.ts` | Create | Helper + both write sites |
| `apps/api/src/rag/hybrid-retriever.service.ts` | Modify | M16 search guards, time-window guard, M17 `recordMap`, M18 tiers |
| `apps/api/src/rag/hybrid-retriever.scoring.spec.ts` | Create | M16/M17/M18 search behaviour with a stub table manager |
| `apps/api/src/rag/kb-ticket-lifecycle.subscriber.ts` | Create | `TICKET_DELETED` -> `deleteBySource` |
| `apps/api/src/rag/kb-ticket-lifecycle.subscriber.spec.ts` | Create | Unit tests, including idempotency and the pin for the existing upsert |
| `apps/api/src/rag/rag.module.ts` | Modify | Register the subscriber (Task 4); delete `LexicalIndex*` (Task 7) |
| `apps/api/src/tickets/state-machine/ticket-transitions.service.ts` | Modify | `autoIndexTicket` skips a deleted ticket |
| `apps/api/src/tickets/state-machine/ticket-transitions.autoindex.spec.ts` | Create | Deleted ticket is not indexed |
| `apps/api/prisma/schema.prisma` | Modify | `GraphNode.vectorStale` + index |
| `apps/api/prisma/migrations/20260928120000_graph_node_vector_stale/migration.sql` | Create | Hand-written migration |
| `apps/api/src/rag/prisma-rag.repository.ts` | Modify | `applyGraphDiff`, `markGraphNodesVectorStale`, `findVectorStaleNodeIds`, `clearGraphNodeVectorStale`; drop the batch methods |
| `apps/api/src/rag/domain/rag.domain.ts` | Modify | `IRagRepository` follows the repository |
| `apps/api/src/rag/graph-store.service.ts` | Modify | `applyDiff`, `markVectorStale`, `findVectorStaleNodeIds`, `clearVectorStale`; drop `upsertNodes`/`deleteNodes`/`deleteLinks` |
| `apps/api/src/rag/graph-store.service.spec.ts` | Modify | Tests follow the new surface |
| `apps/api/src/rag/incremental-graph-diff.service.ts` | Modify | Heal -> pre-mark -> vector delete -> one transaction -> index + clear |
| `apps/api/src/rag/incremental-graph-diff.service.spec.ts` | Modify | Mocks and assertions follow the new surface; ordering test rewritten |
| `apps/api/test/integration/rag/graph-vector-consistency.integration.spec.ts` | Create | Crash heals; failed write heals; duplicate links |
| `apps/api/test/integration/rag/incremental-graph-diff.integration.spec.ts` | Modify | Spy on `applyDiff` instead of `upsertNodes` |
| `apps/api/test/integration/rag/incremental-graph-diff-service-call.integration.spec.ts` | Modify | Mock shape |
| `apps/api/src/memory/prisma-memory-item.repository.ts` | Modify | `findActiveAfterId`, `findDuplicateActiveKeys`, `findActiveByKey` |
| `apps/api/src/memory/memory-governance.service.ts` | Modify | Keyset + groupBy |
| `apps/api/src/memory/memory-governance.service.spec.ts` | Modify | AC-3/5/6/7 blocks follow the new repository calls |
| `apps/api/test/integration/memory/memory-governance-paging.integration.spec.ts` | Create | Paging under mutation; cross-page dedup; supersession |
| `apps/api/src/rag/lexical-index.ts` | Delete | Dead code |
| `apps/api/test/integration/rag/lexical-index.integration.spec.ts` | Delete | Tests for deleted code |
| `apps/api/test/integration/rag/lance-table-manager.integration.spec.ts` | Modify | Two `new VectorStore(...)` calls lose one positional `undefined` |
| `apps/api/src/context/dto/get-context-query.dto.ts` | Create | Validated `GetContextQueryDto` |
| `apps/api/src/context/dto/get-context-query.dto.spec.ts` | Create | Validation tests |
| `apps/api/src/context/context.controller.ts` | Modify | Import the DTO; `parseQuery` for query and body |
| `apps/api/src/rag/dto/list-kb-documents.query.ts` | Create | `ListKbDocumentsQuery` (`limit` 1..500, default 100) |
| `apps/api/src/rag/dto/list-kb-documents.query.spec.ts` | Create | Validation tests |
| `apps/api/src/rag/rag.controller.ts` | Modify | `listDocuments` takes the DTO |
| `apps/api/src/rag/rag.controller.spec.ts` | Modify | `listDocuments` tests follow the DTO |
| `apps/cli/src/commands/kb.ts`, `kb.spec.ts` | Modify | `limit: 100` (number) after regeneration |
| `openapi.json`, `apps/cli/src/generated/**` | Regenerate | Contract follows the DTOs |

---

### Task 0: Worktree, test database and eval baseline

**Files:**
- Create: `docs/superpowers/plans/2026-09-28-track-3-slice-5-rag-memory.md` (this file)
- Local only: `apps/api/.env.test`

- [ ] **Step 1: Confirm the worktree and branch**

Run: `git -C repos/koda-slice5 branch --show-current && git -C repos/koda-slice5 log --oneline -1`
Expected: `feat/track3-rag-memory` and `8fc552bb ...` (or the plan commit on top of it).

- [ ] **Step 2: Commit the plan**

```bash
cd repos/koda-slice5
git add docs/superpowers/plans/2026-09-28-track-3-slice-5-rag-memory.md
git commit -m "docs(track3-slice5): RAG and memory remediation plan"
```

- [ ] **Step 3: Point this worktree's DB-mode tests at their own database**

```bash
cd repos/koda-slice5/apps/api
sed -i '' 's#localhost:5433/koda_test#localhost:5433/koda_slice5_test#' .env.test
git update-index --skip-worktree .env.test
grep DATABASE_URL .env.test
```

Expected: `DATABASE_URL="postgresql://koda:koda@localhost:5433/koda_slice5_test"`. `git status --short apps/api/.env.test` prints nothing. Task 9 undoes both commands before the PR.

- [ ] **Step 4: Start the test Postgres and prove the new database resets**

Start the container and create this slice's three databases once. The Compose service is `postgres-test` (`docker-compose.test.yml:4`). `createdb` fails harmlessly when a database already exists, so the loop is safe to rerun:

```bash
cd apps/api && bun run test:db:up
for db in koda_slice5_test koda_slice5_eval_test koda_slice5_shadow_test; do
  docker compose -f ../../docker-compose.test.yml exec -T postgres-test createdb -U koda "$db" || true
done
bun run test:scoped test/integration/memory/memory-upsert-replay.integration.spec.ts
```

Expected: PASS. `koda_slice5_test` is the Jest database (globalSetup runs `prisma db push --force-reset` on it), `koda_slice5_eval_test` is for the eval runs (Task 0 Step 5, Task 9 Step 2), and `koda_slice5_shadow_test` is the shadow database for `prisma migrate diff` (Task 5 Step 3). Never create or reset `koda_test`: Slice 2b uses it.

- [ ] **Step 5: Record the eval baseline (before any code change)**

```bash
cd repos/koda-slice5
bunx turbo run build --filter=@nathapp/koda-api
cd apps/api
DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_slice5_eval_test bunx prisma db push --skip-generate
DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_slice5_eval_test \
  RAG_EVAL_PROJECT_ID=proj_eval_001 RAG_IN_MEMORY_ONLY=true \
  JWT_SECRET=eval JWT_REFRESH_SECRET=eval API_KEY_SECRET=eval \
  bun --no-env-file scripts/evaluate-retrieval.ts | tee /tmp/slice5-eval-before.txt
```

Expected: ends with `PASS: precision@5_avg=0.xxx >= 0.7`. Copy the `precision@5_avg` line into the PR description draft. This matches the CI `evaluate` job (`.github/workflows/ci.yml:375-440`: in-memory RAG, built `dist`).

---

### Task 1: LanceDB filter-guard dedup and background `optimize()` errors

**Files:**
- Create: `apps/api/src/rag/strategies/optimize-in-background.ts`
- Create: `apps/api/src/rag/strategies/optimize-strategies.spec.ts`
- Create: `apps/api/src/rag/vector-store.filter-guard.spec.ts`
- Modify: `apps/api/src/rag/strategies/counter-optimize.strategy.ts:32-35`
- Modify: `apps/api/src/rag/strategies/manual-optimize.strategy.ts:16-19`
- Modify: `apps/api/src/rag/strategies/cron-optimize.strategy.ts:52-55`
- Modify: `apps/api/src/rag/vector-store.service.ts:463-483`

**Interfaces:**
- Consumes: `isSafeFilterValue(value: string): boolean` from `lance-table-manager.ts:37` (existing).
- Produces: `export function optimizeInBackground(table: { optimize: () => Promise<unknown> }, projectId: string, logger: Pick<Logger, 'warn'>): void`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/rag/strategies/optimize-strategies.spec.ts`:

```ts
import type { IRagConfig } from '../../config/rag.config';
import { CounterOptimizeStrategy } from './counter-optimize.strategy';
import { ManualOptimizeStrategy } from './manual-optimize.strategy';
import { CronOptimizeStrategy } from './cron-optimize.strategy';
import { optimizeInBackground } from './optimize-in-background';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function rejectingTable(): { optimize: jest.Mock } {
  return { optimize: jest.fn().mockRejectedValue(new Error('lance busy')) };
}

const ragConfig = { ftsOptimizeThreshold: 10, ftsOptimizeIntervalMs: 60_000 } as IRagConfig;

describe('background optimize() on first access', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('optimizeInBackground logs a rejection instead of leaking it', async () => {
    const logger = { warn: jest.fn() };
    optimizeInBackground(rejectingTable(), 'proj-1', logger);
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('proj-1'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lance busy'));
    expect(unhandled).toEqual([]);
  });

  it('optimizeInBackground also catches a synchronous throw', async () => {
    const logger = { warn: jest.fn() };
    const table = {
      optimize: jest.fn(() => {
        throw new Error('sync boom');
      }),
    };
    expect(() => optimizeInBackground(table, 'proj-2', logger)).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sync boom'));
  });

  it.each([
    ['counter', () => new CounterOptimizeStrategy(ragConfig)],
    ['manual', () => new ManualOptimizeStrategy()],
  ])('%s strategy onFirstAccess does not leak a rejection', async (_name, make) => {
    const strategy = make();
    strategy.onFirstAccess('proj-3', rejectingTable());
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('cron strategy onFirstAccess does not leak a rejection', async () => {
    const registry = { addInterval: jest.fn(), deleteInterval: jest.fn() };
    const strategy = new CronOptimizeStrategy(ragConfig, registry);
    try {
      strategy.onFirstAccess('proj-4', rejectingTable());
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      await strategy.onDestroy();
    }
  });
});
```

Create `apps/api/src/rag/vector-store.filter-guard.spec.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import type { IRagConfig } from '../config/rag.config';
import { VectorStore } from './vector-store.service';
import { LanceTableManager } from './lance-table-manager';

const ragConfig = {
  lancedbPath: './lancedb-filter-guard-test',
  inMemoryOnly: true,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
} as IRagConfig;

describe('VectorStore.deleteBySource filter guard', () => {
  let manager: LanceTableManager;
  let store: VectorStore;
  let deleteSpy: jest.SpyInstance;

  beforeEach(async () => {
    manager = new LanceTableManager(ragConfig);
    store = new VectorStore(ragConfig, undefined, undefined, undefined, undefined, undefined, manager);
    const table = await manager.getOrCreateTable('project_proj-1');
    deleteSpy = jest.spyOn(table, 'delete');
  });

  it.each([
    ['a quote', "abc' OR '1'='1"],
    ['a newline', 'abc\nxyz'],
    ['a DEL character', 'abc\u007fxyz'],
    ['an empty string', ''],
  ])('rejects a sourceId containing %s before touching LanceDB', async (_label, sourceId) => {
    await expect(store.deleteBySource('proj-1', sourceId)).rejects.toBeInstanceOf(ValidationAppException);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('accepts a path-like sourceId', async () => {
    await expect(store.deleteBySource('proj-1', 'src/rag/vector-store.ts::VectorStore')).resolves.toBeUndefined();
    expect(deleteSpy).toHaveBeenCalledWith("source_id = 'src/rag/vector-store.ts::VectorStore'");
  });
});
```

> The `VectorStore` constructor still has seven parameters here (`lexicalIndex` is the fifth). Task 7 removes one `undefined` from this call.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bun run test -- src/rag/strategies/optimize-strategies.spec.ts src/rag/vector-store.filter-guard.spec.ts`
Expected: FAIL. `optimize-in-background` cannot be resolved, and the strategy cases record an unhandled rejection. The filter-guard cases may already pass: that is expected, since the inline check is equivalent. They pin the behaviour across the refactor in Step 3.

- [ ] **Step 3: Implement**

Create `apps/api/src/rag/strategies/optimize-in-background.ts`:

```ts
import type { Logger } from '@nestjs/common';

/**
 * Starts `table.optimize()` without awaiting it. A rejection (or a synchronous
 * throw) is logged instead of surfacing as an unhandled promise rejection.
 */
export function optimizeInBackground(
  table: { optimize: () => Promise<unknown> },
  projectId: string,
  logger: Pick<Logger, 'warn'>,
): void {
  void Promise.resolve()
    .then(() => table.optimize())
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`FTS optimize failed for project ${projectId}: ${message}`);
    });
}
```

In each of the three strategies, replace the body of `onFirstAccess` with:

```ts
  onFirstAccess(projectId: string, table: LanceTable): void {
    this.logger.debug(`onFirstAccess fire-and-forget for project ${projectId}`);
    optimizeInBackground(table, projectId, this.logger);
  }
```

and add `import { optimizeInBackground } from './optimize-in-background';`.

In `vector-store.service.ts`, change the import on line 9 to `import { LanceTableManager, isSafeFilterValue } from './lance-table-manager';` and replace lines 466-477 of `deleteBySource` with:

```ts
    // Graph/code source IDs are often path-like; isSafeFilterValue allows repo-path
    // punctuation and rejects the quote/control characters that could break the filter.
    if (!isSafeFilterValue(sourceId)) {
      throw new ValidationAppException();
    }
```

Update the doc comment on `isSafeFilterValue` (`lance-table-manager.ts:32-36`): replace "Mirrors the validation used by VectorStore.deleteBySource." with "Shared by LanceTableManager.addRecord and VectorStore.deleteBySource."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test -- src/rag/strategies src/rag/vector-store`
Expected: PASS (the new specs and the existing `vector-store.service.spec.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/rag/strategies apps/api/src/rag/vector-store.service.ts apps/api/src/rag/vector-store.filter-guard.spec.ts apps/api/src/rag/lance-table-manager.ts
git commit -m "fix(rag): catch background optimize() failures; share the LanceDB filter guard"
```

---

### Task 2: M16 retriever half: `createdAtOverride` and non-finite recency

**Files:**
- Create: `apps/api/src/rag/created-at-override.ts`
- Create: `apps/api/src/rag/created-at-override.spec.ts`
- Create: `apps/api/src/rag/hybrid-retriever.scoring.spec.ts` (M16 part; Task 3 adds to it)
- Modify: `apps/api/src/rag/vector-store.service.ts:210-214`
- Modify: `apps/api/src/rag/hybrid-retriever.service.ts:103-105, 245-254, 280-293, 406-411`

**Interfaces:**
- Produces: `export function resolveCreatedAt(metadata: Record<string, unknown> | undefined, now?: () => Date): { createdAt: string; rejectedOverride?: unknown }`. `createdAt` is always an ISO-8601 string. `rejectedOverride` is set only when a `createdAtOverride` key was present but unusable.
- Produces (test helpers reused by Task 3, all in `hybrid-retriever.scoring.spec.ts`): `row(id, content, extra?)`, `stubTable({ scanned, fts, vector })`, `stubManager(table)`, `buildRetriever(table)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/rag/created-at-override.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import type { IRagConfig } from '../config/rag.config';
import { resolveCreatedAt } from './created-at-override';
import { VectorStore } from './vector-store.service';
import { HybridRetrieverService } from './hybrid-retriever.service';
import { LanceTableManager } from './lance-table-manager';
import type { EntityStore } from './entity-store';
import type { PrismaRagRepository } from './prisma-rag.repository';

const fixedNow = (): Date => new Date('2026-09-28T00:00:00.000Z');

describe('resolveCreatedAt', () => {
  it('uses now when there is no override', () => {
    expect(resolveCreatedAt({}, fixedNow)).toEqual({ createdAt: '2026-09-28T00:00:00.000Z' });
    expect(resolveCreatedAt(undefined, fixedNow)).toEqual({ createdAt: '2026-09-28T00:00:00.000Z' });
  });

  it('accepts a parseable override and normalises it to ISO-8601', () => {
    expect(resolveCreatedAt({ createdAtOverride: '2020-03-07' }, fixedNow)).toEqual({
      createdAt: '2020-03-07T00:00:00.000Z',
    });
  });

  it.each([['not-a-date'], [''], [42], [null], [{}]])('ignores the override %p and reports it', (value) => {
    expect(resolveCreatedAt({ createdAtOverride: value }, fixedNow)).toEqual({
      createdAt: '2026-09-28T00:00:00.000Z',
      rejectedOverride: value,
    });
  });
});

const ragConfig = {
  lancedbPath: './lancedb-created-at-test',
  inMemoryOnly: true,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
  graphifyEnabledCacheTtlSec: 60,
} as IRagConfig;

const embedding = {
  embed: jest.fn().mockResolvedValue(Array(8).fill(0.1)),
  providerName: 'fake',
  modelName: 'fake-v1',
  dimensions: 8,
};

describe('both KB write paths reject a bad createdAtOverride', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('VectorStore.indexDocument stores a valid created_at and warns', async () => {
    const store = new VectorStore(ragConfig, embedding as never);
    await store.indexDocument('proj-1', {
      source: 'doc',
      sourceId: 'doc-1',
      content: 'hello',
      metadata: { createdAtOverride: 'not-a-date' },
    });
    const [doc] = await store.listDocuments('proj-1');
    expect(Number.isFinite(Date.parse(doc.createdAt))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('createdAtOverride'));
  });

  it('HybridRetrieverService.indexDocument stores a valid created_at and warns', async () => {
    const manager = new LanceTableManager(ragConfig);
    const retriever = new HybridRetrieverService(
      ragConfig,
      embedding as never,
      {} as EntityStore,
      {} as PrismaRagRepository,
      manager,
    );
    await retriever.indexDocument('proj-2', {
      source: 'doc',
      sourceId: 'doc-2',
      content: 'hello',
      metadata: { createdAtOverride: 'not-a-date' },
    });
    const table = await manager.getOrCreateTable('project_proj-2');
    const [stored] = await table.query().limit(10).toArray();
    expect(Number.isFinite(Date.parse(stored.created_at))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('createdAtOverride') }));
  });
});
```

Create `apps/api/src/rag/hybrid-retriever.scoring.spec.ts`:

```ts
import type { IRagConfig } from '../config/rag.config';
import { HybridRetrieverService } from './hybrid-retriever.service';
import type { LanceRecord, LanceTableManager } from './lance-table-manager';
import type { EntityStore } from './entity-store';
import type { PrismaRagRepository } from './prisma-rag.repository';

const ragConfig = {
  lancedbPath: './unused',
  inMemoryOnly: false,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
  graphifyEnabledCacheTtlSec: 60,
} as IRagConfig;

export function row(id: string, content: string, extra: Partial<LanceRecord> = {}): LanceRecord {
  return {
    id,
    source: 'doc',
    source_id: `src-${id}`,
    content,
    vector: Array(8).fill(0),
    metadata: '{}',
    created_at: '2026-09-01T00:00:00.000Z',
    provider: 'fake',
    model: 'fake-v1',
    ...extra,
  };
}

/** A LanceDB table stub: `scanned` is what query().limit() returns (the first 500 rows). */
export function stubTable(opts: { scanned: LanceRecord[]; fts: LanceRecord[]; vector: LanceRecord[] }): unknown {
  return {
    countRows: jest.fn().mockResolvedValue(opts.scanned.length + 1000),
    query: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(opts.scanned) }),
    }),
    search: jest.fn().mockResolvedValue(opts.fts),
    vectorSearch: jest.fn().mockReturnValue({
      distanceType: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(opts.vector) }),
      }),
    }),
  };
}

export function stubManager(table: unknown): LanceTableManager {
  return {
    available: true,
    ensureStorage: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    getOrCreateTable: jest.fn().mockResolvedValue(table),
    addRecord: jest.fn().mockResolvedValue(undefined),
  } as unknown as LanceTableManager;
}

export function buildRetriever(table: unknown): HybridRetrieverService {
  const embedding = { embed: jest.fn().mockResolvedValue(Array(8).fill(0.1)), dimensions: 8, providerName: 'fake', modelName: 'fake-v1' };
  const entityStore = { searchEntities: jest.fn().mockReturnValue([]), computeEntityScore: jest.fn().mockReturnValue(0) };
  const ragRepo = { findProjectGraphifyEnabled: jest.fn().mockResolvedValue({ graphifyEnabled: false }) };
  return new HybridRetrieverService(
    ragConfig,
    embedding as never,
    entityStore as unknown as EntityStore,
    ragRepo as unknown as PrismaRagRepository,
    stubManager(table),
  );
}

describe('HybridRetrieverService scoring (M16)', () => {
  it('a row with an unparseable created_at does not turn scores into NaN', async () => {
    const good = row('good', 'alpha beta', { _distance: 0.1 });
    const bad = row('bad', 'alpha gamma', { _distance: 0.2, created_at: 'not-a-date' });
    const retriever = buildRetriever(stubTable({ scanned: [], fts: [], vector: [good, bad] }));

    const result = await retriever.search({ projectId: 'p', query: 'alpha' });

    expect(result.scores.every((s) => Number.isFinite(s.finalScore))).toBe(true);
    expect(result.scores.every((s) => Number.isFinite(s.recencyScore))).toBe(true);
    expect(result.results[0].id).toBe('good');
  });

  it('a timeWindow excludes a row whose created_at does not parse', async () => {
    const inWindow = row('in', 'alpha', { _distance: 0.1, created_at: '2026-09-10T00:00:00.000Z' });
    const unparseable = row('bad', 'alpha', { _distance: 0.1, created_at: 'not-a-date' });
    const retriever = buildRetriever(stubTable({ scanned: [], fts: [], vector: [inWindow, unparseable] }));

    const result = await retriever.search({
      projectId: 'p',
      query: 'alpha',
      timeWindow: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
    });

    expect(result.results.map((r) => r.id)).toEqual(['in']);
  });
});
```

> Check `HybridSearchQuery` in `apps/api/src/rag/dto/hybrid-search.dto.ts` for the exact `timeWindow` field shape before running. The code in `hybrid-retriever.service.ts:245-254` reads `query.timeWindow?.from` / `.to`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bun run test -- src/rag/created-at-override.spec.ts src/rag/hybrid-retriever.scoring.spec.ts`
Expected: FAIL. `./created-at-override` does not resolve; NaN scores; `bad` is returned inside the time window.

- [ ] **Step 3: Implement**

Create `apps/api/src/rag/created-at-override.ts`:

```ts
/**
 * M16: `metadata.createdAtOverride` lets a caller backdate a KB record. Only a
 * value that `Date.parse` understands is accepted, normalised to ISO-8601;
 * anything else is reported back so the caller can log it, and the record
 * gets the current time. A bad value must never reach recency scoring.
 */
export function resolveCreatedAt(
  metadata: Record<string, unknown> | undefined,
  now: () => Date = () => new Date(),
): { createdAt: string; rejectedOverride?: unknown } {
  if (!metadata || !('createdAtOverride' in metadata)) {
    return { createdAt: now().toISOString() };
  }
  const override = metadata['createdAtOverride'];
  if (typeof override === 'string') {
    const ms = Date.parse(override);
    if (Number.isFinite(ms)) {
      return { createdAt: new Date(ms).toISOString() };
    }
  }
  return { createdAt: now().toISOString(), rejectedOverride: override };
}
```

In `vector-store.service.ts`, replace lines 210-214 with:

```ts
    const { createdAt, rejectedOverride } = resolveCreatedAt(doc.metadata);
    if (rejectedOverride !== undefined) {
      this.logger.warn(`Ignoring unparseable createdAtOverride for ${doc.sourceId}`);
    }
```

and add `import { resolveCreatedAt } from './created-at-override';`.

In `hybrid-retriever.service.ts`:

1. Replace lines 103-105 with:

```ts
    const { createdAt, rejectedOverride } = resolveCreatedAt(doc.metadata);
    if (rejectedOverride !== undefined) {
      this.logger.warn({ storyId: 'US-004', msg: `Ignoring unparseable createdAtOverride for ${doc.sourceId}` });
    }
```

and add the same import.

2. Replace the time-window block (lines 245-254) with:

```ts
      if (query.timeWindow?.from || query.timeWindow?.to) {
        const docTime = Date.parse(record.created_at);
        if (!Number.isFinite(docTime)) continue;
        if (query.timeWindow.from && docTime < new Date(query.timeWindow.from).getTime()) continue;
        if (query.timeWindow.to && docTime > new Date(query.timeWindow.to).getTime()) continue;
      }
```

3. Replace `normalizeMinMax` (lines 280-293) with:

```ts
    const normalizeMinMax = (rawScores: number[], hasPresence: boolean[]): number[] => {
      if (rawScores.length === 0) return [];
      // M16: a non-finite input (e.g. recency from an unparseable created_at) counts as 0
      const scores = rawScores.map((s) => (Number.isFinite(s) ? s : 0));
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const range = max - min;
      if (range < 1e-9) {
        return scores.map((s, i) => (s > 0 && hasPresence[i] ? 1 : 0));
      }
      return scores.map((s, i) => (hasPresence[i] ? (s - min) / range : 0));
    };
```

4. Replace `calcRawRecencyScore` (lines 406-411) with:

```ts
  private calcRawRecencyScore(createdAt: string): number {
    const docDate = Date.parse(createdAt);
    if (!Number.isFinite(docDate)) return 0;
    const ageDays = (Date.now() - docDate) / (1000 * 60 * 60 * 24);
    const score = Math.pow(0.5, ageDays / 30);
    return Number.isFinite(score) ? score : 0;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test -- src/rag`
Expected: PASS, including the existing `hybrid-retriever.service.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/rag/created-at-override.ts apps/api/src/rag/created-at-override.spec.ts apps/api/src/rag/hybrid-retriever.scoring.spec.ts apps/api/src/rag/vector-store.service.ts apps/api/src/rag/hybrid-retriever.service.ts
git commit -m "fix(rag): validate createdAtOverride and guard non-finite recency (M16)"
```

---

### Task 3: M17 FTS-only hits and M18 tiers in the hybrid retriever

**Files:**
- Modify: `apps/api/src/rag/hybrid-retriever.service.ts:145-169, 223-225, 339-353, 413-418`
- Modify: `apps/api/src/rag/hybrid-retriever.scoring.spec.ts` (append)

**Interfaces:**
- Consumes: `row`, `stubTable`, `buildRetriever` from Task 2's spec file.
- Produces: `HybridSearchResultItem.similarity` now comes from raw cosine; the shape does not change.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/rag/hybrid-retriever.scoring.spec.ts`:

```ts
describe('HybridRetrieverService FTS-only hits (M17)', () => {
  it('returns a native-FTS hit that is outside the first 500 scanned rows', async () => {
    const scanned = Array.from({ length: 500 }, (_, i) => row(`scan-${i}`, 'unrelated filler'));
    const deep = row('deep-fts', 'rare keyword match');
    const retriever = buildRetriever(stubTable({ scanned, fts: [deep], vector: [] }));

    const result = await retriever.search({ projectId: 'p', query: 'rare keyword' });

    expect(result.results.map((r) => r.id)).toContain('deep-fts');
  });
});

describe('HybridRetrieverService similarity tiers (M18)', () => {
  it('tiers every strong vector hit by its raw cosine, not by a min-max-normalised score', async () => {
    const first = row('a', 'alpha', { _distance: 0.05 }); // cosine 0.95
    const second = row('b', 'alpha', { _distance: 0.1 }); // cosine 0.90
    const retriever = buildRetriever(stubTable({ scanned: [], fts: [], vector: [first, second] }));

    const result = await retriever.search({ projectId: 'p', query: 'alpha' });

    expect(result.results.map((r) => [r.id, r.similarity])).toEqual([
      ['a', 'high'],
      ['b', 'high'],
    ]);
  });

  it('labels a single weak vector hit by its raw cosine', async () => {
    const weak = row('weak', 'alpha', { _distance: 0.6 }); // cosine 0.40 < similarityLow 0.5
    const retriever = buildRetriever(stubTable({ scanned: [], fts: [], vector: [weak] }));

    const result = await retriever.search({ projectId: 'p', query: 'alpha' });

    expect(result.results[0].similarity).toBe('none');
  });

  it('caps an FTS-only hit at low', async () => {
    const lexical = row('lex', 'rare keyword match');
    const retriever = buildRetriever(stubTable({ scanned: [lexical], fts: [lexical], vector: [] }));

    const result = await retriever.search({ projectId: 'p', query: 'rare keyword' });

    expect(result.results.map((r) => [r.id, r.similarity])).toEqual([['lex', 'low']]);
  });

  it('leaves the ranking unchanged', async () => {
    const a = row('a', 'alpha', { _distance: 0.3 });
    const b = row('b', 'alpha', { _distance: 0.1 });
    const retriever = buildRetriever(stubTable({ scanned: [], fts: [], vector: [b, a] }));

    const result = await retriever.search({ projectId: 'p', query: 'alpha' });

    expect(result.results.map((r) => r.id)).toEqual(['b', 'a']);
    expect(result.scores[0].finalScore).toBeGreaterThan(result.scores[1].finalScore);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bun run test -- src/rag/hybrid-retriever.scoring.spec.ts`
Expected: FAIL. `deep-fts` is missing; `b` is `none`; `weak` is `low`; the FTS-only hit is labelled from its normalised score.

- [ ] **Step 3: Implement**

In `hybrid-retriever.service.ts`:

1. Hoist the native FTS rows. Replace lines 145-169 with:

```ts
    let ftsRanked: { id: string; score: number }[] = [];
    // M17: rows returned by native FTS may lie outside the scanned `allRows`
    // window; keep them so they can resolve in recordMap.
    let nativeFtsRows: LanceRecord[] = [];
    const inMemoryFts = (): { id: string; score: number }[] =>
      allRows
        .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query.query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, candidatePoolSize);
    if (this.lanceTable.available) {
      try {
        const nativeFtsResult = await table.search(query.query, 'fts', 'content');
        if (Array.isArray(nativeFtsResult)) {
          nativeFtsRows = nativeFtsResult as LanceRecord[];
        } else if (nativeFtsResult && typeof nativeFtsResult === 'object' && 'toArray' in nativeFtsResult) {
          nativeFtsRows = await (nativeFtsResult as { toArray: () => Promise<LanceRecord[]> }).toArray();
        }
        ftsRanked = nativeFtsRows.map((r, i) => ({ id: r.id as string, score: 1 / (i + 1) }));
      } catch {
        nativeFtsRows = [];
        ftsRanked = inMemoryFts();
      }
    } else {
      ftsRanked = inMemoryFts();
    }
```

2. Replace the `recordMap` block (lines 223-225) with:

```ts
    const recordMap = new Map<string, LanceRecord>();
    allRows.forEach((r) => recordMap.set(r.id as string, r));
    nativeFtsRows.forEach((r) => recordMap.set(r.id as string, r));
    vectorRows.forEach((r) => recordMap.set(r.id as string, r));
```

The in-memory fallback ranks only `allRows`, which are already in the map. The spec's "fallback FTS rows" are therefore covered by the `allRows` line.

3. In the results loop (line 345), replace `similarity: this.getSimilarityTier(finalScore),` with `similarity: this.tierFor(id, simMap),`.

4. Replace `getSimilarityTier` (lines 413-418) with:

```ts
  /**
   * M18: tier on the raw cosine similarity of the vector hit (the per-query
   * min-max-normalised finalScore is only for ranking). A hit with no vector
   * similarity matched lexically only and is capped at 'low'.
   */
  private tierFor(id: string, simMap: Map<string, number>): 'high' | 'medium' | 'low' | 'none' {
    const cosine = simMap.get(id);
    if (cosine === undefined) return 'low';
    if (cosine >= this.similarityHigh) return 'high';
    if (cosine >= this.similarityMedium) return 'medium';
    if (cosine >= this.similarityLow) return 'low';
    return 'none';
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test -- src/rag` then `cd apps/api && bun run test:scoped test/integration/rag/hybrid-retriever.integration.spec.ts test/integration/rag/intent-weighted-fusion.integration.spec.ts`
Expected: PASS. If an existing test asserts a `similarity` value computed from the normalised score, it encodes the M18 defect. Update its expectation to the raw-cosine tier and say so in the commit body. Do not change any ranking assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/rag/hybrid-retriever.service.ts apps/api/src/rag/hybrid-retriever.scoring.spec.ts
git commit -m "fix(rag): keep FTS-only hits and tier on raw cosine in hybrid search (M17, M18)"
```

---

### Task 4: M15 KB lifecycle: deleted tickets leave the KB

**Files:**
- Create: `apps/api/src/rag/kb-ticket-lifecycle.subscriber.ts`
- Create: `apps/api/src/rag/kb-ticket-lifecycle.subscriber.spec.ts`
- Create: `apps/api/src/tickets/state-machine/ticket-transitions.autoindex.spec.ts`
- Modify: `apps/api/src/rag/rag-config-and-module.spec.ts` (append the module-wiring test)
- Modify: `apps/api/src/rag/rag.module.ts` (providers)
- Modify: `apps/api/src/tickets/state-machine/ticket-transitions.service.ts:180`

**Interfaces:**
- Consumes: `FanOutPublisher.register(type, handler)`; `RagService.deleteBySource(projectId, sourceId)`; `PrismaRagRepository.findProjectById(projectId): Promise<{ id; deletedAt } | null>`; the `ticket_event` payload built by `buildTicketEventOutboxPayload` (`{ id, type, action, timestamp, ticketId, projectId, actorId, actorType, data }`).
- Produces: `export class KbTicketLifecycleSubscriber` with `handleTicketEvent(payload: unknown): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/rag/kb-ticket-lifecycle.subscriber.spec.ts`:

```ts
import type { IRagConfig } from '../config/rag.config';
import { KbTicketLifecycleSubscriber } from './kb-ticket-lifecycle.subscriber';
import { VectorStore } from './vector-store.service';
import { RagService } from './rag.service';
import type { FanOutPublisher } from '../outbox/fan-out-publisher';
import type { PrismaRagRepository } from './prisma-rag.repository';

const liveProject = { id: 'proj-1', deletedAt: null };

function build(project: { id: string; deletedAt: Date | null } | null = liveProject) {
  const registry = { register: jest.fn() };
  const ragService = { deleteBySource: jest.fn().mockResolvedValue(undefined) };
  const ragRepository = { findProjectById: jest.fn().mockResolvedValue(project) };
  const subscriber = new KbTicketLifecycleSubscriber(
    registry as unknown as FanOutPublisher,
    ragService as unknown as RagService,
    ragRepository as unknown as PrismaRagRepository,
  );
  return { subscriber, registry, ragService, ragRepository };
}

const deleted = { id: 'ev-1', type: 'ticket_event', action: 'TICKET_DELETED', ticketId: 'tick-1', projectId: 'proj-1' };

describe('KbTicketLifecycleSubscriber', () => {
  it('registers on ticket_event', () => {
    const { subscriber, registry } = build();
    subscriber.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith('ticket_event', expect.any(Function));
  });

  it('deletes the ticket KB document on TICKET_DELETED', async () => {
    const { subscriber, ragService } = build();
    await subscriber.handleTicketEvent(deleted);
    expect(ragService.deleteBySource).toHaveBeenCalledWith('proj-1', 'tick-1');
  });

  it.each(['TICKET_CREATED', 'status_changed', 'assigned', 'COMMENT_ADDED'])('ignores %s', async (action) => {
    const { subscriber, ragService } = build();
    await subscriber.handleTicketEvent({ ...deleted, action });
    expect(ragService.deleteBySource).not.toHaveBeenCalled();
  });

  it('is idempotent: a relay retry runs the delete again without failing', async () => {
    const { subscriber, ragService } = build();
    await subscriber.handleTicketEvent(deleted);
    await subscriber.handleTicketEvent(deleted);
    expect(ragService.deleteBySource).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing', null],
    ['soft-deleted', { id: 'proj-1', deletedAt: new Date() }],
  ])('completes without deleting when the project is %s', async (_label, project) => {
    const { subscriber, ragService } = build(project);
    await expect(subscriber.handleTicketEvent(deleted)).resolves.toBeUndefined();
    expect(ragService.deleteBySource).not.toHaveBeenCalled();
  });

  it('ignores a payload without ticketId or projectId', async () => {
    const { subscriber, ragService } = build();
    await subscriber.handleTicketEvent({ action: 'TICKET_DELETED' });
    expect(ragService.deleteBySource).not.toHaveBeenCalled();
  });

  it('handleTicketEvent removes the document through a real VectorStore', async () => {
    const ragConfig = { lancedbPath: './lancedb-kb-lifecycle-test', inMemoryOnly: true, ftsIndexMode: 'simple' } as IRagConfig;
    const embedding = { embed: jest.fn().mockResolvedValue(Array(8).fill(0.1)), providerName: 'fake', modelName: 'fake-v1', dimensions: 8 };
    const ragService = new RagService(new VectorStore(ragConfig, embedding as never));
    await ragService.indexDocument('proj-1', { source: 'ticket', sourceId: 'tick-1', content: 'closed ticket', metadata: {} });
    const subscriber = new KbTicketLifecycleSubscriber(
      { register: jest.fn() } as unknown as FanOutPublisher,
      ragService,
      { findProjectById: jest.fn().mockResolvedValue(liveProject) } as unknown as PrismaRagRepository,
    );

    await subscriber.handleTicketEvent(deleted);

    expect(await ragService.listDocuments('proj-1')).toEqual([]);
  });
});

describe('KB indexing is already an upsert (pin; fixed by H7, spec M15 bullet 2)', () => {
  it('re-indexing the same sourceId keeps one row', async () => {
    const ragConfig = { lancedbPath: './lancedb-kb-upsert-pin', inMemoryOnly: true, ftsIndexMode: 'simple' } as IRagConfig;
    const embedding = { embed: jest.fn().mockResolvedValue(Array(8).fill(0.1)), providerName: 'fake', modelName: 'fake-v1', dimensions: 8 };
    const store = new VectorStore(ragConfig, embedding as never);

    await store.indexDocument('proj-1', { source: 'ticket', sourceId: 'tick-9', content: 'v1', metadata: {} });
    await store.indexDocument('proj-1', { source: 'ticket', sourceId: 'tick-9', content: 'v2', metadata: {} });

    const docs = await store.listDocuments('proj-1');
    expect(docs.map((d) => d.content)).toEqual(['v2']);
  });
});
```

Create `apps/api/src/tickets/state-machine/ticket-transitions.autoindex.spec.ts`:

```ts
import { TicketTransitionsService } from './ticket-transitions.service';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function build(ticketRow: Record<string, unknown> | null) {
  const repo = { findTicketWithComments: jest.fn().mockResolvedValue(ticketRow) };
  const ragService = { indexDocument: jest.fn().mockResolvedValue('doc-1') };
  const service = new TicketTransitionsService(repo as never, { run: jest.fn() } as never, ragService as never);
  const autoIndex = (service as unknown as {
    autoIndexTicket: (project: { id: string; key: string; autoIndexOnClose: boolean }, ticket: { id: string }) => void;
  }).autoIndexTicket.bind(service);
  return { autoIndex, ragService };
}

const project = { id: 'proj-1', key: 'KODA', autoIndexOnClose: true };
const baseRow = { id: 'tick-1', number: 7, title: 'T', type: 'BUG', description: null, comments: [], deletedAt: null };

describe('TicketTransitionsService.autoIndexTicket', () => {
  it('indexes a closed ticket', async () => {
    const { autoIndex, ragService } = build(baseRow);
    autoIndex(project, { id: 'tick-1' });
    await flush();
    expect(ragService.indexDocument).toHaveBeenCalledWith('proj-1', expect.objectContaining({ sourceId: 'tick-1' }));
  });

  it('skips a ticket that was deleted before the index ran', async () => {
    const { autoIndex, ragService } = build({ ...baseRow, deletedAt: new Date() });
    autoIndex(project, { id: 'tick-1' });
    await flush();
    expect(ragService.indexDocument).not.toHaveBeenCalled();
  });
});
```

Append to `apps/api/src/rag/rag-config-and-module.spec.ts` (inside its top-level `describe`). This test proves the fix actually runs in production: the unit tests above build the subscriber by hand and never go through Nest DI.

```ts
  it('registers KbTicketLifecycleSubscriber as a RagModule provider (M15 wiring)', () => {
    const providers = (Reflect.getMetadata('providers', RagModule) ?? []) as Array<{ name?: string; provide?: unknown }>;
    expect(providers.map((p) => p.name ?? String(p.provide))).toContain('KbTicketLifecycleSubscriber');
  });
```

Add `import { RagModule } from './rag.module';` if the file does not import it yet.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bun run test -- src/rag/kb-ticket-lifecycle.subscriber.spec.ts src/tickets/state-machine/ticket-transitions.autoindex.spec.ts src/rag/rag-config-and-module.spec.ts`
Expected: FAIL. The subscriber module does not exist, the deleted ticket is indexed, and `RagModule` does not provide the subscriber. The upsert pin passes (expected: it pins existing behaviour).

- [ ] **Step 3: Implement**

Create `apps/api/src/rag/kb-ticket-lifecycle.subscriber.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { RagService } from './rag.service';
import { PrismaRagRepository } from './prisma-rag.repository';

/**
 * M15: removes a ticket's KB document when the ticket is soft-deleted.
 *
 * Every ticket_event subscriber receives every action, so this handler acts on
 * TICKET_DELETED only. The outbox is at-least-once and a retry re-runs every
 * handler; deleteBySource is idempotent. A missing or soft-deleted project has
 * no reachable KB, so the event completes instead of failing on every retry.
 */
@Injectable()
export class KbTicketLifecycleSubscriber implements OnModuleInit {
  private readonly logger = new Logger(KbTicketLifecycleSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly ragService: RagService,
    private readonly ragRepository: PrismaRagRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handleTicketEvent.bind(this));
  }

  async handleTicketEvent(payload: unknown): Promise<void> {
    const event = (payload ?? {}) as { action?: unknown; ticketId?: unknown; projectId?: unknown; id?: unknown };
    if (event.action !== 'TICKET_DELETED') return;
    if (typeof event.ticketId !== 'string' || typeof event.projectId !== 'string') {
      this.logger.warn(`TICKET_DELETED event ${String(event.id)} has no ticketId/projectId; skipping KB cleanup`);
      return;
    }

    const project = await this.ragRepository.findProjectById(event.projectId);
    if (!project || project.deletedAt !== null) return;

    await this.ragService.deleteBySource(event.projectId, event.ticketId);
  }
}
```

In `rag.module.ts`, add `import { KbTicketLifecycleSubscriber } from './kb-ticket-lifecycle.subscriber';` and add `KbTicketLifecycleSubscriber,` to `providers` right after `EntityStoreWarmup,`.

In `ticket-transitions.service.ts`, change line 180 from `if (!ticketFull) return;` to:

```ts
        // M15: a ticket deleted while this fire-and-forget index was pending must
        // not be re-added after the TICKET_DELETED handler removed it.
        if (!ticketFull || ticketFull.deletedAt) return;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test -- src/rag src/tickets src/outbox` then `cd apps/api && bun run test:scoped test/integration/memory/outbox-fanout-extraction.integration.spec.ts test/integration/rag/rag-close-to-search.integration.spec.ts`
Expected: PASS. If `rag-config-and-module.spec.ts` asserts the exact number of registered `ticket_event` handlers, update the count and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/rag/kb-ticket-lifecycle.subscriber.ts apps/api/src/rag/kb-ticket-lifecycle.subscriber.spec.ts apps/api/src/rag/rag.module.ts apps/api/src/rag/rag-config-and-module.spec.ts apps/api/src/tickets/state-machine/ticket-transitions.service.ts apps/api/src/tickets/state-machine/ticket-transitions.autoindex.spec.ts
git commit -m "fix(rag): remove a deleted ticket's KB document via the outbox (M15)"
```

---

### Task 5: M19 graph and vector consistency

**Files:**
- Modify: `apps/api/prisma/schema.prisma:427-441` (`GraphNode`)
- Create: `apps/api/prisma/migrations/20260928120000_graph_node_vector_stale/migration.sql`
- Modify: `apps/api/src/rag/prisma-rag.repository.ts:67-162`
- Modify: `apps/api/src/rag/domain/rag.domain.ts:19-37`
- Modify: `apps/api/src/rag/graph-store.service.ts`
- Modify: `apps/api/src/rag/graph-store.service.spec.ts`
- Modify: `apps/api/src/rag/incremental-graph-diff.service.ts`
- Modify: `apps/api/src/rag/incremental-graph-diff.service.spec.ts`
- Create: `apps/api/test/integration/rag/graph-vector-consistency.integration.spec.ts`
- Modify: `apps/api/test/integration/rag/incremental-graph-diff.integration.spec.ts:161-169`
- Modify: `apps/api/test/integration/rag/incremental-graph-diff-service-call.integration.spec.ts:61-63, 128-129`

**Interfaces:**
- Produces (repository):
  - `export interface GraphDiffWrite { removedNodeIds: string[]; nodes: Array<{ nodeId: string; label: string; type?: string; sourceFile?: string; community?: number }>; links: Array<{ sourceId: string; targetId: string; relation?: string }> }`
  - `applyGraphDiff(projectId: string, diff: GraphDiffWrite): Promise<void>` (one interactive transaction)
  - `markGraphNodesVectorStale(projectId: string, nodeIds: string[]): Promise<void>`
  - `findVectorStaleNodeIds(projectId: string): Promise<string[]>`
  - `clearGraphNodeVectorStale(projectId: string, nodeId: string): Promise<void>`
- Produces (`GraphStoreService`): `applyDiff(projectId, { removedNodeIds: string[]; nodes: GraphifyNodeDto[]; links: GraphifyLinkDto[] })`, `markVectorStale(projectId, nodeIds)`, `findVectorStaleNodeIds(projectId)`, `clearVectorStale(projectId, nodeId)`. **Removed:** `upsertNodes`, `deleteNodes`, `deleteLinks` (the last had no production caller).
- `IncrementalGraphDiffService.diffAndApply(projectId, nodes, links): Promise<DiffResult>` keeps its signature and `DiffResult` shape.

**New order inside `diffAndApply`:**
0. Load the stored graph once. Re-index every leftover `vectorStale` node from it, clearing each flag after its write.
1. Compute the diff. Mark updated + removed nodes stale (pre-mark), then delete their LanceDB vectors.
2. `applyDiff`: one transaction (removals, upserts with `vectorStale = true`, links replaced for changed sources, deduped in memory, `createMany({ skipDuplicates: true })`). Skipped when there is nothing to write.
3. Index added + updated nodes from the incoming data, clearing each flag after its write.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/rag/graph-vector-consistency.integration.spec.ts`:

```ts
/**
 * M19: the graph (Prisma) and its vectors (LanceDB) cannot commit atomically,
 * so the write is retry-safe instead: a failure between the stores leaves
 * nodes vectorStale, and the next import heals them.
 * Run: cd apps/api && bun run test:scoped test/integration/rag/graph-vector-consistency.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { IRagConfig } from '../../../src/config/rag.config';
import { PrismaRagRepository } from '../../../src/rag/prisma-rag.repository';
import { GraphStoreService } from '../../../src/rag/graph-store.service';
import { VectorStore } from '../../../src/rag/vector-store.service';
import { IncrementalGraphDiffService } from '../../../src/rag/incremental-graph-diff.service';
import type { GraphifyLinkDto, GraphifyNodeDto } from '../../../src/rag/dto/import-graphify.dto';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const ragConfig = {
  lancedbPath: './lancedb-m19-test',
  inMemoryOnly: true,
  ftsIndexMode: 'simple',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
} as IRagConfig;

const embedding = {
  embed: async (): Promise<number[]> => Array(8).fill(0.1),
  providerName: 'fake',
  modelName: 'fake-v1',
  dimensions: 8,
};

const txManager = { run: <T>(fn: () => Promise<T>): Promise<T> => fn(), getClient: () => undefined, isInTransaction: () => false };

describeIntegration('M19 graph <-> vector consistency', () => {
  let prismaService: PrismaService<PrismaClient>;
  let repo: PrismaRagRepository;
  let vectorStore: VectorStore;
  let diff: IncrementalGraphDiffService;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    await resetDb();
    prismaService = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: process.env.DATABASE_URL } } } });
    await prismaService.onModuleInit();
    repo = new PrismaRagRepository(prismaService);
    vectorStore = new VectorStore(ragConfig, embedding as never, undefined, repo);
    diff = new IncrementalGraphDiffService(new GraphStoreService(repo), vectorStore, txManager as never);
  });

  afterAll(async () => {
    await prismaService?.onModuleDestroy();
  });

  beforeEach(async () => {
    seq += 1;
    projectId = (
      await prismaService.client.project.create({ data: { name: `M19 ${seq}`, slug: `m19-${seq}-${Date.now()}`, key: `MN${seq}` } })
    ).id;
  });

  const nodes: GraphifyNodeDto[] = [
    { id: 'n1', label: 'AuthService', type: 'class' },
    { id: 'n2', label: 'UserController', type: 'class' },
  ];
  const links: GraphifyLinkDto[] = [{ source: 'n1', target: 'n2', relation: 'uses' }];

  const staleFlags = async (): Promise<Record<string, boolean>> => {
    const rows = await prismaService.client.graphNode.findMany({ where: { projectId }, orderBy: { nodeId: 'asc' } });
    return Object.fromEntries(rows.map((r) => [r.nodeId, r.vectorStale]));
  };
  const vectorSourceIds = async (): Promise<string[]> =>
    (await vectorStore.listDocuments(projectId)).map((d) => d.sourceId).sort();

  it('a crash between the graph commit and re-indexing heals on the next import', async () => {
    const spy = jest.spyOn(vectorStore, 'indexDocument').mockRejectedValueOnce(new Error('lance down'));
    await expect(diff.diffAndApply(projectId, nodes, links)).rejects.toThrow('lance down');
    spy.mockRestore();

    expect(await staleFlags()).toEqual({ n1: true, n2: true });

    await diff.diffAndApply(projectId, nodes, links);

    expect(await staleFlags()).toEqual({ n1: false, n2: false });
    expect(await vectorSourceIds()).toEqual(['n1', 'n2']);
  });

  it('a failed graph write after the vector delete still leaves the node healable', async () => {
    await diff.diffAndApply(projectId, nodes, links);

    const renamed = [{ ...nodes[0], label: 'AuthServiceV2' }, nodes[1]];
    const spy = jest.spyOn(repo, 'applyGraphDiff').mockRejectedValueOnce(new Error('pg down'));
    await expect(diff.diffAndApply(projectId, renamed, links)).rejects.toThrow('pg down');
    spy.mockRestore();

    // The graph still holds the original label and the vector is gone; the
    // pre-mark means an import of the ORIGINAL (unchanged) graph re-indexes it.
    expect(await staleFlags()).toEqual({ n1: true, n2: false });
    await diff.diffAndApply(projectId, nodes, links);

    expect(await staleFlags()).toEqual({ n1: false, n2: false });
    const docs = await vectorStore.listDocuments(projectId);
    const n1Content = docs.find((d) => d.sourceId === 'n1')?.content ?? '';
    expect(n1Content).toContain('class AuthService');
    expect(n1Content).not.toContain('AuthServiceV2');
  });

  it('stores duplicate links once, including links with no relation', async () => {
    const dupLinks: GraphifyLinkDto[] = [
      { source: 'n1', target: 'n2', relation: 'uses' },
      { source: 'n1', target: 'n2', relation: 'uses' },
      { source: 'n1', target: 'n2' },
      { source: 'n1', target: 'n2' },
    ];

    await diff.diffAndApply(projectId, nodes, dupLinks);

    const stored = await prismaService.client.graphLink.findMany({ where: { projectId } });
    expect(stored).toHaveLength(2);
  });

  it('removed nodes lose their graph rows, their links and their vectors', async () => {
    await diff.diffAndApply(projectId, nodes, links);
    await diff.diffAndApply(projectId, [nodes[1]], []);

    expect(await staleFlags()).toEqual({ n2: false });
    expect(await prismaService.client.graphLink.count({ where: { projectId } })).toBe(0);
    expect(await vectorSourceIds()).toEqual(['n2']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/rag/graph-vector-consistency.integration.spec.ts`
Expected: FAIL. TypeScript reports that `vectorStale` does not exist on `GraphNode`, and `applyGraphDiff` does not exist.

- [ ] **Step 3: Schema and migration**

In `apps/api/prisma/schema.prisma`, in `model GraphNode`, add after `community   Int?`:

```prisma
  vectorStale Boolean  @default(false) // M19: LanceDB vector missing or out of date; healed on the next import
```

and add after `@@unique([projectId, nodeId])`:

```prisma
  @@index([projectId, vectorStale])
```

Create `apps/api/prisma/migrations/20260928120000_graph_node_vector_stale/migration.sql`:

```sql
-- Track 3 Slice 5 (M19): graph nodes whose LanceDB vector is missing or out of date.
-- Existing rows backfill to false.
ALTER TABLE "GraphNode" ADD COLUMN "vectorStale" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "GraphNode_projectId_vectorStale_idx" ON "GraphNode"("projectId", "vectorStale");
```

Run: `cd apps/api && bun run db:generate` (or `bunx prisma generate`), then prove the migration matches the schema:

```bash
cd apps/api && bunx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://koda:koda@localhost:5433/koda_slice5_shadow_test \
  --exit-code
```

Expected: exit code 0 and an empty diff. (Integration tests use `db push`, so this command is the only check on the migration SQL.)

- [ ] **Step 4: Repository**

In `prisma-rag.repository.ts`, delete `BATCH_SIZE`, `upsertNodesInBatches`, `deleteGraphNodeLinks`, `deleteGraphNodesByIds` and `deleteGraphLinksByNodeIds` (lines 26, 67-162). Add, above the class:

```ts
export interface GraphDiffWrite {
  removedNodeIds: string[];
  nodes: Array<{ nodeId: string; label: string; type?: string; sourceFile?: string; community?: number }>;
  links: Array<{ sourceId: string; targetId: string; relation?: string }>;
}

/** Large graphify imports run hundreds of statements in one interactive transaction. */
const GRAPH_DIFF_TX_TIMEOUT_MS = 120_000;

/**
 * In-memory dedup before createMany: Postgres treats NULLs as distinct in the
 * (projectId, sourceId, targetId, relation) unique index, so skipDuplicates
 * alone would keep duplicate relation-less links.
 */
function dedupeLinks(links: GraphDiffWrite['links']): GraphDiffWrite['links'] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.sourceId}\u0000${link.targetId}\u0000${link.relation ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

and inside the class:

```ts
  /**
   * M19: one transaction for the whole graph write. Removed nodes and every link
   * touching them go; changed nodes are upserted with vectorStale = true; their
   * outgoing links are replaced by the deduped incoming set.
   */
  async applyGraphDiff(projectId: string, diff: GraphDiffWrite): Promise<void> {
    const changedIds = diff.nodes.map((n) => n.nodeId);
    await this.prisma.client.$transaction(
      async (client) => {
        const db = client as unknown as PrismaClient;
        if (diff.removedNodeIds.length > 0) {
          await db.graphLink.deleteMany({
            where: {
              projectId,
              OR: [{ sourceId: { in: diff.removedNodeIds } }, { targetId: { in: diff.removedNodeIds } }],
            },
          });
          await db.graphNode.deleteMany({ where: { projectId, nodeId: { in: diff.removedNodeIds } } });
        }
        for (const node of diff.nodes) {
          const fields = { label: node.label, type: node.type, sourceFile: node.sourceFile, community: node.community, vectorStale: true };
          await db.graphNode.upsert({
            where: { projectId_nodeId: { projectId, nodeId: node.nodeId } },
            create: { projectId, nodeId: node.nodeId, ...fields },
            update: fields,
          });
        }
        if (changedIds.length > 0) {
          await db.graphLink.deleteMany({ where: { projectId, sourceId: { in: changedIds } } });
          const links = dedupeLinks(diff.links);
          if (links.length > 0) {
            await db.graphLink.createMany({
              data: links.map((l) => ({ projectId, sourceId: l.sourceId, targetId: l.targetId, relation: l.relation })),
              skipDuplicates: true,
            });
          }
        }
      },
      { timeout: GRAPH_DIFF_TX_TIMEOUT_MS },
    );
  }

  async markGraphNodesVectorStale(projectId: string, nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;
    await this.prisma.client.graphNode.updateMany({
      where: { projectId, nodeId: { in: nodeIds } },
      data: { vectorStale: true },
    });
  }

  async findVectorStaleNodeIds(projectId: string): Promise<string[]> {
    const rows = await this.prisma.client.graphNode.findMany({
      where: { projectId, vectorStale: true },
      select: { nodeId: true },
      orderBy: { nodeId: 'asc' },
    });
    return rows.map((r) => r.nodeId);
  }

  async clearGraphNodeVectorStale(projectId: string, nodeId: string): Promise<void> {
    await this.prisma.client.graphNode.updateMany({
      where: { projectId, nodeId },
      data: { vectorStale: false },
    });
  }
```

In `domain/rag.domain.ts`, replace the four removed method signatures (lines 19-37) with:

```ts
  applyGraphDiff(projectId: string, diff: GraphDiffWrite): Promise<void>;
  markGraphNodesVectorStale(projectId: string, nodeIds: string[]): Promise<void>;
  findVectorStaleNodeIds(projectId: string): Promise<string[]>;
  clearGraphNodeVectorStale(projectId: string, nodeId: string): Promise<void>;
```

and `import type { GraphDiffWrite } from '../prisma-rag.repository';`. If that import creates a cycle that `bun run check:cycles` (or the repo's cycle gate in `policy-gates`) rejects, move `GraphDiffWrite` into `rag.domain.ts` and import it from there in the repository instead.

- [ ] **Step 5: Graph store**

Replace the body of `graph-store.service.ts` below `getStoredGraph` (lines 48-89) with:

```ts
  async applyDiff(
    projectId: string,
    diff: { removedNodeIds: string[]; nodes: GraphifyNodeDto[]; links: GraphifyLinkDto[] },
  ): Promise<void> {
    await this.ragRepository.applyGraphDiff(projectId, {
      removedNodeIds: diff.removedNodeIds,
      nodes: diff.nodes.map((n) => ({
        nodeId: n.id,
        label: n.label,
        type: n.type,
        sourceFile: n.source_file,
        community: n.community,
      })),
      links: diff.links.map((l) => ({ sourceId: l.source, targetId: l.target, relation: l.relation })),
    });
  }

  markVectorStale(projectId: string, nodeIds: string[]): Promise<void> {
    return this.ragRepository.markGraphNodesVectorStale(projectId, nodeIds);
  }

  findVectorStaleNodeIds(projectId: string): Promise<string[]> {
    return this.ragRepository.findVectorStaleNodeIds(projectId);
  }

  clearVectorStale(projectId: string, nodeId: string): Promise<void> {
    return this.ragRepository.clearGraphNodeVectorStale(projectId, nodeId);
  }
```

Delete the `BATCH_SIZE` static.

In `graph-store.service.spec.ts`: in `makeRagRepo()`, replace the four removed mocks with `applyGraphDiff: jest.fn(), markGraphNodesVectorStale: jest.fn(), findVectorStaleNodeIds: jest.fn(), clearGraphNodeVectorStale: jest.fn(),`. Delete the `upsertNodes`, `deleteNodes` and `deleteLinks` describe blocks (lines 80-end of those blocks), and add:

```ts
  describe('applyDiff', () => {
    it('maps DTO shapes onto the repository write', async () => {
      ragRepo.applyGraphDiff.mockResolvedValue(undefined);

      await service.applyDiff('proj-1', {
        removedNodeIds: ['gone'],
        nodes: [{ id: 'n1', label: 'Foo', type: 'class', source_file: 'foo.ts', community: 1 }],
        links: [{ source: 'n1', target: 'n2', relation: 'CALLS' }],
      });

      expect(ragRepo.applyGraphDiff).toHaveBeenCalledWith('proj-1', {
        removedNodeIds: ['gone'],
        nodes: [{ nodeId: 'n1', label: 'Foo', type: 'class', sourceFile: 'foo.ts', community: 1 }],
        links: [{ sourceId: 'n1', targetId: 'n2', relation: 'CALLS' }],
      });
    });
  });

  describe('vectorStale helpers', () => {
    it('delegate to the repository', async () => {
      ragRepo.findVectorStaleNodeIds.mockResolvedValue(['n1']);

      await service.markVectorStale('proj-1', ['n1']);
      await service.clearVectorStale('proj-1', 'n1');

      expect(await service.findVectorStaleNodeIds('proj-1')).toEqual(['n1']);
      expect(ragRepo.markGraphNodesVectorStale).toHaveBeenCalledWith('proj-1', ['n1']);
      expect(ragRepo.clearGraphNodeVectorStale).toHaveBeenCalledWith('proj-1', 'n1');
    });
  });
```

- [ ] **Step 6: Diff service**

Replace `diffAndApply` in `incremental-graph-diff.service.ts` (lines 27-99) with:

```ts
  async diffAndApply(
    projectId: string,
    newNodes: GraphifyNodeDto[],
    newLinks: GraphifyLinkDto[],
  ): Promise<DiffResult> {
    const startTime = Date.now();

    const storedGraph = await this.graphStore.getStoredGraph(projectId);

    // Step 0 (M19): heal nodes a previous run left without a current vector.
    await this.reindexStaleNodes(projectId, storedGraph);

    const incomingNodeMap = new Map(newNodes.map((n) => [n.id, n]));
    const incomingLinksBySource = this.groupLinksBySource(newLinks);

    const addedNodes: GraphifyNodeDto[] = [];
    const updatedNodes: GraphifyNodeDto[] = [];
    const removedNodeIds: string[] = [];

    for (const [nodeId] of storedGraph.nodeMap) {
      if (!incomingNodeMap.has(nodeId)) {
        removedNodeIds.push(nodeId);
      }
    }

    for (const newNode of newNodes) {
      const storedNode = storedGraph.nodeMap.get(newNode.id);
      if (!storedNode) {
        addedNodes.push(newNode);
      } else {
        const storedLinks = storedGraph.linkMap.get(newNode.id) ?? [];
        const incomingLinks = incomingLinksBySource.get(newNode.id) ?? [];
        if (this.nodeContentChanged(storedNode, newNode, storedLinks, incomingLinks)) {
          updatedNodes.push(newNode);
        }
      }
    }

    // Step 1: pre-mark, then drop the vectors of removed and updated nodes. If the
    // graph write below fails, these nodes stay in the graph marked stale, so the
    // next run re-indexes them even when it sends unchanged content.
    const updatedIds = updatedNodes.map((n) => n.id);
    await this.graphStore.markVectorStale(projectId, [...removedNodeIds, ...updatedIds]);
    for (const nodeId of [...removedNodeIds, ...updatedIds]) {
      await this.vectorStore.deleteBySource(projectId, nodeId);
    }

    // Step 2: one Prisma transaction for the graph write.
    const nodesToUpsert = [...addedNodes, ...updatedNodes];
    if (removedNodeIds.length > 0 || nodesToUpsert.length > 0) {
      const upsertIds = new Set(nodesToUpsert.map((n) => n.id));
      await this.graphStore.applyDiff(projectId, {
        removedNodeIds,
        nodes: nodesToUpsert,
        links: newLinks.filter((l) => upsertIds.has(l.source)),
      });
    }

    // Step 3: index the changed nodes, clearing each flag after its vector lands.
    for (const node of nodesToUpsert) {
      const nodeLinks = incomingLinksBySource.get(node.id) ?? [];
      await this.indexNode(projectId, node, nodeLinks, incomingNodeMap);
      await this.graphStore.clearVectorStale(projectId, node.id);
    }

    return {
      added: addedNodes.length,
      updated: updatedNodes.length,
      removed: removedNodeIds.length,
      indexed: nodesToUpsert.length,
      durationMs: Date.now() - startTime,
    };
  }

  /** Re-indexes every vectorStale node from the stored graph, clearing each flag after its write. */
  private async reindexStaleNodes(projectId: string, storedGraph: StoredGraph): Promise<void> {
    const staleIds = await this.graphStore.findVectorStaleNodeIds(projectId);
    for (const nodeId of staleIds) {
      const node = storedGraph.nodeMap.get(nodeId);
      if (!node) continue;
      await this.indexNode(projectId, node, storedGraph.linkMap.get(nodeId) ?? [], storedGraph.nodeMap);
      await this.graphStore.clearVectorStale(projectId, nodeId);
    }
  }
```

Change the import on line 4 to `import { GraphStoreService, StoredGraph } from './graph-store.service';` (already imports `StoredGraph`; keep it). `txManager` stays injected; it is no longer used in `diffAndApply`. If lint flags it as unused, keep the parameter (it is part of the DI contract other specs construct against) and prefix a comment `// retained for DI compatibility; the graph write owns its transaction (M19)`.

- [ ] **Step 7: Update the existing unit and integration specs**

In `incremental-graph-diff.service.spec.ts`:

- Line 59: `jest.Mocked<Pick<GraphStoreService, 'getStoredGraph' | 'applyDiff' | 'markVectorStale' | 'findVectorStaleNodeIds' | 'clearVectorStale'>>`.
- Lines 68-72: the mock becomes

```ts
    mockGraphStore = {
      getStoredGraph: jest.fn(),
      applyDiff: jest.fn().mockResolvedValue(undefined),
      markVectorStale: jest.fn().mockResolvedValue(undefined),
      findVectorStaleNodeIds: jest.fn().mockResolvedValue([]),
      clearVectorStale: jest.fn().mockResolvedValue(undefined),
    };
```

- Every `expect(mockGraphStore.deleteNodes).toHaveBeenCalledWith(projectId, X)` (lines 107, 126, 204, 407) becomes `expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ removedNodeIds: X }))`.
- Line 147 and lines 386-387 (`...not.toHaveBeenCalled()` for an unchanged graph) become `expect(mockGraphStore.applyDiff).not.toHaveBeenCalled();`.
- Line 370 becomes `expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ nodes: newNodes, links: [] }));`.
- Line 408 becomes `expect(mockGraphStore.applyDiff).toHaveBeenCalledWith(projectId, expect.objectContaining({ nodes: [{ id: 'node-3', label: 'NewService', type: 'class' }], links: [] }));`.
- Replace the test `'LanceDB operations happen after Prisma graph-store writes'` (lines 411-442) with:

```ts
    it('orders the write: pre-mark, vector delete, one graph write, index, clear', async () => {
      const calls: string[] = [];
      mockGraphStore.markVectorStale.mockImplementation(async () => { calls.push('markVectorStale'); });
      mockGraphStore.applyDiff.mockImplementation(async () => { calls.push('applyDiff'); });
      mockGraphStore.clearVectorStale.mockImplementation(async () => { calls.push('clearVectorStale'); });
      mockVectorStore.deleteBySource.mockImplementation(async () => { calls.push('deleteBySource'); });
      mockVectorStore.indexDocument.mockImplementation(async () => { calls.push('indexDocument'); });

      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([makeStoredNode('old-node')]));

      await service.diffAndApply('test-project', [{ id: 'new-node', label: 'New', type: 'class' }], []);

      expect(calls).toEqual(['markVectorStale', 'deleteBySource', 'applyDiff', 'indexDocument', 'clearVectorStale']);
    });

    it('re-indexes leftover stale nodes from the stored graph before diffing', async () => {
      mockGraphStore.getStoredGraph.mockResolvedValue(storedGraphFromNodes([makeStoredNode('node-1')]));
      mockGraphStore.findVectorStaleNodeIds.mockResolvedValue(['node-1']);

      await service.diffAndApply('test-project', [makeStoredNode('node-1')], []);

      expect(mockVectorStore.indexDocument).toHaveBeenCalledWith('test-project', expect.objectContaining({ sourceId: 'node-1' }));
      expect(mockGraphStore.clearVectorStale).toHaveBeenCalledWith('test-project', 'node-1');
      expect(mockGraphStore.applyDiff).not.toHaveBeenCalled();
    });
```

- Any remaining `mockGraphStore.upsertNodes` / `deleteNodes` references: grep and convert with the same mapping (`grep -n "upsertNodes\|deleteNodes" apps/api/src/rag/incremental-graph-diff.service.spec.ts` must print nothing).

In `test/integration/rag/incremental-graph-diff.integration.spec.ts` lines 161-169, replace the `upsertNodes` spy with:

```ts
      const applySpy = jest.spyOn(graphStore, 'applyDiff');

      const firstResult = await ragService.importGraphify(projectId, nodes, links);

      expect(firstResult.imported).toBe(3);
      expect(applySpy).toHaveBeenCalledTimes(1);
      expect(applySpy.mock.calls[0][1].nodes).toHaveLength(3);
      applySpy.mockRestore();
```

In `test/integration/rag/incremental-graph-diff-service-call.integration.spec.ts`, replace lines 61-63 with `applyDiff: jest.fn().mockResolvedValue(undefined), markVectorStale: jest.fn().mockResolvedValue(undefined), findVectorStaleNodeIds: jest.fn().mockResolvedValue([]), clearVectorStale: jest.fn().mockResolvedValue(undefined),`, and lines 128-129 with `mockGraphStore.applyDiff.mockClear();`.

- [ ] **Step 8: Run all graph tests**

Run: `cd apps/api && bun run test -- src/rag` then `cd apps/api && bun run test:scoped test/integration/rag/graph-vector-consistency.integration.spec.ts test/integration/rag/incremental-graph-diff.integration.spec.ts test/integration/rag/incremental-graph-diff-service-call.integration.spec.ts test/integration/rag/project-code-documents.integration.spec.ts test/integration/rag/import-graphify-permission.integration.spec.ts`
Expected: PASS.

- [ ] **Step 9: Orphan check and commit**

Run: `grep -rn "upsertNodesInBatches\|deleteGraphNodeLinks\|deleteGraphNodesByIds\|deleteGraphLinksByNodeIds\|upsertNodes\|\.deleteNodes\|deleteLinks" apps/api/src apps/api/test apps/api/scripts`
Expected: no output.

```bash
git add apps/api/prisma apps/api/src/rag apps/api/test/integration/rag
git commit -m "fix(rag): make the graph -> vector write retry-safe with vectorStale (M19)"
```

---

### Task 6: M21 governance keyset paging and SQL groupBy

**Files:**
- Modify: `apps/api/src/memory/prisma-memory-item.repository.ts` (add three methods after `findByProject`)
- Modify: `apps/api/src/memory/memory-governance.service.ts:47-81, 119-227`
- Modify: `apps/api/src/memory/memory-governance.service.spec.ts` (blocks AC-3, AC-5, AC-6, AC-7)
- Create: `apps/api/test/integration/memory/memory-governance-paging.integration.spec.ts`

**Interfaces:**
- Produces (repository):
  - `findActiveAfterId(projectId: string, afterId: string | null, take: number): Promise<MemoryItem[]>`: active, not deleted, `id > afterId`, ordered by `id` ascending.
  - `findDuplicateActiveKeys(projectId: string, kind?: string): Promise<MemoryDedupKey[]>` with `export interface MemoryDedupKey { kind: string; subject: string; predicate: string }`: SQL `groupBy` on the dedup key, `having count > 1`.
  - `findActiveByKey(projectId: string, key: MemoryDedupKey): Promise<MemoryItem[]>`: every active row for one key, ordered by `id`.
- `MemoryGovernanceService` public methods keep their signatures and `{ count }` results.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/memory/memory-governance-paging.integration.spec.ts`:

```ts
/**
 * M21: governance jobs must not skip rows while they move rows out of 'active',
 * and dedup must see duplicates that sit more than one page apart.
 * Run: cd apps/api && bun run test:scoped test/integration/memory/memory-governance-paging.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { MemoryGovernanceService } from '../../../src/memory/memory-governance.service';
import { MemoryKind } from '../../../src/common/enums';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('MemoryGovernanceService paging (M21)', () => {
  let prismaService: PrismaService<PrismaClient>;
  let service: MemoryGovernanceService;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    await resetDb();
    prismaService = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: process.env.DATABASE_URL } } } });
    await prismaService.onModuleInit();
    const prisma = prismaService.client;
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    service = new MemoryGovernanceService(new PrismaMemoryItemRepository(txManager, prismaService));
  });

  afterAll(async () => {
    await prismaService?.onModuleDestroy();
  });

  beforeEach(async () => {
    seq += 1;
    projectId = (
      await prismaService.client.project.create({ data: { name: `M21 ${seq}`, slug: `m21-${seq}-${Date.now()}`, key: `MG${seq}` } })
    ).id;
  });

  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

  it('expires every expired row even when there are several pages of them', async () => {
    await prismaService.client.memoryItem.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        projectId,
        kind: MemoryKind.FACT,
        subject: `ticket:${i}`,
        predicate: 'status',
        activeKey: `FACT:ticket:${i}:status`,
        ttlAt: past,
      })),
    });

    const result = await service.expireMemories(projectId);

    expect(result.count).toBe(250);
    expect(await prismaService.client.memoryItem.count({ where: { projectId, status: 'active' } })).toBe(0);
  });

  it('deduplicates rows with the same key that sit more than a page apart', async () => {
    // A legacy active row without activeKey (the unique index allows one keyed row per key).
    const winner = await prismaService.client.memoryItem.create({
      data: { projectId, kind: MemoryKind.FACT, subject: 'KODA-1', predicate: 'owner', confidence: 0.9, activeKey: null },
    });
    await prismaService.client.memoryItem.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        projectId,
        kind: MemoryKind.FACT,
        subject: `filler:${i}`,
        predicate: 'status',
        activeKey: `FACT:filler:${i}:status`,
      })),
    });
    const loser = await prismaService.client.memoryItem.create({
      data: { projectId, kind: MemoryKind.FACT, subject: 'KODA-1', predicate: 'owner', confidence: 0.5, activeKey: 'FACT:KODA-1:owner' },
    });

    const result = await service.deduplicate(projectId);

    expect(result.count).toBe(1);
    const after = await prismaService.client.memoryItem.findUniqueOrThrow({ where: { id: loser.id } });
    expect(after).toMatchObject({ status: 'superseded', supersededBy: winner.id, activeKey: null });
  });

  it('supersedes older DECISIONs on the same topic across pages', async () => {
    const older = await prismaService.client.memoryItem.create({
      data: {
        projectId,
        kind: MemoryKind.DECISION,
        subject: 'agent:a1',
        predicate: 'db-choice',
        activeKey: 'DECISION:agent:a1:db-choice',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prismaService.client.memoryItem.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        projectId,
        kind: MemoryKind.DECISION,
        subject: `agent:filler${i}`,
        predicate: 'x',
        activeKey: `DECISION:agent:filler${i}:x`,
      })),
    });
    const newer = await prismaService.client.memoryItem.create({
      data: { projectId, kind: MemoryKind.DECISION, subject: 'agent:a1', predicate: 'db-choice', activeKey: null, createdAt: new Date('2026-06-01T00:00:00Z') },
    });

    const result = await service.applySupersession(projectId);

    expect(result.count).toBe(1);
    const after = await prismaService.client.memoryItem.findUniqueOrThrow({ where: { id: older.id } });
    expect(after).toMatchObject({ status: 'superseded', supersededBy: newer.id, activeKey: null });
  });

  it('is idempotent: a second run changes nothing', async () => {
    await prismaService.client.memoryItem.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        projectId,
        kind: MemoryKind.FACT,
        subject: `ticket:${i}`,
        predicate: 'status',
        activeKey: `FACT:ticket:${i}:status`,
        ttlAt: past,
      })),
    });

    await service.runCleanup(projectId);
    const second = await service.runCleanup(projectId);

    expect(second).toMatchObject({ expiredCount: 0, deduplicatedCount: 0, supersessionCount: 0 });
  });
});
```

> Check `MemoryKind` values in `apps/api/src/common/enums` before running: this test assumes `MemoryKind.FACT` and `MemoryKind.DECISION` (the schema comment lists `FACT | DECISION | ...`).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/memory/memory-governance-paging.integration.spec.ts`
Expected: FAIL. `expireMemories` returns fewer than 250 (offset paging skips rows it just moved out of `active`). Both cross-page cases return `count: 0`.

- [ ] **Step 3: Repository methods**

In `prisma-memory-item.repository.ts`, export next to `buildActiveKey`:

```ts
export interface MemoryDedupKey {
  kind: string;
  subject: string;
  predicate: string;
}
```

and add after `findByProject`:

```ts
  /** M21: keyset page over active rows; stable while rows leave 'active'. */
  async findActiveAfterId(projectId: string, afterId: string | null, take: number): Promise<MemoryItem[]> {
    const models = await this.prisma.client.memoryItem.findMany({
      where: {
        projectId,
        deletedAt: null,
        status: 'active',
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
    });
    return models.map((m) => this.toDomain(m));
  }

  /** M21: dedup keys with more than one active row, found in SQL instead of per page. */
  async findDuplicateActiveKeys(projectId: string, kind?: string): Promise<MemoryDedupKey[]> {
    const groups = await this.prisma.client.memoryItem.groupBy({
      by: ['kind', 'subject', 'predicate'],
      where: { projectId, deletedAt: null, status: 'active', ...(kind ? { kind } : {}) },
      having: { id: { _count: { gt: 1 } } },
      orderBy: [{ kind: 'asc' }, { subject: 'asc' }, { predicate: 'asc' }],
    });
    return groups.map(({ kind: k, subject, predicate }) => ({ kind: k, subject, predicate }));
  }

  async findActiveByKey(projectId: string, key: MemoryDedupKey): Promise<MemoryItem[]> {
    const models = await this.prisma.client.memoryItem.findMany({
      where: { projectId, deletedAt: null, status: 'active', kind: key.kind, subject: key.subject, predicate: key.predicate },
      orderBy: { id: 'asc' },
    });
    return models.map((m) => this.toDomain(m));
  }
```

If `toDomain` is `private` with a signature that does not accept the `findMany` model type, keep the existing call style used by `findByProject` (`models.remap((m) => this.toDomain(m))` there; `.map` here).

- [ ] **Step 4: Governance service**

In `memory-governance.service.ts`, replace `expireMemories` (lines 47-81) with:

```ts
  async expireMemories(projectId: string): Promise<{ count: number }> {
    const now = new Date();
    let expiredCount = 0;
    let afterId: string | null = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.repository.findActiveAfterId(projectId, afterId, PAGE_SIZE);
      for (const item of batch) {
        if (item.ttlAt && item.ttlAt < now) {
          await this.repository.updateDirect(item.id, { status: 'rejected', activeKey: null });
          expiredCount++;
        }
      }
      if (batch.length < PAGE_SIZE) return { count: expiredCount };
      afterId = batch[batch.length - 1].id;
    }

    this.logger.warn(`expireMemories: pagination exceeded ${MAX_PAGES} pages for project ${projectId}`);
    return { count: expiredCount };
  }
```

Replace `deduplicate` and `applySupersession` (lines 119-227) with:

```ts
  async deduplicate(projectId: string): Promise<{ count: number }> {
    let supersededCount = 0;
    for (const key of await this.repository.findDuplicateActiveKeys(projectId)) {
      const group = await this.repository.findActiveByKey(projectId, key);
      supersededCount += await this.supersedeAllBut(group, (a, b) => b.confidence - a.confidence);
    }
    return { count: supersededCount };
  }

  async applySupersession(projectId: string): Promise<{ count: number }> {
    let supersededCount = 0;
    for (const key of await this.repository.findDuplicateActiveKeys(projectId, MemoryKind.DECISION)) {
      const group = await this.repository.findActiveByKey(projectId, key);
      supersededCount += await this.supersedeAllBut(group, (a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    return { count: supersededCount };
  }

  /** Keeps the first row under `rank` and supersedes the keyed rest; returns how many changed. */
  private async supersedeAllBut(group: MemoryItem[], rank: (a: MemoryItem, b: MemoryItem) => number): Promise<number> {
    if (group.length <= 1) return 0;
    const [winner, ...rest] = [...group].sort(rank);
    let count = 0;
    for (const item of rest) {
      if (item.activeKey) {
        await this.repository.updateDirect(item.id, { status: 'superseded', supersededBy: winner.id, activeKey: null });
        count++;
      }
    }
    return count;
  }
```

`downrankStaleLowConfidence` stays as it is (spec: out of scope). `PageOption` stays imported for it.

- [ ] **Step 5: Update the unit spec**

In `src/memory/memory-governance.service.spec.ts`, add `findActiveAfterId: jest.fn(), findDuplicateActiveKeys: jest.fn(), findActiveByKey: jest.fn(),` to `createMockRepository`. Rewrite the four affected blocks as follows. AC-2, AC-4 and AC-9 are unchanged.

- **AC-3 (`expireMemories`)**: every `mockRepository.findByProject.mockResolvedValueOnce({ records: X, ... })` becomes `mockRepository.findActiveAfterId.mockResolvedValueOnce(X)`, and the trailing empty page becomes `.mockResolvedValueOnce([])`. Replace the `findByProject` call assertion with `expect(mockRepository.findActiveAfterId).toHaveBeenCalledWith('project-123', null, 100);`. Keep the `updateDirect` assertions. Keep the `'should not expire memories that are not active'` test but mock `findActiveAfterId` to return `[]` (the repository filters status now) and assert `updateDirect` was not called.
- **AC-5 (`deduplicate`)**: mock `findDuplicateActiveKeys.mockResolvedValue([{ kind: 'FACT', subject: 'ticket:1', predicate: 'status' }])` and `findActiveByKey.mockResolvedValue(<the group the old test put in records>)`. For the "single memories" case, mock `findDuplicateActiveKeys.mockResolvedValue([])` and assert `findActiveByKey` was not called.
- **AC-6 (`applySupersession`)**: same shape; also assert `expect(mockRepository.findDuplicateActiveKeys).toHaveBeenCalledWith('project-123', 'DECISION');`. The "non-DECISION kind" case becomes: `findDuplicateActiveKeys` returns `[]` and `updateDirect` is not called.
- **AC-7 (idempotent)**: the group returned by `findActiveByKey` has only one row with `activeKey`; assert `updateDirect` was not called.

Run: `grep -n "findByProject" apps/api/src/memory/memory-governance.service.spec.ts`
Expected: matches only inside the AC-4 (`downrankStaleLowConfidence`) block.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && bun run test -- src/memory test/integration/memory/memory-governance.unit.spec.ts` then `cd apps/api && bun run test:scoped test/integration/memory`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/memory apps/api/test/integration/memory/memory-governance-paging.integration.spec.ts
git commit -m "fix(memory): keyset paging and SQL groupBy in governance jobs (M21)"
```

---

### Task 7: Delete `LexicalIndex`

**Files:**
- Delete: `apps/api/src/rag/lexical-index.ts`
- Delete: `apps/api/test/integration/rag/lexical-index.integration.spec.ts`
- Modify: `apps/api/src/rag/rag.module.ts` (lines 11, 25-76, 144-145, 168)
- Modify: `apps/api/src/rag/vector-store.service.ts` (lines 7, 41, 108, 235-237, 480-482)
- Modify: `apps/api/test/integration/rag/lance-table-manager.integration.spec.ts:96-104, 468-476`
- Modify: `apps/api/src/rag/vector-store.filter-guard.spec.ts` (Task 1's constructor call)

**Interfaces:**
- `VectorStore` constructor becomes `(ragConfig, embeddingService?, optimizeStrategy?, ragRepository?, entityStore?, lanceTableManager?)`: the fifth parameter (`lexicalIndex`) is gone, and later positional arguments shift left by one.
- `RagModule` no longer exports `LexicalIndex`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/rag/rag-config-and-module.spec.ts` (inside its top-level `describe`):

```ts
  it('no longer provides the unused LexicalIndex or its 50k-row warmup', () => {
    const providers = (Reflect.getMetadata('providers', RagModule) ?? []) as Array<{ name?: string; provide?: unknown }>;
    const names = providers.map((p) => p.name ?? String(p.provide));
    expect(names).not.toContain('LexicalIndex');
    expect(names).not.toContain('LexicalIndexWarmup');
    const exported = (Reflect.getMetadata('exports', RagModule) ?? []) as Array<{ name?: string }>;
    expect(exported.map((e) => e.name)).not.toContain('LexicalIndex');
  });
```

The `RagModule` import already exists from Task 4.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test -- src/rag/rag-config-and-module.spec.ts`
Expected: FAIL (`LexicalIndex` is provided).

- [ ] **Step 3: Delete and unwire**

1. `git rm apps/api/src/rag/lexical-index.ts apps/api/test/integration/rag/lexical-index.integration.spec.ts`
2. `rag.module.ts`: delete the `LexicalIndex` import (line 11), the whole `LexicalIndexWarmup` class (lines 25-76), the `LexicalIndex,` and `LexicalIndexWarmup,` provider entries, and `LexicalIndex` from `exports`. Remove `RagService` from the `@nestjs/common`-adjacent imports only if nothing else in the file uses it (`RagService` stays a provider). Drop `Optional` from the `@nestjs/common` import only if `EntityStoreWarmup` no longer uses it (it does, so keep it).
3. `vector-store.service.ts`: delete the `LexicalIndex` import (line 7), the constructor parameter `@Optional() private readonly lexicalIndex?: LexicalIndex,` (line 41), `this.lexicalIndex?.clearProject(projectId);` (line 108), the `if (this.lexicalIndex) { ... addDocument ... }` block (lines 235-237), and the `if (this.lexicalIndex) { ... removeDocument ... }` block (lines 480-482).
4. `lance-table-manager.integration.spec.ts`: in both `new VectorStore(` calls, delete one of the `undefined,` lines so `manager` is the sixth argument.
5. `vector-store.filter-guard.spec.ts`: change the constructor call to `new VectorStore(ragConfig, undefined, undefined, undefined, undefined, manager)`.

- [ ] **Step 4: Orphan pass**

Run: `grep -rn "LexicalIndex\|lexicalIndex\|lexical-index\|Bm25" apps/api/src apps/api/test apps/api/scripts`
Expected: no output. (`apps/api/.nax/features/**/.nax-acceptance.test.ts*` still import it. They are historical nax artifacts that Jest ignores (`testPathIgnorePatterns: [".nax/"]`) and `tsc` never includes (`tsconfig.json` includes `src/**` only). Leave them.)

Run: `grep -rn "document_indexed" apps/api/src | grep -v spec`
Expected: only `koda-domain-writer.service.ts` (the producer). With no handler registered, the relay publishes those rows as no-ops (`fan-out-publisher.ts:63-74`). Mention this in the PR.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && bun run test -- src/rag` then `cd apps/api && bun run type-check` then `cd apps/api && bun run test:scoped test/integration/rag`
Expected: PASS. The type-check catches any positional `new VectorStore(` call the grep missed.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src/rag apps/api/test/integration/rag
git commit -m "refactor(rag): delete the unused LexicalIndex and its startup warmup"
```

---

### Task 8: Validated context query and KB list limit; regenerate the contract

**Files:**
- Create: `apps/api/src/context/dto/get-context-query.dto.ts`
- Create: `apps/api/src/context/dto/get-context-query.dto.spec.ts`
- Modify: `apps/api/src/context/context.controller.ts:18-26, 51-67, 76-110`
- Create: `apps/api/src/rag/dto/list-kb-documents.query.ts`
- Create: `apps/api/src/rag/dto/list-kb-documents.query.spec.ts`
- Modify: `apps/api/src/rag/rag.controller.ts:74-88`
- Modify: `apps/api/src/rag/rag.controller.spec.ts:176-201`
- Regenerate: `openapi.json`, `apps/cli/src/generated/**`
- Modify: `apps/cli/src/commands/kb.ts:91`, `apps/cli/src/commands/kb.spec.ts:356`

**Interfaces:**
- Produces: `export class GetContextQueryDto { intent?: ContextIntent; query?: string; ticketIds?: string[]; repoRefs?: string[]; includeCodeIntel?: boolean; includeGraph?: boolean; tokenBudget?: number }` and `export const CONTEXT_INTENTS`.
- Produces: `export class ListKbDocumentsQuery { limit: number = 100 }` (1..500).
- Limits chosen by this plan (the spec only says "gets validators"): `query` at most 2000 characters; `ticketIds` / `repoRefs` at most 100 entries of at most 200 characters each; `tokenBudget` an integer from 1 to 100 000 (default stays 4000 in `context-builder.service.ts:72`).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/context/dto/get-context-query.dto.spec.ts`:

```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { GetContextQueryDto } from './get-context-query.dto';

async function errorsFor(raw: object): Promise<string[]> {
  const errors = await validate(plainToInstance(GetContextQueryDto, raw));
  return errors.map((e) => e.property);
}

describe('GetContextQueryDto', () => {
  it('accepts an empty query (intent defaults downstream)', async () => {
    expect(await errorsFor({})).toEqual([]);
  });

  it('accepts query-string shapes and converts them', async () => {
    const raw = { intent: 'plan', tokenBudget: '500', includeGraph: 'true', ticketIds: 'a, b', repoRefs: ['r1', 'r2'] };
    expect(await errorsFor(raw)).toEqual([]);
    expect(parseQuery(GetContextQueryDto, raw)).toMatchObject({
      intent: 'plan',
      tokenBudget: 500,
      includeGraph: true,
      ticketIds: ['a', 'b'],
      repoRefs: ['r1', 'r2'],
    });
  });

  it('accepts JSON-body shapes', async () => {
    expect(await errorsFor({ intent: 'answer', tokenBudget: 500, includeCodeIntel: false, ticketIds: ['a'] })).toEqual([]);
  });

  it.each([
    [{ intent: 'hack' }, 'intent'],
    [{ tokenBudget: 'abc' }, 'tokenBudget'],
    [{ tokenBudget: '0' }, 'tokenBudget'],
    [{ tokenBudget: '1.5' }, 'tokenBudget'],
    [{ tokenBudget: '100001' }, 'tokenBudget'],
    [{ includeGraph: 'yes' }, 'includeGraph'],
    [{ query: 'x'.repeat(2001) }, 'query'],
    [{ ticketIds: Array.from({ length: 101 }, (_, i) => `t${i}`) }, 'ticketIds'],
  ])('rejects %p', async (raw, property) => {
    expect(await errorsFor(raw)).toContain(property);
  });

  it('parseQuery drops undeclared keys', () => {
    expect(parseQuery(GetContextQueryDto, { projectId: 'evil', intent: 'answer' })).not.toHaveProperty('projectId');
  });
});
```

Create `apps/api/src/rag/dto/list-kb-documents.query.spec.ts`:

```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { ListKbDocumentsQuery } from './list-kb-documents.query';

describe('ListKbDocumentsQuery', () => {
  it('defaults limit to 100', () => {
    expect(parseQuery(ListKbDocumentsQuery, {}).limit).toBe(100);
  });

  it('converts a numeric string', async () => {
    expect(await validate(plainToInstance(ListKbDocumentsQuery, { limit: '25' }))).toEqual([]);
    expect(parseQuery(ListKbDocumentsQuery, { limit: '25' }).limit).toBe(25);
  });

  it.each(['0', '501', '1000', 'abc', '2.5', '-1'])('rejects limit=%s', async (limit) => {
    const errors = await validate(plainToInstance(ListKbDocumentsQuery, { limit }));
    expect(errors.map((e) => e.property)).toEqual(['limit']);
  });
});
```

In `src/rag/rag.controller.spec.ts`, replace the three limit tests in the `listDocuments` block (lines 176-201; replace by content, and keep the block's closing `});`) with:

```ts
    it('lists documents with default limit 100', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', mockAdminUser, {} as ListKbDocumentsQuery);

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 100);
    });

    it('uses the validated limit', async () => {
      mockFindProjectBySlug.mockResolvedValue(mockProject);
      ragService.listDocuments.mockResolvedValue([]);

      await controller.listDocuments('alpha', mockAdminUser, { limit: '25' } as unknown as ListKbDocumentsQuery);

      expect(ragService.listDocuments).toHaveBeenCalledWith('proj-1', 25);
    });
```

and add `import type { ListKbDocumentsQuery } from './dto/list-kb-documents.query';`. (The old "capped at 500" test encoded silent clamping. An out-of-range limit is now a 400 from the global `ValidationPipe`, and the DTO spec covers that.) Other `controller.listDocuments('alpha', mockAdminUser)` calls in the block keep working because the controller defaults a missing query to `{}`. The existing `context.controller.spec.ts` calls (`controller.getContext('my-project', { intent: 'answer' }, adminUser)` and so on) also keep passing unchanged: `buildQuery` now runs them through `parseQuery`, whose `@Type(() => Number)` reproduces the old manual `Number(dto.tokenBudget)` conversion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && bun run test -- src/context/dto src/rag/dto src/rag/rag.controller.spec.ts`
Expected: FAIL (the modules do not exist).

- [ ] **Step 3: Implement the DTOs and controllers**

Create `apps/api/src/context/dto/get-context-query.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { ContextIntent } from '../context-builder.service';

export const CONTEXT_INTENTS: readonly ContextIntent[] = ['answer', 'diagnose', 'plan', 'update', 'search'];

const MAX_LIST_ITEMS = 100;

/** Query strings carry `a,b` or a repeated key; a JSON body carries an array. */
const toStringList = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;

/** Query strings carry 'true'/'false'; anything else is left for @IsBoolean to reject. */
const toBoolean = ({ value }: TransformFnParams): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/**
 * GET /context/:slug query and POST /context/:slug/query body. The global
 * ValidationPipe validates it; controllers read it through parseQuery.
 */
export class GetContextQueryDto {
  @ApiPropertyOptional({ enum: CONTEXT_INTENTS, default: 'answer' })
  @IsOptional()
  @IsIn(CONTEXT_INTENTS)
  intent?: ContextIntent;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  query?: string;

  @ApiPropertyOptional({ type: [String], maxItems: MAX_LIST_ITEMS })
  @IsOptional()
  @Transform(toStringList)
  @IsArray()
  @ArrayMaxSize(MAX_LIST_ITEMS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  ticketIds?: string[];

  @ApiPropertyOptional({ type: [String], maxItems: MAX_LIST_ITEMS })
  @IsOptional()
  @Transform(toStringList)
  @IsArray()
  @ArrayMaxSize(MAX_LIST_ITEMS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  repoRefs?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeCodeIntel?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeGraph?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 100_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  tokenBudget?: number;
}
```

In `context.controller.ts`: delete the inline class (lines 18-26); add `import { GetContextQueryDto } from './dto/get-context-query.dto';` and `import { parseQuery } from '../common/dto/koda-page.query';`; add `@ApiResponse({ status: 400, description: 'Invalid query' })` to both handlers; change `buildQuery` so that it parses first:

```ts
  private buildQuery(projectId: string, actorId: string, raw: GetContextQueryDto | undefined): GetProjectContextQuery {
    const dto = parseQuery(GetContextQueryDto, raw ?? {});
    return {
      projectId,
      actorId,
      intent: dto.intent ?? 'answer',
      query: dto.query,
      ticketIds: dto.ticketIds,
      repoRefs: dto.repoRefs,
      includeCodeIntel: dto.includeCodeIntel,
      includeGraph: dto.includeGraph,
      tokenBudget: dto.tokenBudget,
    };
  }
```

Create `apps/api/src/rag/dto/list-kb-documents.query.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const KB_LIST_MAX_LIMIT = 500;

export class ListKbDocumentsQuery {
  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: KB_LIST_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KB_LIST_MAX_LIMIT)
  limit: number = 100;
}
```

In `rag.controller.ts`, replace `listDocuments` (lines 74-88) with:

```ts
  @Get('documents')
  @ApiOperation({ summary: 'List indexed documents in the project knowledge base' })
  @ApiResponse({ status: 200, description: 'Documents listed' })
  @ApiResponse({ status: 400, description: 'Invalid limit' })
  @ApiResponse({ status: 403, description: 'Forbidden - no project role' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async listDocuments(
    @Param('slug') slug: string,
    @Principal() _principal: KodaPrincipal,
    @Query() rawQuery?: ListKbDocumentsQuery,
  ) {
    const project = await this.resolveProject(slug);
    const { limit } = parseQuery(ListKbDocumentsQuery, rawQuery ?? {});
    const data = await this.ragService.listDocuments(project.id, limit);
    return JsonResponse.Ok(data);
  }
```

with `import { ListKbDocumentsQuery } from './dto/list-kb-documents.query';` and `import { parseQuery } from '../common/dto/koda-page.query';`.

- [ ] **Step 4: Run the API tests**

Run: `cd apps/api && bun run test -- src/context src/rag` then `cd apps/api && bun run test:scoped test/integration/rag/rag-api-project-id-validation.integration.spec.ts test/e2e`
Expected: PASS. If an e2e spec sends `?limit=1000` and expects 200, it encoded the old clamping. Change it to expect 400 and name it in the commit body.

- [ ] **Step 5: Regenerate the contract and fix the CLI**

Run: `bun run generate` (repo root), then `git diff --stat openapi.json apps/cli/src/generated`.
Expected: the context endpoints gain the query parameters and body schema; `ragControllerListDocuments`'s `limit` becomes a `number`.

In `apps/cli/src/commands/kb.ts:91`, change `query: { limit: '100' }` to `query: { limit: 100 }`. In `apps/cli/src/commands/kb.spec.ts:356`, change `limit: '100'` to `limit: 100`.

Run: `cd apps/cli && bun run test -- src/commands/kb.spec.ts src/commands/context.spec.ts && bun run type-check`
Expected: PASS. `context query --token-budget 500` still sends a number, because commander's `parseInt` runs on the option (`context.ts:40`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/context apps/api/src/rag/dto apps/api/src/rag/rag.controller.ts apps/api/src/rag/rag.controller.spec.ts openapi.json apps/cli
git commit -m "fix(api): validate the context query and the KB list limit; regenerate the client"
```

---

### Task 9: Whole-slice verification, eval after, and PR

**Files:**
- Local only: `apps/api/.env.test` (restore)

- [ ] **Step 1: Full local gates**

Run from the worktree root, in order:

```bash
bun run lint
bunx turbo run type-check
cd apps/api && bun run test && cd ../..
cd apps/api && bun run test:integration && cd ../..
cd apps/cli && bun run test && cd ../..
cd apps/web && bun run test && cd ../..
```

Expected: all green. `test:integration` is the full suite here on purpose (against `koda_slice5_test`). If a web e2e/login-throttle 429 cascade shows up, it is the known local-only issue from #150. Rerun the failing spec in isolation and note it in the PR; CI is the arbiter.

- [ ] **Step 2: Eval after**

Repeat Task 0 Step 5 with `tee /tmp/slice5-eval-after.txt`.
Expected: `PASS`. Put both `precision@5_avg` values in the PR. If "after" is lower than "before", stop and investigate: most likely candidates are Task 3 (the M17 candidate pool) and Task 2 (recency). Never lower `CI_THRESHOLD`.

- [ ] **Step 3: Restore `.env.test`**

```bash
cd apps/api
git update-index --no-skip-worktree .env.test
git checkout -- .env.test
git status --short .env.test
```

Expected: no output.

- [ ] **Step 4: Rebase on `main` and regenerate if 2b merged first**

```bash
git fetch origin && git rebase origin/main
```

If `openapi.json` or `apps/cli/src/generated/**` conflict, do not hand-merge them: take either side, run `bun run generate`, and `git add` the result as part of the conflict resolution. Rerun `cd apps/cli && bun run type-check`.

- [ ] **Step 5: Code review, then push and open the PR**

Run the code review (the `code-review` skill or `superpowers:requesting-code-review`) on `origin/main...HEAD` **before** pushing, fix CRITICAL/HIGH findings, then:

```bash
git push -u origin feat/track3-rag-memory
gh pr create --title "fix(rag,memory): Track 3 Slice 5 RAG and memory remediation" --body-file <prepared body>
```

The PR body must include:
- Closes M15, M16 (retriever half), M17, M18, M19, M21, the RAG LOWs, and the filter-guard dedup.
- "Already fixed on main" items 1-3 (pinned by tests, no code).
- The M19 pre-mark addition and why it is needed.
- The migration: adds `GraphNode.vectorStale` (default false) plus an index; no data rewrite.
- `precision@5_avg` before and after.
- The `document_indexed` producer now has zero handlers (published as a no-op).
- Behaviour change: `GET /projects/:slug/kb/documents?limit=` outside 1..500 is now a 400 (it was silently clamped). The context query/body are validated, with the limits listed in Task 8.
- M21 note: `deduplicate`/`applySupersession` can only act on legacy `activeKey = null` rows, because `activeKey` equals the dedup key.
