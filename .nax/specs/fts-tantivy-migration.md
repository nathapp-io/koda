# Feature: FTS Tantivy Migration — Replace In-Memory FTS with LanceDB Native FTS

## Overview

Migrate Koda's RAG knowledge base from the in-memory FTS implementation (capped at 500-doc scan) to LanceDB's native Tantivy-based Full-Text Search. Introduce a configurable **FTS optimize strategy** so users can choose between counter-based, cron-based (`@nestjs/schedule`), or manual optimization.

**Branch:** `feat/fts-tantivy`
**Working directory:** `apps/api`
**Depends on:** Existing RAG module (already merged on `main`)
**LanceDB version:** `@lancedb/lancedb` 0.17.0 (already installed — do NOT upgrade)

---

## Architecture Constraints

### LanceDB 0.17.0 FTS API (MANDATORY — use exactly these)

**Creating an FTS index on a table:**
```typescript
import { Index } from '@lancedb/lancedb';

await table.createIndex('content', {
  config: Index.fts({ baseTokenizer: 'simple', lowercase: true, stem: true }),
  replace: false,
});
```

**Searching with native FTS:**
```typescript
// Pure FTS search (returns rows ranked by BM25)
const ftsRows = await table.search(query, 'fts', 'content').limit(limit).toArray();

// Vector search (existing — unchanged)
const vectorRows = await table.vectorSearch(queryVector).distanceType('cosine').limit(limit).toArray();
```

**Optimizing a table (makes new rows visible to FTS index):**
```typescript
await table.optimize();
```

**Key facts:**
- FTS index is NOT auto-updated after `table.add()`. New rows require `table.optimize()` to appear in FTS results.
- `createIndex` with `replace: false` is a no-op if the index already exists — safe to call on every startup.
- `table.optimize()` is incremental — it compacts delta files, not a full rebuild.
- The `InMemoryTable` fallback (used in tests / `inMemoryOnly` mode) does NOT support `createIndex` or `search(query, 'fts')` — keep the existing in-memory FTS code path for that case.

### Nathapp NestJS Patterns (MANDATORY)

- Use `@nestjs/schedule` for cron strategy — add as a dependency
- Strategy selection via factory provider in `RagModule` using `ConfigService`
- Config values from `rag.config.ts` via `registerAs('rag', ...)`
- All new classes must be `@Injectable()` and use `Logger` from `@nestjs/common`
- Return `JsonResponse.Ok(data)` from any new controller endpoints
- Unit tests with Jest — mock LanceDB table operations

### Existing Code Structure (DO NOT restructure)

```
apps/api/src/rag/
├── dto/
│   ├── add-document.dto.ts
│   ├── kb-result.dto.ts
│   └── search-kb.dto.ts
├── providers/
│   ├── ollama-embedding.provider.ts
│   └── openai-embedding.provider.ts
├── embedding.interface.ts
├── embedding.service.ts
├── embedding.service.spec.ts
├── rag.controller.ts
├── rag.module.ts
├── rag.service.ts
└── rag.service.spec.ts
```

---

## Requirements

### US-001 — FTS Optimize Strategy Interface & Implementations

Create the strategy interface and three implementations: `counter`, `cron`, and `manual`.

**Files to create:**
```
apps/api/src/rag/
├── strategies/
│   ├── fts-optimize-strategy.interface.ts    ← NEW — interface
│   ├── counter-optimize.strategy.ts          ← NEW — counter-based
│   ├── cron-optimize.strategy.ts             ← NEW — cron-based (@nestjs/schedule)
│   └── manual-optimize.strategy.ts           ← NEW — no-op auto-optimize
│   └── fts-optimize.strategy.spec.ts         ← NEW — unit tests for all 3
```

**Interface** (`fts-optimize-strategy.interface.ts`):
```typescript
export const FTS_OPTIMIZE_STRATEGY = 'FTS_OPTIMIZE_STRATEGY';

export interface FtsOptimizeStrategy {
  /** Called after every table.add() — strategy decides whether to optimize */
  onInsert(projectId: string, table: LanceTable): Promise<void>;

  /** Called on first table access per session — for lazy startup optimize */
  onFirstAccess(projectId: string, table: LanceTable): Promise<void>;

  /** Called on module destroy — cleanup timers/intervals */
  onDestroy(): Promise<void>;
}
```

Use `type LanceTable = any` to match the existing pattern in `rag.service.ts`.

**CounterOptimizeStrategy** (`counter-optimize.strategy.ts`):
```typescript
@Injectable()
export class CounterOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(CounterOptimizeStrategy.name);
  private readonly counters = new Map<string, number>();
  private readonly threshold: number;

  constructor(configService: ConfigService) {
    this.threshold = configService.get<number>('rag.ftsOptimizeThreshold') ?? 10;
  }

  async onInsert(projectId: string, table: LanceTable): Promise<void> {
    const count = (this.counters.get(projectId) ?? 0) + 1;
    this.counters.set(projectId, count);
    if (count >= this.threshold) {
      this.counters.set(projectId, 0);
      try {
        await table.optimize();
        this.logger.log(`FTS optimized (counter threshold ${this.threshold}): ${projectId}`);
      } catch (err) {
        this.logger.warn(`FTS optimize failed for ${projectId}: ${(err as Error).message}`);
      }
    }
  }

  async onFirstAccess(projectId: string, table: LanceTable): Promise<void> {
    // Fire-and-forget async optimize on first access
    table.optimize()
      .then(() => this.logger.log(`Startup FTS optimize done: ${projectId}`))
      .catch((err: Error) => this.logger.warn(`Startup FTS optimize failed: ${err.message}`));
  }

  async onDestroy(): Promise<void> { /* no-op */ }
}
```

**CronOptimizeStrategy** (`cron-optimize.strategy.ts`):
```typescript
import { SchedulerRegistry } from '@nestjs/schedule';

@Injectable()
export class CronOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(CronOptimizeStrategy.name);
  private readonly dirtyTables = new Map<string, LanceTable>();

  constructor(
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    const intervalMs = configService.get<number>('rag.ftsOptimizeIntervalMs') ?? 300_000;
    const interval = setInterval(() => {
      this.optimizeDirtyTables().catch((err) =>
        this.logger.warn(`Cron optimize cycle failed: ${(err as Error).message}`),
      );
    }, intervalMs);
    this.schedulerRegistry.addInterval('fts-optimize', interval);
    this.logger.log(`Cron FTS optimize registered (interval: ${intervalMs}ms)`);
  }

  private async optimizeDirtyTables(): Promise<void> {
    if (this.dirtyTables.size === 0) return;
    const snapshot = new Map(this.dirtyTables);
    this.dirtyTables.clear();
    for (const [projectId, table] of snapshot) {
      try {
        await table.optimize();
        this.logger.log(`Cron FTS optimized: ${projectId}`);
      } catch (err) {
        this.logger.warn(`Cron FTS optimize failed for ${projectId}: ${(err as Error).message}`);
      }
    }
  }

  async onInsert(projectId: string, table: LanceTable): Promise<void> {
    this.dirtyTables.set(projectId, table);
  }

  async onFirstAccess(projectId: string, table: LanceTable): Promise<void> {
    table.optimize()
      .then(() => this.logger.log(`Startup FTS optimize done: ${projectId}`))
      .catch((err: Error) => this.logger.warn(`Startup FTS optimize failed: ${err.message}`));
  }

  async onDestroy(): Promise<void> {
    // SchedulerRegistry manages interval lifecycle — just flush dirty tables
    await this.optimizeDirtyTables();
  }
}
```

**`@nestjs/schedule` usage:** The cron strategy uses `SchedulerRegistry.addInterval()` for dynamic runtime-configurable intervals. This gives us proper NestJS lifecycle management, debuggability via the registry, and no manual `clearInterval` needed. Do NOT use the `@Interval()` decorator — it requires a compile-time constant.

**ManualOptimizeStrategy** (`manual-optimize.strategy.ts`):
```typescript
@Injectable()
export class ManualOptimizeStrategy implements FtsOptimizeStrategy {
  private readonly logger = new Logger(ManualOptimizeStrategy.name);

  async onInsert(): Promise<void> { /* no-op — manual only */ }

  async onFirstAccess(projectId: string, table: LanceTable): Promise<void> {
    // Still do lazy startup optimize — user may not have triggered manual optimize recently
    table.optimize()
      .then(() => this.logger.log(`Startup FTS optimize done: ${projectId}`))
      .catch((err: Error) => this.logger.warn(`Startup FTS optimize failed: ${err.message}`));
  }

  async onDestroy(): Promise<void> { /* no-op */ }
}
```

**Unit tests** (`fts-optimize.strategy.spec.ts`):
- **CounterStrategy**: calls `table.optimize()` after threshold inserts; does NOT call before threshold; resets counter after optimize; handles optimize failure gracefully
- **CronStrategy**: marks table as dirty on insert; `optimizeDirtyTables()` calls optimize on all dirty tables and clears the map; registers interval via `SchedulerRegistry`; flushes dirty tables on destroy
- **ManualStrategy**: never calls optimize on insert; `onFirstAccess` still triggers async optimize

**Acceptance Criteria:**
- [ ] `FtsOptimizeStrategy` interface exported from `strategies/fts-optimize-strategy.interface.ts`
- [ ] All three strategy classes are `@Injectable()` and implement the interface
- [ ] CounterStrategy threshold is configurable via `ConfigService` (`rag.ftsOptimizeThreshold`)
- [ ] CronStrategy interval is configurable via `ConfigService` (`rag.ftsOptimizeIntervalMs`)
- [ ] CronStrategy cleans up interval in `onDestroy()`
- [ ] All strategies implement lazy `onFirstAccess` with fire-and-forget optimize
- [ ] Unit tests cover all strategies with mocked table.optimize()
- [ ] `bun run test` passes

---

### US-002 — Config & Module Wiring

Add FTS config options to `rag.config.ts`, create a factory provider for strategy selection in `RagModule`, and add `@nestjs/schedule` as a dependency.

**Files to modify:**
```
apps/api/src/config/rag.config.ts    ← MODIFY — add FTS optimize config
apps/api/src/rag/rag.module.ts       ← MODIFY — add strategy factory provider + ScheduleModule
package.json (root)                  ← MODIFY — add @nestjs/schedule
apps/api/package.json                ← MODIFY — add @nestjs/schedule
```

**Config additions** (`rag.config.ts` — add to the existing `registerAs` object):
```typescript
// FTS optimize strategy: 'counter' | 'cron' | 'manual'
ftsOptimizeStrategy: process.env['FTS_OPTIMIZE_STRATEGY'] ?? 'counter',
// Counter strategy: optimize after N inserts per project
ftsOptimizeThreshold: parseInt(process.env['FTS_OPTIMIZE_THRESHOLD'] ?? '10'),
// Cron strategy: optimize interval in milliseconds (default 5 min)
ftsOptimizeIntervalMs: parseInt(process.env['FTS_OPTIMIZE_INTERVAL_MS'] ?? '300000'),
```

**Module wiring** (`rag.module.ts`):
```typescript
import { ScheduleModule } from '@nestjs/schedule';
import { FTS_OPTIMIZE_STRATEGY } from './strategies/fts-optimize-strategy.interface';
import { CounterOptimizeStrategy } from './strategies/counter-optimize.strategy';
import { CronOptimizeStrategy } from './strategies/cron-optimize.strategy';
import { ManualOptimizeStrategy } from './strategies/manual-optimize.strategy';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [RagController],
  providers: [
    RagService,
    EmbeddingService,
    { provide: 'PrismaService', useExisting: PrismaService<PrismaClient> },
    CounterOptimizeStrategy,
    CronOptimizeStrategy,
    ManualOptimizeStrategy,
    {
      provide: FTS_OPTIMIZE_STRATEGY,
      useFactory: (
        config: ConfigService,
        counter: CounterOptimizeStrategy,
        cron: CronOptimizeStrategy,
        manual: ManualOptimizeStrategy,
      ) => {
        const strategy = config.get<string>('rag.ftsOptimizeStrategy') ?? 'counter';
        switch (strategy) {
          case 'cron': return cron;
          case 'manual': return manual;
          default: return counter;
        }
      },
      inject: [ConfigService, CounterOptimizeStrategy, CronOptimizeStrategy, ManualOptimizeStrategy],
    },
  ],
  exports: [RagService],
})
export class RagModule {}
```

**Dependency installation:**
```bash
cd apps/api && bun add @nestjs/schedule
```

**Acceptance Criteria:**
- [ ] `@nestjs/schedule` added to `apps/api/package.json` dependencies
- [ ] `rag.config.ts` exposes `ftsOptimizeStrategy`, `ftsOptimizeThreshold`, `ftsOptimizeIntervalMs`
- [ ] `FTS_OPTIMIZE_STRATEGY` injection token resolves correct strategy based on config
- [ ] Default strategy is `counter` when `FTS_OPTIMIZE_STRATEGY` env not set
- [ ] `ScheduleModule.forRoot()` imported in `RagModule`
- [ ] `bun run build` passes
- [ ] `bun run test` passes

---

### US-003 — Migrate RagService to Native FTS

Replace the in-memory FTS scan in `RagService.search()` with LanceDB native Tantivy FTS. Add FTS index creation in `getOrCreateTable()`. Integrate the optimize strategy from US-001.

**Files to modify:**
```
apps/api/src/rag/rag.service.ts       ← MODIFY — major changes
apps/api/src/rag/rag.service.spec.ts  ← MODIFY — update tests
```

**Changes to `rag.service.ts`:**

1. **Inject strategy** — add to constructor:
```typescript
import { FTS_OPTIMIZE_STRATEGY, FtsOptimizeStrategy } from './strategies/fts-optimize-strategy.interface';

constructor(
  private readonly configService: ConfigService,
  @Inject(FTS_OPTIMIZE_STRATEGY) private readonly optimizeStrategy: FtsOptimizeStrategy,
  @Optional() private readonly embeddingService?: EmbeddingService,
) { ... }
```

2. **Track first-access tables** — add field:
```typescript
private readonly firstAccessDone = new Set<string>();
```

3. **Create FTS index in `getOrCreateTable()`** — after table is opened/created, before returning:
```typescript
// Only for real LanceDB tables, not InMemoryTable
if (this.lanceAvailable) {
  try {
    const { Index } = await import('@lancedb/lancedb');
    await table.createIndex('content', {
      config: Index.fts({ baseTokenizer: 'simple', lowercase: true, stem: true }),
      replace: false,
    });
  } catch (err) {
    this.logger.warn(`FTS index creation skipped: ${(err as Error).message}`);
  }

  // Lazy startup optimize on first access
  if (!this.firstAccessDone.has(projectId)) {
    this.firstAccessDone.add(projectId);
    await this.optimizeStrategy.onFirstAccess(projectId, table);
  }
}
```

4. **Call strategy in `indexDocument()`** — after `table.add([record])`:
```typescript
if (this.lanceAvailable) {
  await this.optimizeStrategy.onInsert(projectId, table);
}
```

5. **Replace in-memory FTS scan in `search()`** — the current code does:
```typescript
// CURRENT (REMOVE):
const scanLimit = Math.min(rowCount, 500);
const allRows: LanceRecord[] = await table.query().limit(scanLimit).toArray();
const ftsRanked = allRows
  .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query) }))
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, fetchLimit);
```
Replace with:
```typescript
// NEW: Native Tantivy FTS (when LanceDB available)
let ftsRanked: { id: string; score: number }[] = [];
if (this.lanceAvailable) {
  try {
    const ftsRows: LanceRecord[] = await table
      .search(query, 'fts', 'content')
      .limit(fetchLimit)
      .toArray();
    ftsRanked = ftsRows.map((r, i) => ({
      id: r.id as string,
      score: 1 / (i + 1), // rank-based score for RRF compatibility
    }));
  } catch (err) {
    this.logger.warn(`Native FTS failed (${(err as Error).message}) — falling back to in-memory`);
    // Fallback to in-memory FTS for resilience
    const scanLimit = Math.min(rowCount, 500);
    const allRows: LanceRecord[] = await table.query().limit(scanLimit).toArray();
    ftsRanked = allRows
      .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, fetchLimit);
  }
} else {
  // InMemoryTable fallback — keep existing in-memory FTS
  const scanLimit = Math.min(rowCount, 500);
  const allRows: LanceRecord[] = await table.query().limit(scanLimit).toArray();
  ftsRanked = allRows
    .map((r) => ({ id: r.id as string, score: simpleFtsScore(r.content as string, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, fetchLimit);
}
```

Also update the `allRows` fetch used for the record lookup map — with native FTS we still need a way to resolve records by ID. Keep the existing `table.query().limit(scanLimit).toArray()` call for building `recordMap`, but also add FTS result rows to the map:
```typescript
ftsRows.forEach((r) => recordMap.set(r.id as string, r));
```

6. **Call strategy cleanup in `onModuleDestroy()`:**
```typescript
await this.optimizeStrategy.onDestroy();
```

7. **DO NOT remove `simpleFtsScore` or `reciprocalRankFusion`** — keep them as exports. `simpleFtsScore` is still used in the in-memory fallback path and in tests. `reciprocalRankFusion` is still used for RRF merge.

**Test updates** (`rag.service.spec.ts`):
- Existing `simpleFtsScore` and `reciprocalRankFusion` tests remain unchanged
- Add test: FTS index creation is attempted in `getOrCreateTable` when LanceDB is available
- Add test: `optimizeStrategy.onInsert()` is called after `indexDocument()`
- Add test: `optimizeStrategy.onFirstAccess()` is called on first table access only
- Add test: native FTS fallback to in-memory when `search()` throws
- Add test: in-memory FTS is used when `inMemoryOnly` is true

**Acceptance Criteria:**
- [ ] `search()` uses native `table.search(query, 'fts', 'content')` when LanceDB is available
- [ ] `search()` falls back to in-memory FTS (`simpleFtsScore`) on native FTS failure
- [ ] `search()` uses in-memory FTS when `inMemoryOnly` is true
- [ ] FTS index is created with `Index.fts()` in `getOrCreateTable()`
- [ ] `optimizeStrategy.onInsert()` called after every `indexDocument()`
- [ ] `optimizeStrategy.onFirstAccess()` called once per project per session
- [ ] `optimizeStrategy.onDestroy()` called in `onModuleDestroy()`
- [ ] `simpleFtsScore` and `reciprocalRankFusion` are NOT removed (still exported)
- [ ] `bun run test` passes
- [ ] `bun run type-check` passes
- [ ] `bun run lint` passes

---

### US-004 — Manual Optimize REST Endpoint

Add a `POST /api/projects/:slug/kb/optimize` endpoint for manual FTS optimization.

**Files to modify:**
```
apps/api/src/rag/rag.service.ts       ← MODIFY — add optimizeTable() public method
apps/api/src/rag/rag.controller.ts    ← MODIFY — add POST optimize endpoint
```

**RagService — add public method:**
```typescript
async optimizeTable(projectId: string): Promise<void> {
  const table = await this.getOrCreateTable(projectId);
  if (this.lanceAvailable) {
    await table.optimize();
    this.logger.log(`Manual FTS optimize completed: ${projectId}`);
  }
}
```

**RagController — add endpoint:**
```typescript
@Post('optimize')
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'Manually trigger FTS index optimization for the project KB' })
@ApiResponse({ status: 200, description: 'Optimization triggered' })
@ApiResponse({ status: 403, description: 'Forbidden - admin role required' })
@ApiResponse({ status: 404, description: 'Project not found' })
async optimizeKb(
  @Param('slug') slug: string,
  @Req() req: any,
) {
  if (req.user?.extra?.role !== 'ADMIN') throw new ForbiddenAppException();
  const project = await this.resolveProject(slug);
  await this.ragService.optimizeTable(project.id);
  return JsonResponse.Ok({ optimized: true });
}
```

**Unit tests:**
- `POST /api/projects/:slug/kb/optimize` returns 200 with `{ optimized: true }` for admin
- `POST /api/projects/:slug/kb/optimize` returns 403 for non-admin
- `POST /api/projects/:slug/kb/optimize` returns 404 for non-existent project

**Acceptance Criteria:**
- [ ] `POST /api/projects/:slug/kb/optimize` triggers `table.optimize()` for the project's LanceDB table
- [ ] Endpoint requires ADMIN role — returns 403 for non-admin users
- [ ] Returns 404 for non-existent project slug
- [ ] Returns `{ ret: 0, data: { optimized: true } }` on success
- [ ] Swagger documentation generated for the endpoint
- [ ] `bun run test` passes

---

## Dependency Order

```
US-001 (Strategy interface + implementations — no dependencies)
  └→ US-002 (Config + module wiring — depends on US-001 for strategy classes)
       └→ US-003 (RagService migration — depends on US-001 + US-002 for strategy injection)
            └→ US-004 (Manual optimize endpoint — depends on US-003 for optimizeTable method)
```

**All stories are sequential.** US-001 → US-002 → US-003 → US-004.

---

## Environment Variables

| Variable | Default | Description |
|:---------|:--------|:------------|
| `FTS_OPTIMIZE_STRATEGY` | `counter` | Strategy: `counter`, `cron`, or `manual` |
| `FTS_OPTIMIZE_THRESHOLD` | `10` | Counter strategy: optimize after N inserts per project |
| `FTS_OPTIMIZE_INTERVAL_MS` | `300000` | Cron strategy: optimize interval (default 5 min) |

---

## Files Summary

| File | Action | Story |
|:-----|:-------|:------|
| `src/rag/strategies/fts-optimize-strategy.interface.ts` | CREATE | US-001 |
| `src/rag/strategies/counter-optimize.strategy.ts` | CREATE | US-001 |
| `src/rag/strategies/cron-optimize.strategy.ts` | CREATE | US-001 |
| `src/rag/strategies/manual-optimize.strategy.ts` | CREATE | US-001 |
| `src/rag/strategies/fts-optimize.strategy.spec.ts` | CREATE | US-001 |
| `src/config/rag.config.ts` | MODIFY | US-002 |
| `src/rag/rag.module.ts` | MODIFY | US-002 |
| `package.json` (api) | MODIFY — add `@nestjs/schedule` | US-002 |
| `src/rag/rag.service.ts` | MODIFY — major | US-003 |
| `src/rag/rag.service.spec.ts` | MODIFY | US-003 |
| `src/rag/rag.controller.ts` | MODIFY | US-004 |

---

## Exit Criteria

- `bun run build` passes
- `bun run type-check` passes
- `bun run lint` passes
- `bun run test` passes
- Native FTS search returns results for indexed documents
- Counter strategy optimizes after threshold inserts
- Cron strategy optimizes dirty tables on interval
- Manual endpoint triggers optimize on demand
- In-memory fallback works when `RAG_IN_MEMORY_ONLY=true`
- Fallback to in-memory FTS when native FTS throws
