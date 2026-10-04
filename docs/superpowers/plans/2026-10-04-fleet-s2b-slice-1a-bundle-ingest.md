# Fleet S2b Slice 1a — Bundle Ingestion and Job Corrections (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every uploaded bundle of a terminal fleet job is parsed on the server into indefinitely kept cost, story and
review rows; while doing so the job's cost is raised to the ledger total, a finish escalation that `status.json`
missed is corrected to ESCALATED, and a COMPLETED run that pushed nothing says so. Admin routes list ingest health and
trigger backfill and re-runs. API only; query routes + CLI are slice 1b, the web is slice 2.

**Architecture:** A new `src/fleet/ingest/` module. `BundleService.upload` enqueues a `FleetBundleIngest` row in the
same transaction as the `FleetJobArtifact` row and kicks `BundleIngestService` after commit; a 30 s sweeper (gated by
the existing `FLEET_SWEEP_ENABLED`) catches anything the kick missed. The service claims one eligible row (job
terminal) with `FOR UPDATE SKIP LOCKED`, streams the bundle through a path-allowlisted, size-capped tar reader, runs
pure parsers and pure correction rules, and writes everything in one transaction (delete-then-insert per attempt).
Budgets are re-evaluated through `BudgetEvaluator.signal` after commit when cost rose.

**Tech Stack:** NestJS 11 + Fastify + Prisma 6 (PostgreSQL 16) + Jest + supertest; `tar-stream` 3 + `zlib`.

**Spec:** `docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md` §1, §2, §3, §4.3 (the three ingest
admin routes only), §6 (parser + ingest rows), §7 slice 1a. Rulings A2, A4, A5, A6, A7.

## Global Constraints

- New code lives under `apps/api/src/fleet/ingest/`; tests next to it (`*.spec.ts`) and under
  `apps/api/test/integration/fleet/` (`*.integration.spec.ts`).
- `INGEST_PARSER_VERSION = 1`. Ingest statuses: `pending | running | done | partial | failed`.
- Retry backoff after failure n (1-based): `[60_000, 300_000, 1_800_000, 7_200_000]` ms; the 5th failure is `failed`.
  A `running` claim older than `600_000` ms is re-claimable.
- Allowed bundle paths (after stripping a leading `./`): `nax-out/cost/*.jsonl`, `nax-out/metrics.json`,
  `nax-out/review-audit/*/*.json`, `nax-out/finish-audit/*/*.result.json`, `nax-out/finish-audit/*/last.json`,
  `nax-out/status.json`. Only `type === 'file'` entries. Names containing `..`, starting with `/`, or containing `\`
  are ignored.
- Caps: 32 MiB per file (`33_554_432`), 50,000 cost events, 2,000 story rows, 5,000 review rows per bundle. Strings:
  model/profile/stage/role/agent/tier/complexity/reviewer/pricingSource/confidence 120 chars, ids
  (callId/storyId/recordId/runId/featureName) 200 chars, escalation reason 2,000, error 500.
- Cost ledger `schemaVersion` accepted: `8`. Any other value: file `skipped:v<n>`, status `partial`.
- Money: per-row `Decimal(14,8)`; `FleetJob.costSpentUsd` stays `Decimal(12,4)`, written as
  `Prisma.Decimal(x).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)` (A7). Sum before rounding, never after.
- Ingest never changes a job's state except COMPLETED -> ESCALATED (§3.2), and never lowers `costSpentUsd`.
- Admin routes use the house convention `fleet/...` + `@RequiredPermission('ADMIN')` (D370), not `/admin/fleet`.
- **`apps/api` compiles with `strictNullChecks: false`**: discriminate unions with a string literal `kind` field
  compared with `===`, as the snippets do; a boolean discriminant does not narrow.
- API tests: `cd apps/api && bun run test:scoped <paths>`; integration specs need `bun run test:db:up` first and run
  with `KODA_DB_TESTS=1` (test:scoped sets it for `test/integration`). Never bare `bun test` at the repo root.
- Integration files that log in over HTTP hit the 5/min login throttle; a whole file failing in under a millisecond
  with only a `loginToken` frame is the throttle: wait a minute and rerun that file alone.
- `bun run generate` (repo root) needs `apps/api/.env`; commit `openapi.json` and the regenerated CLI client.
- No emojis in source; no `console.log` in `src`; build new objects, never mutate inputs.
- Every snippet names real files and helpers. If a name in a snippet does not exist in the code, that is a plan
  defect: stop and report it.

## Decisions

Numbered from D365 (S2a slice 2 ended at D364).

| # | Decision | Why |
|:--|:--|:--|
| D365 | **Spec correction (§2.3):** row validation uses small hand-written validators in `src/fleet/ingest/parsers/fields.ts`, not zod. | `apps/api` has no zod dependency; the shapes are flat and a handful of typed readers is less than a new dependency (YAGNI). |
| D366 | The nax run id of a bundle is `status.json` `run.id` from that bundle; when absent, `job.naxRunId` if the bundle is the job's latest attempt, else null. `metrics.json` picks the run with that id, else its only run; finish files are `<runId>.result.json`, and `last.json` counts only when its `runId` equals it. | Each attempt of a requeued job has its own nax run; `job.naxRunId` only names the latest. |
| D367 | Corrections (§3.1-3.3) apply only when the bundle's `leaseEpoch` equals the job's current `leaseEpoch`. Earlier attempts only get analytics rows and their own `liveCostUsd = null`, `ledgerCostUsd`. | The job row describes the latest attempt; spec §3.1 already limits cost to it. |
| D368 | The ingest sweeper reuses `fleetConfig.sweepEnabled` (`FLEET_SWEEP_ENABLED`, default on outside tests) and a `setInterval` in `onModuleInit`, like `FleetSweeper`. Tests drive `BundleIngestService.drain(now)` directly. | One switch for all fleet background loops; no new env var. |
| D369 | `BundleIngestService.kick()` chains `drain()` on a private promise (the `LogFallbackService.schedule` pattern); `idle()` resolves when it settles. `drain(now)` ingests until `claimNext` returns null or 50 rows, whichever first. | Off the request path; bounded work per tick. |
| D370 | **Spec correction (§2.6, §4.3):** admin ingest routes are `GET /fleet/ingest`, `POST /fleet/ingest/backfill`, `POST /fleet/ingest/jobs/:jobId/rerun`, `POST /fleet/ingest/rerun-outdated`, all `@RequiredPermission('ADMIN')`. Slice 1b's admin analytics routes follow the same `fleet/analytics` convention. | Every existing admin fleet route is `fleet/<x>` + `RequiredPermission('ADMIN')` (`runners.controller.ts`); `rerun?all=true` next to `:jobId/rerun` was ambiguous. |
| D371 | `FleetActivity.entityType` gains `'ingest'` (backfill / rerun-outdated use `entityId: 'all'`; per-job rerun uses `'job'`). The correction writes action `job.verdict_corrected` (entity `job`, actor SYSTEM/`system`). | The column is a string; the TS union documents the new value. |
| D372 | Context columns (`projectId`, `repoId`, `runnerId`) on analytics rows are plain indexed strings, not foreign keys; rows cascade only with `FleetJob`. | Analytics must not block deleting a project's repos or runners; the job FK already scopes lifetime. |
| D373 | `FleetBundleIngest` references `FleetJobArtifact` with `onDelete: Cascade`. Retention only sets `expiredAt` on artifacts, so ingest rows survive it. | One ingest row per artifact (spec §1.1); deleting a job removes both. |
| D374 | Finding severity buckets are the `severity` string of each `result.findings[]` item (lowercased, 40 chars), `"unknown"` when missing; `advisoryCount` = length of `advisoryFindings` when it is an array, else 0. | nax `FindingSeverity` is `critical \| error \| warning \| info \| low`; keep whatever comes. |
| D375 | `escalationReason` written by ingest is the finish `escalationReason` cut to 2,000 chars; `resultPrUrl` must start with `https://` or it is ignored. | Untrusted input reaches the job page as a link. |

## Review Focus

1. **A bundle uploaded twice for the same attempt** (runner retry after a lost response): the second upload must reset
   the same ingest row to `pending`, and the re-ingest must leave exactly one copy of each row. Pinned in Task 7.
2. **A job requeued after its first attempt uploaded a bundle**: ingesting attempt 1 after attempt 2 started must not
   touch the job's cost or state (D367). Pinned in Task 6.
3. **A hostile bundle** (path traversal, symlink named like `nax-out/metrics.json`, a 33 MiB `metrics.json`, `NaN`
   costs): ignored or `partial`, never a crash or a write outside the rows. Pinned in Tasks 2 and 3.
4. **An ingest that throws halfway through the write transaction**: nothing from that bundle is visible, the row goes
   back to `pending` with a backoff. Pinned in Task 6.
5. **The API restarting while a row is `running`**: the row is re-claimed after 10 minutes, not stuck. Pinned in
   Task 5.

---

## File Structure

Create:

- `apps/api/prisma/migrations/20261005090000_fleet_bundle_ingest/migration.sql` — the four tables.
- `apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts` — constants, row types, repository interface.
- `apps/api/src/fleet/ingest/bundle-reader.ts` — allowlisted, capped tar reader -> `BundleFiles`.
- `apps/api/src/fleet/ingest/parsers/fields.ts` — typed field readers (D365).
- `apps/api/src/fleet/ingest/parsers/cost-ledger.parser.ts`
- `apps/api/src/fleet/ingest/parsers/metrics.parser.ts`
- `apps/api/src/fleet/ingest/parsers/review-audit.parser.ts`
- `apps/api/src/fleet/ingest/parsers/finish.parser.ts` — finish result + last.json + status.json run id/status.
- `apps/api/src/fleet/ingest/parse-bundle.ts` — composes the parsers into `ParsedBundle`.
- `apps/api/src/fleet/ingest/ingest-corrections.ts` — pure §3 rules.
- `apps/api/src/fleet/ingest/prisma-bundle-ingest.repository.ts`
- `apps/api/src/fleet/ingest/bundle-ingest.service.ts` — claim, read, parse, write, publish, retry.
- `apps/api/src/fleet/ingest/bundle-ingest.sweeper.ts`
- `apps/api/src/fleet/ingest/fleet-ingest.controller.ts` + `dto/ingest-row.dto.ts`, `dto/list-ingest.query.ts`
- `apps/api/src/fleet/ingest/ingest.module.ts`
- Unit specs next to each src file; integration specs `test/integration/fleet/fleet-ingest-schema.integration.spec.ts`,
  `fleet-ingest-repository.integration.spec.ts`, `fleet-ingest.integration.spec.ts`, `fleet-ingest-api.integration.spec.ts`.

Modify:

- `apps/api/prisma/schema.prisma` — models + back-relations.
- `apps/api/src/fleet/artifacts/bundle.service.ts` — enqueue in the upload transaction, kick after commit.
- `apps/api/src/fleet/artifacts/artifacts.module.ts` — import `IngestModule`.
- `apps/api/src/fleet/fleet.module.ts` — import `IngestModule`.
- `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` — `'ingest'` entity type (D371).
- `apps/api/src/fleet/artifacts/bundle.service.spec.ts` — constructor arity.
- `docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md` — D365 and D370 corrections.
- `.nax/mono/apps/api/context.md` (+ `nax generate`) — the ingest module in one paragraph.
- `openapi.json`, `apps/cli/src/generated/*` — via `bun run generate`.

---

### Task 1: Schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (after `model FleetJobLog`, and the `FleetJob` / `FleetJobArtifact` relation lists)
- Create: `apps/api/prisma/migrations/20261005090000_fleet_bundle_ingest/migration.sql`
- Test: `apps/api/test/integration/fleet/fleet-ingest-schema.integration.spec.ts`

**Interfaces:**
- Produces: Prisma models `FleetBundleIngest`, `FleetCostEvent`, `FleetStoryResult`, `FleetReviewResult`
  (client accessors `fleetBundleIngest`, `fleetCostEvent`, `fleetStoryResult`, `fleetReviewResult`); compound unique
  names `jobId_leaseEpoch_callId`, `jobId_leaseEpoch_storyId`, `jobId_leaseEpoch_recordId`.

- [ ] **Step 1: Write the failing schema test**

```ts
/**
 * Fleet S2b slice 1a — ingest tables (PG), spec §1.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet ingest schema (PG)', () => {
  const prisma = new PrismaClient();
  let jobId: string;
  let artifactId: string;
  let projectId: string;
  let repoId: string;

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repo = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: project.id, repoId: repo.id, ref: 'main', command: 'RUN', feature: 'f', profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: user.id, state: 'COMPLETED',
      },
    });
    const artifact = await prisma.fleetJobArtifact.create({
      data: { jobId: job.id, leaseEpoch: 1, kind: 'bundle', storageKey: 'jobs/x/1/a.tar.gz', sizeBytes: BigInt(3), sha256: 'a'.repeat(64) },
    });
    jobId = job.id;
    artifactId = artifact.id;
    projectId = project.id;
    repoId = repo.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const cost = (callId: string) => ({
    jobId, leaseEpoch: 1, projectId, repoId, runnerId: null, naxRunId: 'run-1', at: new Date(0), agentName: 'native',
    model: 'm', modelTier: null, profile: null, stage: 'run', sessionRole: 'implementer', featureName: 'f', storyId: 'US-001',
    callId, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: new Prisma.Decimal('0.00157927'),
    pricingSource: null, confidence: null, durationMs: null,
  });

  it('keeps 8 decimal places on a cost event and rejects a duplicate call id per attempt', async () => {
    await prisma.fleetCostEvent.create({ data: cost('c1') });
    const row = await prisma.fleetCostEvent.findUniqueOrThrow({ where: { jobId_leaseEpoch_callId: { jobId, leaseEpoch: 1, callId: 'c1' } } });
    expect(row.costUsd.toString()).toBe('0.00157927');
    await expect(prisma.fleetCostEvent.create({ data: cost('c1') })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows one ingest row per artifact with defaults', async () => {
    const row = await prisma.fleetBundleIngest.create({ data: { artifactId, jobId, leaseEpoch: 1, parserVersion: 1 } });
    expect(row).toMatchObject({ status: 'pending', attempts: 0, files: {}, nextAttemptAt: null, claimedAt: null });
    await expect(prisma.fleetBundleIngest.create({ data: { artifactId, jobId, leaseEpoch: 1, parserVersion: 1 } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascades every ingest table with the job', async () => {
    await prisma.fleetStoryResult.create({
      data: {
        jobId, leaseEpoch: 1, projectId, repoId, featureName: 'f', storyId: 'US-001', attempts: 1, success: true, firstPassSuccess: true,
        costUsd: new Prisma.Decimal('0.1'), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    });
    await prisma.fleetReviewResult.create({
      data: { jobId, leaseEpoch: 1, projectId, storyId: 'US-001', reviewer: 'semantic', recordId: 'r1', passed: true, failOpen: false, findingCount: 0, findingsBySeverity: {}, advisoryCount: 0, at: new Date(0) },
    });
    await prisma.fleetJob.delete({ where: { id: jobId } });
    expect(await prisma.fleetCostEvent.count()).toBe(0);
    expect(await prisma.fleetStoryResult.count()).toBe(0);
    expect(await prisma.fleetReviewResult.count()).toBe(0);
    expect(await prisma.fleetBundleIngest.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-ingest-schema.integration.spec.ts`
Expected: FAIL — TypeScript errors: `Property 'fleetCostEvent' does not exist on type 'PrismaClient'`.

- [ ] **Step 3: Add the models to `schema.prisma`**

Add to `model FleetJob`'s relation list (next to `logs FleetJobLog[]`, line ~813):

```prisma
  ingests       FleetBundleIngest[]
  costEvents    FleetCostEvent[]
  storyResults  FleetStoryResult[]
  reviewResults FleetReviewResult[]
```

Add to `model FleetJobArtifact` (after the `job` relation):

```prisma
  ingest FleetBundleIngest?
```

Append after `model FleetJobLog { ... }`:

```prisma
/// Fleet S2b (d) §1.1: one row per bundle artifact; the ingest queue and its outcome.
model FleetBundleIngest {
  id            String    @id @default(cuid())
  artifactId    String    @unique
  jobId         String
  leaseEpoch    Int
  status        String    @default("pending") // pending | running | done | partial | failed
  parserVersion Int
  attempts      Int       @default(0)
  nextAttemptAt DateTime?
  claimedAt     DateTime?
  files         Json      @default("{}")
  liveCostUsd   Decimal?  @db.Decimal(14, 8)
  ledgerCostUsd Decimal?  @db.Decimal(14, 8)
  error         String?
  ingestedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  artifact FleetJobArtifact @relation(fields: [artifactId], references: [id], onDelete: Cascade)
  job      FleetJob         @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@index([status, nextAttemptAt])
  @@index([jobId])
}

/// Fleet S2b (d) §1.2: one row per nax cost-ledger line. Kept forever (A4).
model FleetCostEvent {
  id               String   @id @default(cuid())
  jobId            String
  leaseEpoch       Int
  projectId        String
  repoId           String
  runnerId         String?
  naxRunId         String?
  at               DateTime
  agentName        String
  model            String
  modelTier        String?
  profile          String?
  stage            String
  sessionRole      String?
  featureName      String
  storyId          String?
  callId           String
  inputTokens      Int
  outputTokens     Int
  cacheReadTokens  Int
  cacheWriteTokens Int
  costUsd          Decimal  @db.Decimal(14, 8)
  pricingSource    String?
  confidence       String?
  durationMs       Int?

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, leaseEpoch, callId])
  @@index([projectId, at])
  @@index([repoId, at])
  @@index([runnerId, at])
  @@index([model, at])
}

/// Fleet S2b (d) §1.3: one row per story per attempt, from metrics.json.
model FleetStoryResult {
  id                String    @id @default(cuid())
  jobId             String
  leaseEpoch        Int
  projectId         String
  repoId            String
  featureName       String
  storyId           String
  complexity        String?
  initialComplexity String?
  modelTier         String?
  finalTier         String?
  modelUsed         String?
  agentUsed         String?
  attempts          Int
  success           Boolean
  firstPassSuccess  Boolean
  costUsd           Decimal   @db.Decimal(14, 8)
  durationMs        Int?
  inputTokens       Int
  outputTokens      Int
  cacheReadTokens   Int
  cacheWriteTokens  Int
  startedAt         DateTime?
  completedAt       DateTime?

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, leaseEpoch, storyId])
  @@index([projectId, completedAt])
}

/// Fleet S2b (d) §1.4: one row per review-audit record.
model FleetReviewResult {
  id                 String   @id @default(cuid())
  jobId              String
  leaseEpoch         Int
  projectId          String
  storyId            String?
  reviewer           String
  recordId           String
  passed             Boolean
  failOpen           Boolean
  findingCount       Int
  findingsBySeverity Json
  advisoryCount      Int
  at                 DateTime

  job FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, leaseEpoch, recordId])
  @@index([projectId, at])
}
```

- [ ] **Step 4: Write the migration**

`apps/api/prisma/migrations/20261005090000_fleet_bundle_ingest/migration.sql`:

```sql
-- Fleet S2b (d) slice 1a: bundle ingest queue and analytics rows (spec §1).
CREATE TABLE "FleetBundleIngest" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "parserVersion" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "files" JSONB NOT NULL DEFAULT '{}',
    "liveCostUsd" DECIMAL(14,8),
    "ledgerCostUsd" DECIMAL(14,8),
    "error" TEXT,
    "ingestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetBundleIngest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetBundleIngest_artifactId_key" ON "FleetBundleIngest"("artifactId");
CREATE INDEX "FleetBundleIngest_status_nextAttemptAt_idx" ON "FleetBundleIngest"("status", "nextAttemptAt");
CREATE INDEX "FleetBundleIngest_jobId_idx" ON "FleetBundleIngest"("jobId");
ALTER TABLE "FleetBundleIngest" ADD CONSTRAINT "FleetBundleIngest_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "FleetJobArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetBundleIngest" ADD CONSTRAINT "FleetBundleIngest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FleetCostEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "runnerId" TEXT,
    "naxRunId" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "agentName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelTier" TEXT,
    "profile" TEXT,
    "stage" TEXT NOT NULL,
    "sessionRole" TEXT,
    "featureName" TEXT NOT NULL,
    "storyId" TEXT,
    "callId" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "costUsd" DECIMAL(14,8) NOT NULL,
    "pricingSource" TEXT,
    "confidence" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "FleetCostEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetCostEvent_jobId_leaseEpoch_callId_key" ON "FleetCostEvent"("jobId", "leaseEpoch", "callId");
CREATE INDEX "FleetCostEvent_projectId_at_idx" ON "FleetCostEvent"("projectId", "at");
CREATE INDEX "FleetCostEvent_repoId_at_idx" ON "FleetCostEvent"("repoId", "at");
CREATE INDEX "FleetCostEvent_runnerId_at_idx" ON "FleetCostEvent"("runnerId", "at");
CREATE INDEX "FleetCostEvent_model_at_idx" ON "FleetCostEvent"("model", "at");
ALTER TABLE "FleetCostEvent" ADD CONSTRAINT "FleetCostEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FleetStoryResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "featureName" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "complexity" TEXT,
    "initialComplexity" TEXT,
    "modelTier" TEXT,
    "finalTier" TEXT,
    "modelUsed" TEXT,
    "agentUsed" TEXT,
    "attempts" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "firstPassSuccess" BOOLEAN NOT NULL,
    "costUsd" DECIMAL(14,8) NOT NULL,
    "durationMs" INTEGER,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FleetStoryResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetStoryResult_jobId_leaseEpoch_storyId_key" ON "FleetStoryResult"("jobId", "leaseEpoch", "storyId");
CREATE INDEX "FleetStoryResult_projectId_completedAt_idx" ON "FleetStoryResult"("projectId", "completedAt");
ALTER TABLE "FleetStoryResult" ADD CONSTRAINT "FleetStoryResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FleetReviewResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyId" TEXT,
    "reviewer" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "failOpen" BOOLEAN NOT NULL,
    "findingCount" INTEGER NOT NULL,
    "findingsBySeverity" JSONB NOT NULL,
    "advisoryCount" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetReviewResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FleetReviewResult_jobId_leaseEpoch_recordId_key" ON "FleetReviewResult"("jobId", "leaseEpoch", "recordId");
CREATE INDEX "FleetReviewResult_projectId_at_idx" ON "FleetReviewResult"("projectId", "at");
ALTER TABLE "FleetReviewResult" ADD CONSTRAINT "FleetReviewResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Regenerate the client and check the SQL matches the schema**

The integration globalSetup uses `prisma db push`, so this diff is the only check that the SQL itself is right; never
use `koda_test` as the shadow database:

```bash
cd apps/api
bunx prisma generate
docker compose -f ../../docker-compose.test.yml exec -T postgres-test psql -U koda -d postgres -c 'CREATE DATABASE koda_shadow_test'
DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_shadow_test bunx prisma migrate diff \
  --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://koda:koda@localhost:5433/koda_shadow_test --exit-code
docker compose -f ../../docker-compose.test.yml exec -T postgres-test psql -U koda -d postgres -c 'DROP DATABASE koda_shadow_test'
```

Expected: exit 0, "No difference detected". Any reported difference is a migration defect: fix the SQL, not the schema.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-schema.integration.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20261005090000_fleet_bundle_ingest apps/api/test/integration/fleet/fleet-ingest-schema.integration.spec.ts
git commit -m "feat(fleet): S2b ingest tables (D372, D373)"
```

---

### Task 2: Domain types and the bundle reader

**Files:**
- Create: `apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts`
- Create: `apps/api/src/fleet/ingest/bundle-reader.ts`
- Test: `apps/api/src/fleet/ingest/bundle-reader.spec.ts`

**Interfaces:**
- Produces (domain): constants `BUNDLE_INGEST_REPOSITORY`, `INGEST_PARSER_VERSION`, `INGEST_MAX_ATTEMPTS`,
  `INGEST_BACKOFF_MS`, `INGEST_STALE_CLAIM_MS`, `INGEST_DRAIN_LIMIT`, `INGEST_LIMITS`; types `IngestStatus`,
  `IngestClaim`, `IngestArtifact`, `CostEventRow`, `StoryResultRow`, `ReviewResultRow`, `IngestContext`, `IngestRows`,
  `IngestOutcome`, `IngestListRow`, `IBundleIngestRepository` (exact text below).
- Produces (reader): `readBundleFiles(bundle: Readable): Promise<BundleFiles>` with

```ts
export interface BundleFile { name: string; text: string }
export interface BundleFiles {
  cost: BundleFile[];          // nax-out/cost/*.jsonl
  metrics: BundleFile | null;  // nax-out/metrics.json
  reviews: BundleFile[];       // nax-out/review-audit/*/*.json
  finishResults: BundleFile[]; // nax-out/finish-audit/*/*.result.json
  finishLast: BundleFile[];    // nax-out/finish-audit/*/last.json
  status: BundleFile | null;   // nax-out/status.json
  oversized: string[];         // allowed names skipped for exceeding INGEST_LIMITS.fileBytes
}
```

- [ ] **Step 1: Write the domain file** (types only; exercised by later tests)

`apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts`:

```ts
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';

export const BUNDLE_INGEST_REPOSITORY = Symbol('BUNDLE_INGEST_REPOSITORY');

/** Bump when a parser changes what it writes; `rerun-outdated` re-ingests older rows (spec §2.6). */
export const INGEST_PARSER_VERSION = 1;
export const INGEST_MAX_ATTEMPTS = 5;
/** Delay after failure n (1-based), spec §2.5. */
export const INGEST_BACKOFF_MS: readonly number[] = [60_000, 300_000, 1_800_000, 7_200_000];
export const INGEST_STALE_CLAIM_MS = 600_000;
/** Rows one drain pass ingests at most (D369). */
export const INGEST_DRAIN_LIMIT = 50;

export const INGEST_LIMITS = {
  fileBytes: 33_554_432,
  costEvents: 50_000,
  stories: 2_000,
  reviews: 5_000,
  shortText: 120,
  idText: 200,
  reasonText: 2_000,
  errorText: 500,
} as const;

export type IngestStatus = 'pending' | 'running' | 'done' | 'partial' | 'failed';
export const INGEST_STATUSES: readonly IngestStatus[] = ['pending', 'running', 'done', 'partial', 'failed'];

export interface IngestClaim {
  id: string;
  artifactId: string;
  jobId: string;
  leaseEpoch: number;
  attempts: number;
}

export interface IngestArtifact {
  storageKey: string;
  expiredAt: Date | null;
}

export interface CostEventRow {
  at: Date;
  agentName: string;
  model: string;
  modelTier: string | null;
  profile: string | null;
  stage: string;
  sessionRole: string | null;
  featureName: string;
  storyId: string | null;
  callId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Decimal string, up to 8 places. */
  costUsd: string;
  pricingSource: string | null;
  confidence: string | null;
  durationMs: number | null;
}

export interface StoryResultRow {
  featureName: string;
  storyId: string;
  complexity: string | null;
  initialComplexity: string | null;
  modelTier: string | null;
  finalTier: string | null;
  modelUsed: string | null;
  agentUsed: string | null;
  attempts: number;
  success: boolean;
  firstPassSuccess: boolean;
  costUsd: string;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ReviewResultRow {
  storyId: string | null;
  reviewer: string;
  recordId: string;
  passed: boolean;
  failOpen: boolean;
  findingCount: number;
  findingsBySeverity: Record<string, number>;
  advisoryCount: number;
  at: Date;
}

/** Copied onto every analytics row (D372). */
export interface IngestContext {
  jobId: string;
  leaseEpoch: number;
  projectId: string;
  repoId: string;
  runnerId: string | null;
  naxRunId: string | null;
}

export interface IngestRows {
  costEvents: readonly CostEventRow[];
  stories: readonly StoryResultRow[];
  reviews: readonly ReviewResultRow[];
}

export interface IngestOutcome {
  kind: 'done' | 'partial';
  files: Record<string, string>;
  liveCostUsd: string | null;
  ledgerCostUsd: string;
  ingestedAt: Date;
}

export interface IngestListRow {
  id: string;
  jobId: string;
  leaseEpoch: number;
  projectId: string;
  status: IngestStatus;
  attempts: number;
  parserVersion: number;
  files: Record<string, string>;
  error: string | null;
  ingestedAt: Date | null;
  updatedAt: Date;
}

export interface IBundleIngestRepository {
  /** Insert or reset to pending the ingest row of an artifact (spec §2.1). Call inside the upload transaction. */
  enqueue(artifactId: string, jobId: string, leaseEpoch: number, parserVersion: number): Promise<void>;
  /** One eligible row (job terminal; pending and due, or a stale running claim), claimed as running (spec §2.2). */
  claimNext(now: Date): Promise<IngestClaim | null>;
  findArtifact(artifactId: string): Promise<IngestArtifact | null>;
  /** Delete then insert this attempt's analytics rows (spec §2.4). Call inside the write transaction. */
  replaceRows(ctx: IngestContext, rows: IngestRows): Promise<void>;
  markOutcome(id: string, outcome: IngestOutcome): Promise<void>;
  markRetry(id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  markFailed(id: string, attempts: number, error: string): Promise<void>;
  /** Pending rows for every unexpired bundle artifact without one; returns how many (spec §2.6). */
  backfill(parserVersion: number): Promise<number>;
  /** Reset every ingest row of a job to pending with attempts 0; returns how many. */
  rerunJob(jobId: string): Promise<number>;
  /** Reset done/partial/failed rows below `parserVersion` whose artifact is unexpired; returns how many. */
  rerunOutdated(parserVersion: number): Promise<number>;
  findPage(filters: { status?: IngestStatus }, page: IPageOption): Promise<IPageResult<IngestListRow>>;
}
```

- [ ] **Step 2: Write the failing reader test**

`apps/api/src/fleet/ingest/bundle-reader.spec.ts`:

```ts
import { Readable } from 'stream';
import { tarGz } from '../../../test/helpers/tar-gz';
import { readBundleFiles } from './bundle-reader';

const stream = (b: Buffer) => Readable.from([b]);

describe('readBundleFiles (spec §2.3)', () => {
  it('collects only allowlisted paths, normalising a leading ./', async () => {
    const gz = await tarGz([
      { name: './nax-out/cost/a.jsonl', body: '{"x":1}\n' },
      { name: 'nax-out/cost/b.jsonl', body: '{"x":2}\n' },
      { name: 'nax-out/metrics.json', body: '[]' },
      { name: 'nax-out/review-audit/f/1-r.json', body: '{}' },
      { name: 'nax-out/finish-audit/f/run-1.result.json', body: '{}' },
      { name: 'nax-out/finish-audit/f/last.json', body: '{}' },
      { name: 'nax-out/finish-audit/f/run-1.jsonl', body: 'ignored' },
      { name: 'nax-out/status.json', body: '{}' },
      { name: 'nax-out/tool-audit/f/x.json', body: 'ignored' },
      { name: 'nax.stdout', body: 'ignored' },
    ]);
    const files = await readBundleFiles(stream(gz));
    expect(files.cost.map((f) => f.name).sort()).toEqual(['nax-out/cost/a.jsonl', 'nax-out/cost/b.jsonl']);
    expect(files.metrics).toEqual({ name: 'nax-out/metrics.json', text: '[]' });
    expect(files.reviews.map((f) => f.name)).toEqual(['nax-out/review-audit/f/1-r.json']);
    expect(files.finishResults.map((f) => f.name)).toEqual(['nax-out/finish-audit/f/run-1.result.json']);
    expect(files.finishLast.map((f) => f.name)).toEqual(['nax-out/finish-audit/f/last.json']);
    expect(files.status?.text).toBe('{}');
    expect(files.oversized).toEqual([]);
  });

  it('ignores traversal, absolute, backslash and symlink entries (Review Focus 3)', async () => {
    const gz = await tarGz([
      { name: 'nax-out/cost/../../etc/passwd.jsonl', body: 'x' },
      { name: '/nax-out/metrics.json', body: '[1]' },
      { name: 'nax-out\\metrics.json', body: '[2]' },
      { name: 'nax-out/metrics.json', type: 'symlink', linkname: '/etc/passwd' },
    ]);
    const files = await readBundleFiles(stream(gz));
    expect(files.cost).toEqual([]);
    expect(files.metrics).toBeNull();
  });

  it('skips an allowed file larger than the cap without reading it into memory (Review Focus 3)', async () => {
    const big = Buffer.alloc(33_554_433, 0x61);
    const gz = await tarGz([{ name: 'nax-out/metrics.json', body: big }, { name: 'nax-out/status.json', body: '{}' }]);
    const files = await readBundleFiles(stream(gz));
    expect(files.metrics).toBeNull();
    expect(files.oversized).toEqual(['nax-out/metrics.json']);
    expect(files.status?.text).toBe('{}');
  });

  it('rejects a corrupt gzip', async () => {
    await expect(readBundleFiles(stream(Buffer.from('not gzip')))).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/ingest/bundle-reader.spec.ts`
Expected: FAIL — `Cannot find module './bundle-reader'`.

- [ ] **Step 4: Implement the reader**

`apps/api/src/fleet/ingest/bundle-reader.ts`:

```ts
import type { Readable } from 'stream';
import { extract } from 'tar-stream';
import { createGunzip } from 'zlib';
import { INGEST_LIMITS } from './domain/bundle-ingest.domain';

export interface BundleFile {
  name: string;
  text: string;
}

export interface BundleFiles {
  cost: BundleFile[];
  metrics: BundleFile | null;
  reviews: BundleFile[];
  finishResults: BundleFile[];
  finishLast: BundleFile[];
  status: BundleFile | null;
  oversized: string[];
}

type Slot = 'cost' | 'metrics' | 'reviews' | 'finishResults' | 'finishLast' | 'status';

const SLOTS: ReadonlyArray<[RegExp, Slot]> = [
  [/^nax-out\/cost\/[^/]+\.jsonl$/, 'cost'],
  [/^nax-out\/metrics\.json$/, 'metrics'],
  [/^nax-out\/review-audit\/[^/]+\/[^/]+\.json$/, 'reviews'],
  [/^nax-out\/finish-audit\/[^/]+\/[^/]+\.result\.json$/, 'finishResults'],
  [/^nax-out\/finish-audit\/[^/]+\/last\.json$/, 'finishLast'],
  [/^nax-out\/status\.json$/, 'status'],
];

/** Spec §2.3: the allowlisted slot of a tar entry name, or null for anything else (including unsafe names). */
export function slotOf(rawName: string): Slot | null {
  const name = rawName.replace(/^\.\//, '');
  if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) return null;
  const hit = SLOTS.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

function readEntry(entry: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    entry.on('data', (c: Buffer) => chunks.push(c));
    entry.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    entry.on('error', reject);
  });
}

/**
 * Streams the bundle once; keeps the text of allowlisted regular files up to INGEST_LIMITS.fileBytes.
 * tar-stream 3 entries are streamx streams: advance on `close`, after the entry was consumed (see
 * src/fleet/logs/bundle-log-extractor.ts for the same rule).
 */
export function readBundleFiles(bundle: Readable): Promise<BundleFiles> {
  return new Promise((resolve, reject) => {
    const acc = { cost: [] as BundleFile[], metrics: null as BundleFile | null, reviews: [] as BundleFile[], finishResults: [] as BundleFile[], finishLast: [] as BundleFile[], status: null as BundleFile | null, oversized: [] as string[] };
    const x = extract();
    const fail = (error: Error) => {
      bundle.destroy();
      reject(error);
    };
    x.on('entry', (header, entry, next) => {
      const body = entry as unknown as Readable;
      body.once('close', () => next());
      const slot = header.type === 'file' ? slotOf(header.name) : null;
      const name = header.name.replace(/^\.\//, '');
      if (!slot) {
        body.resume();
        return;
      }
      if ((header.size ?? 0) > INGEST_LIMITS.fileBytes) {
        acc.oversized = [...acc.oversized, name];
        body.resume();
        return;
      }
      readEntry(body).then((text) => {
        const file = { name, text };
        if (slot === 'metrics') acc.metrics = file;
        else if (slot === 'status') acc.status = file;
        else acc[slot] = [...acc[slot], file];
      }, (error: unknown) => x.destroy(error as Error));
    });
    x.on('finish', () => resolve(acc));
    x.on('error', fail);
    const gunzip = createGunzip();
    gunzip.on('error', fail);
    bundle.on('error', fail);
    bundle.pipe(gunzip).pipe(x as unknown as NodeJS.WritableStream);
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/ingest/bundle-reader.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/ingest/domain/bundle-ingest.domain.ts apps/api/src/fleet/ingest/bundle-reader.ts apps/api/src/fleet/ingest/bundle-reader.spec.ts
git commit -m "feat(fleet): S2b ingest domain and allowlisted bundle reader"
```

---

### Task 3: Parsers

**Files:**
- Create: `apps/api/src/fleet/ingest/parsers/fields.ts`, `cost-ledger.parser.ts`, `metrics.parser.ts`,
  `review-audit.parser.ts`, `finish.parser.ts`, `apps/api/src/fleet/ingest/parse-bundle.ts`
- Test: `apps/api/src/fleet/ingest/parsers/parsers.spec.ts`, `apps/api/src/fleet/ingest/parse-bundle.spec.ts`

**Interfaces:**
- Consumes: `BundleFiles`, `BundleFile` (Task 2), row types and `INGEST_LIMITS` (Task 2).
- Produces:

```ts
// fields.ts
export function str(v: unknown, max: number): string | null;          // non-empty string cut to max, else null
export function nonNegInt(v: unknown): number | null;                 // finite integer >= 0 (floats floored), else null
export function money(v: unknown): string | null;                     // finite number >= 0 -> decimal string, 8 places max
export function date(v: unknown): Date | null;                        // ISO string or epoch ms -> valid Date, else null
export function bool(v: unknown): boolean | null;
export function obj(v: unknown): Record<string, unknown> | null;      // plain object, else null
// cost-ledger.parser.ts
export interface ParseResult<T> { rows: T[]; outcome: string }        // outcome: 'done' | 'skipped:v<n>' | 'capped' | 'invalid' | 'absent'
export function parseCostLedger(files: readonly BundleFile[]): ParseResult<CostEventRow>;
// metrics.parser.ts
export function parseMetrics(file: BundleFile | null, naxRunId: string | null): ParseResult<StoryResultRow>;
// review-audit.parser.ts
export function parseReviews(files: readonly BundleFile[]): ParseResult<ReviewResultRow>;
// finish.parser.ts
export interface StatusInfo { runId: string | null; runStatus: string | null }
export interface FinishInfo { status: string; escalationReason: string | null; prUrl: string | null; branch: string | null; headSha: string | null }
export function parseStatus(file: BundleFile | null): StatusInfo;
export function parseFinish(results: readonly BundleFile[], last: readonly BundleFile[], naxRunId: string | null): FinishInfo | null;
// parse-bundle.ts
export interface ParsedBundle { naxRunId: string | null; runStatus: string | null; rows: IngestRows; finish: FinishInfo | null; files: Record<string, string>; partial: boolean; ledgerCostUsd: string }
export function parseBundle(files: BundleFiles, fallbackRunId: string | null): ParsedBundle;
```

- [ ] **Step 1: Write the failing parser tests**

`apps/api/src/fleet/ingest/parsers/parsers.spec.ts` (fixtures mirror the 2026-10-04 sandbox bundles, ids scrubbed):

```ts
import { parseCostLedger } from './cost-ledger.parser';
import { parseMetrics } from './metrics.parser';
import { parseReviews } from './review-audit.parser';
import { parseFinish, parseStatus } from './finish.parser';
import { money, nonNegInt, str } from './fields';

const costLine = (over: Record<string, unknown> = {}) => JSON.stringify({
  ts: 1791117579984, runId: 'ead36098', projectKey: 'k', schemaVersion: 8, agentName: 'native', model: 'minimax/MiniMax-M2.7',
  modelTier: 'fast', profile: 'koda-job-x', stage: 'acceptance', sessionRole: 'auto', featureName: 'multiply', storyId: 'US-001',
  callId: 'c1', scopeId: 's', tokens: { input: 0, output: 1007, cacheRead: 0, cacheWrite: 989 }, estimatedCostUsd: 0.001579275,
  exactCostUsd: 0.001579275, costUsd: 0.001579275000000002, confidence: 'exact', pricingSource: 'catalog', durationMs: 1200, ...over,
});
const file = (name: string, text: string) => ({ name, text });

describe('fields', () => {
  it('validates untrusted values', () => {
    expect(str('  ', 5)).toBeNull();
    expect(str('abcdef', 3)).toBe('abc');
    expect(nonNegInt(-1)).toBeNull();
    expect(nonNegInt(2.7)).toBe(2);
    expect(money(Number.NaN)).toBeNull();
    expect(money(Infinity)).toBeNull();
    expect(money(-0.1)).toBeNull();
    expect(money(0.001579275000000002)).toBe('0.00157928');
    expect(money(0.00000003)).toBe('0.00000003');
  });
});

describe('parseCostLedger', () => {
  it('maps v8 rows, rounding cost to 8 places', () => {
    const r = parseCostLedger([file('nax-out/cost/a.jsonl', `${costLine()}\n${costLine({ callId: 'c2', storyId: undefined })}\n`)]);
    expect(r.outcome).toBe('done');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      at: new Date(1791117579984), agentName: 'native', model: 'minimax/MiniMax-M2.7', stage: 'acceptance', sessionRole: 'auto',
      featureName: 'multiply', storyId: 'US-001', callId: 'c1', inputTokens: 0, outputTokens: 1007, cacheReadTokens: 0, cacheWriteTokens: 989,
      costUsd: '0.00157928', confidence: 'exact', pricingSource: 'catalog', durationMs: 1200,
    });
    expect(r.rows[1].storyId).toBeNull();
  });

  it('skips a file with an unknown schemaVersion', () => {
    const r = parseCostLedger([file('nax-out/cost/a.jsonl', costLine({ schemaVersion: 9 }))]);
    expect(r).toEqual({ rows: [], outcome: 'skipped:v9' });
  });

  it('drops invalid lines (bad JSON, NaN cost, missing callId) and keeps the rest', () => {
    const text = ['{nope', costLine({ costUsd: 'NaN' }), costLine({ callId: '' }), costLine({ callId: 'ok' })].join('\n');
    const r = parseCostLedger([file('nax-out/cost/a.jsonl', text)]);
    expect(r.rows.map((x) => x.callId)).toEqual(['ok']);
    expect(r.outcome).toBe('done');
  });

  it('keeps the first of a duplicated callId', () => {
    const r = parseCostLedger([file('a', costLine()), file('b', costLine({ costUsd: 9 }))]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].costUsd).toBe('0.00157928');
  });

  it('caps at 50,000 rows and reports capped', () => {
    const lines = Array.from({ length: 50_001 }, (_, i) => costLine({ callId: `c${i}` })).join('\n');
    const r = parseCostLedger([file('a', lines)]);
    expect(r.rows).toHaveLength(50_000);
    expect(r.outcome).toBe('capped');
  });

  it('is absent with no files', () => {
    expect(parseCostLedger([])).toEqual({ rows: [], outcome: 'absent' });
  });
});

describe('parseMetrics', () => {
  const metrics = JSON.stringify([
    { runId: 'run-other', feature: 'x', stories: [{ storyId: 'US-9', attempts: 1, success: true, firstPassSuccess: true, cost: 1 }] },
    {
      runId: 'run-053a', feature: 'multiply', stories: [{
        storyId: 'US-001', complexity: 'simple', initialComplexity: 'simple', modelTier: 'fast', finalTier: 'fast',
        modelUsed: 'minimax/MiniMax-M2.7', agentUsed: 'native', attempts: 1, success: true, firstPassSuccess: true,
        cost: 0.13950221999999995, durationMs: 0, startedAt: '2026-10-04T12:40:02.404Z', completedAt: '2026-10-04T12:45:36.178Z',
        tokens: { inputTokens: 64209, outputTokens: 5475, cacheReadInputTokens: 47690, cacheCreationInputTokens: 16633 },
      }],
    },
  ]);

  it('picks the run matching the nax run id', () => {
    const r = parseMetrics(file('nax-out/metrics.json', metrics), 'run-053a');
    expect(r.outcome).toBe('done');
    expect(r.rows).toEqual([expect.objectContaining({
      featureName: 'multiply', storyId: 'US-001', attempts: 1, success: true, firstPassSuccess: true, costUsd: '0.13950222',
      inputTokens: 64209, outputTokens: 5475, cacheReadTokens: 47690, cacheWriteTokens: 16633,
      completedAt: new Date('2026-10-04T12:45:36.178Z'),
    })]);
  });

  it('falls back to the only run when no id matches, and is invalid for non-arrays', () => {
    const single = JSON.stringify([JSON.parse(metrics)[1]]);
    expect(parseMetrics(file('m', single), 'run-zzz').rows).toHaveLength(1);
    expect(parseMetrics(file('m', '{"a":1}'), null)).toEqual({ rows: [], outcome: 'invalid' });
    expect(parseMetrics(null, null)).toEqual({ rows: [], outcome: 'absent' });
  });
});

describe('parseReviews', () => {
  it('counts findings by severity (D374)', () => {
    const rec = JSON.stringify({
      timestamp: '2026-10-04T12:45:36.045Z', runId: 'r', storyId: 'US-001', reviewer: 'semantic', recordId: 'rec1', passed: false, failOpen: false,
      result: { passed: false, findings: [{ severity: 'error' }, { severity: 'ERROR' }, { severity: 'warning' }, {}] }, advisoryFindings: [{}, {}],
    });
    const r = parseReviews([file('nax-out/review-audit/f/1.json', rec), file('bad', '{')]);
    expect(r.rows).toEqual([{
      storyId: 'US-001', reviewer: 'semantic', recordId: 'rec1', passed: false, failOpen: false, findingCount: 4,
      findingsBySeverity: { error: 2, warning: 1, unknown: 1 }, advisoryCount: 2, at: new Date('2026-10-04T12:45:36.045Z'),
    }]);
  });
});

describe('parseStatus / parseFinish', () => {
  const result = JSON.stringify({
    feature: 'substract', status: 'escalated', escalationReason: 'quality review never discharged its reading obligations',
    branch: 'feat/substract', headSha: 'd24d0a97', url: 'https://github.com/o/r/pull/1', rounds: [],
  });
  const last = (runId: string) => JSON.stringify({ branch: 'feat/b', headSha: 'abc', status: 'opened', prUrl: 'https://github.com/o/r/pull/2', runId });

  it('reads run id and status', () => {
    expect(parseStatus(file('s', JSON.stringify({ run: { id: 'run-1', status: 'completed' } })))).toEqual({ runId: 'run-1', runStatus: 'completed' });
    expect(parseStatus(null)).toEqual({ runId: null, runStatus: null });
  });

  it('prefers <runId>.result.json, falls back to a matching last.json, ignores a foreign one', () => {
    expect(parseFinish([file('nax-out/finish-audit/substract/run-1.result.json', result)], [], 'run-1')).toEqual({
      status: 'escalated', escalationReason: 'quality review never discharged its reading obligations',
      prUrl: 'https://github.com/o/r/pull/1', branch: 'feat/substract', headSha: 'd24d0a97',
    });
    expect(parseFinish([], [file('nax-out/finish-audit/f/last.json', last('run-1'))], 'run-1')).toMatchObject({ status: 'opened', prUrl: 'https://github.com/o/r/pull/2' });
    expect(parseFinish([], [file('nax-out/finish-audit/f/last.json', last('run-2'))], 'run-1')).toBeNull();
    expect(parseFinish([file('nax-out/finish-audit/f/run-2.result.json', result)], [], 'run-1')).toBeNull();
  });

  it('drops a non-https PR url (D375)', () => {
    const bad = JSON.stringify({ status: 'opened', url: 'javascript:alert(1)' });
    expect(parseFinish([file('nax-out/finish-audit/f/run-1.result.json', bad)], [], 'run-1')?.prUrl).toBeNull();
  });
});
```

`apps/api/src/fleet/ingest/parse-bundle.spec.ts`:

```ts
import { parseBundle } from './parse-bundle';
import type { BundleFiles } from './bundle-reader';

const empty: BundleFiles = { cost: [], metrics: null, reviews: [], finishResults: [], finishLast: [], status: null, oversized: [] };
const line = (callId: string, costUsd: number, schemaVersion = 8) => JSON.stringify({
  ts: 0, schemaVersion, agentName: 'native', model: 'm', stage: 'run', featureName: 'f', callId,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd,
});

describe('parseBundle', () => {
  it('sums the ledger unrounded and uses status.json run id', () => {
    const p = parseBundle({
      ...empty,
      cost: [{ name: 'nax-out/cost/a.jsonl', text: [line('a', 0.00000001), line('b', 0.00000002)].join('\n') }],
      status: { name: 'nax-out/status.json', text: JSON.stringify({ run: { id: 'run-1', status: 'completed' } }) },
    }, 'fallback');
    expect(p.naxRunId).toBe('run-1');
    expect(p.runStatus).toBe('completed');
    expect(p.ledgerCostUsd).toBe('0.00000003'); // plain notation, never '3e-8'
    expect(p.files).toEqual({ cost: 'done', metrics: 'absent', review: 'absent', finish: 'absent' });
    expect(p.partial).toBe(false);
  });

  it('is partial when a file is skipped, capped or oversized, and keeps the others', () => {
    const p = parseBundle({ ...empty, cost: [{ name: 'a', text: line('a', 1, 9) }], oversized: ['nax-out/metrics.json'] }, 'run-x');
    expect(p.naxRunId).toBe('run-x');
    expect(p.files).toMatchObject({ cost: 'skipped:v9', metrics: 'oversized' });
    expect(p.partial).toBe(true);
    expect(p.ledgerCostUsd).toBe('0');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/ingest/parsers/parsers.spec.ts src/fleet/ingest/parse-bundle.spec.ts`
Expected: FAIL — `Cannot find module './cost-ledger.parser'` / `'./parse-bundle'`.

- [ ] **Step 3: Implement `fields.ts`**

```ts
import { Prisma } from '@prisma/client';

/** D365: typed readers for untrusted bundle JSON. Every reader returns null for anything it does not accept. */
export function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

export function nonNegInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const n = Math.floor(v);
  return n <= 2_147_483_647 ? n : null;
}

export function money(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  // toFixed(), never toString(): Decimal prints values below 1e-7 as '3e-8'.
  return new Prisma.Decimal(v).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP).toFixed();
}

export function date(v: unknown): Date | null {
  const d = typeof v === 'number' ? new Date(v) : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Implement `cost-ledger.parser.ts`**

```ts
import type { BundleFile } from '../bundle-reader';
import { CostEventRow, INGEST_LIMITS } from '../domain/bundle-ingest.domain';
import { date, money, nonNegInt, obj, parseJson, str } from './fields';

export interface ParseResult<T> {
  rows: T[];
  outcome: string;
}

const SUPPORTED_VERSIONS = new Set([8]);
const S = INGEST_LIMITS.shortText;
const ID = INGEST_LIMITS.idText;

function toRow(raw: Record<string, unknown>): CostEventRow | null {
  const tokens = obj(raw.tokens) ?? {};
  const at = date(raw.ts);
  const agentName = str(raw.agentName, S);
  const model = str(raw.model, S);
  const stage = str(raw.stage, S);
  const featureName = str(raw.featureName, ID);
  const callId = str(raw.callId, ID);
  const costUsd = money(raw.costUsd);
  if (!at || !agentName || !model || !stage || !featureName || !callId || costUsd === null) return null;
  return {
    at, agentName, model, stage, featureName, callId, costUsd,
    modelTier: str(raw.modelTier, S), profile: str(raw.profile, S), sessionRole: str(raw.sessionRole, S), storyId: str(raw.storyId, ID),
    inputTokens: nonNegInt(tokens.input) ?? 0, outputTokens: nonNegInt(tokens.output) ?? 0,
    cacheReadTokens: nonNegInt(tokens.cacheRead) ?? 0, cacheWriteTokens: nonNegInt(tokens.cacheWrite) ?? 0,
    pricingSource: str(raw.pricingSource, S), confidence: str(raw.confidence, S), durationMs: nonNegInt(raw.durationMs),
  };
}

/** Spec §2.3: every `cost/*.jsonl`; an unsupported schemaVersion skips its whole file; duplicate callIds keep the first. */
export function parseCostLedger(files: readonly BundleFile[]): ParseResult<CostEventRow> {
  if (files.length === 0) return { rows: [], outcome: 'absent' };
  const seen = new Set<string>();
  const rows: CostEventRow[] = [];
  let skipped: string | null = null;
  for (const f of files) {
    const parsed = f.text.split('\n').filter((l) => l.trim().length > 0).map(parseJson).map(obj).filter((r): r is Record<string, unknown> => r !== null);
    const version = parsed.length > 0 ? parsed[0].schemaVersion : 8;
    if (!SUPPORTED_VERSIONS.has(version as number)) {
      skipped = `skipped:v${String(version).slice(0, 10)}`;
      continue;
    }
    for (const raw of parsed) {
      const row = toRow(raw);
      if (!row || seen.has(row.callId)) continue;
      if (rows.length >= INGEST_LIMITS.costEvents) return { rows, outcome: 'capped' };
      seen.add(row.callId);
      rows.push(row);
    }
  }
  return { rows, outcome: skipped && rows.length === 0 ? skipped : skipped ? 'partial' : 'done' };
}
```

(`rows`/`seen` are local accumulators of a pure function; the inputs are never mutated.)

- [ ] **Step 5: Implement `metrics.parser.ts`**

```ts
import type { BundleFile } from '../bundle-reader';
import { INGEST_LIMITS, StoryResultRow } from '../domain/bundle-ingest.domain';
import type { ParseResult } from './cost-ledger.parser';
import { bool, date, money, nonNegInt, obj, parseJson, str } from './fields';

const S = INGEST_LIMITS.shortText;
const ID = INGEST_LIMITS.idText;

function toRow(feature: string, raw: Record<string, unknown>): StoryResultRow | null {
  const storyId = str(raw.storyId, ID);
  const attempts = nonNegInt(raw.attempts);
  const success = bool(raw.success);
  if (!storyId || attempts === null || success === null) return null;
  const tokens = obj(raw.tokens) ?? {};
  return {
    featureName: feature, storyId, attempts, success, firstPassSuccess: bool(raw.firstPassSuccess) ?? false,
    complexity: str(raw.complexity, S), initialComplexity: str(raw.initialComplexity, S), modelTier: str(raw.modelTier, S),
    finalTier: str(raw.finalTier, S), modelUsed: str(raw.modelUsed, S), agentUsed: str(raw.agentUsed, S),
    costUsd: money(raw.cost) ?? '0', durationMs: nonNegInt(raw.durationMs),
    inputTokens: nonNegInt(tokens.inputTokens) ?? 0, outputTokens: nonNegInt(tokens.outputTokens) ?? 0,
    cacheReadTokens: nonNegInt(tokens.cacheReadInputTokens) ?? 0, cacheWriteTokens: nonNegInt(tokens.cacheCreationInputTokens) ?? 0,
    startedAt: date(raw.startedAt), completedAt: date(raw.completedAt),
  };
}

/** Spec §1.3, D366: the run whose runId matches, else the only run. */
export function parseMetrics(file: BundleFile | null, naxRunId: string | null): ParseResult<StoryResultRow> {
  if (!file) return { rows: [], outcome: 'absent' };
  const runs = parseJson(file.text);
  if (!Array.isArray(runs)) return { rows: [], outcome: 'invalid' };
  const objects = runs.map(obj).filter((r): r is Record<string, unknown> => r !== null);
  const run = objects.find((r) => naxRunId !== null && r.runId === naxRunId) ?? (objects.length === 1 ? objects[0] : null);
  if (!run) return { rows: [], outcome: 'done' };
  const feature = str(run.feature, ID) ?? 'unknown';
  const stories = Array.isArray(run.stories) ? run.stories.map(obj).filter((s): s is Record<string, unknown> => s !== null) : [];
  const rows = stories.map((s) => toRow(feature, s)).filter((r): r is StoryResultRow => r !== null);
  const unique = rows.filter((r, i) => rows.findIndex((o) => o.storyId === r.storyId) === i);
  return unique.length > INGEST_LIMITS.stories
    ? { rows: unique.slice(0, INGEST_LIMITS.stories), outcome: 'capped' }
    : { rows: unique, outcome: 'done' };
}
```

- [ ] **Step 6: Implement `review-audit.parser.ts`**

```ts
import type { BundleFile } from '../bundle-reader';
import { INGEST_LIMITS, ReviewResultRow } from '../domain/bundle-ingest.domain';
import type { ParseResult } from './cost-ledger.parser';
import { bool, date, obj, parseJson, str } from './fields';

function countBySeverity(findings: unknown[]): Record<string, number> {
  return findings.reduce<Record<string, number>>((acc, f) => {
    const key = (str(obj(f)?.severity, 40) ?? 'unknown').toLowerCase();
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {});
}

function toRow(raw: Record<string, unknown>): ReviewResultRow | null {
  const reviewer = str(raw.reviewer, INGEST_LIMITS.shortText);
  const recordId = str(raw.recordId, INGEST_LIMITS.idText);
  const at = date(raw.timestamp);
  const result = obj(raw.result) ?? {};
  const passed = bool(raw.passed) ?? bool(result.passed);
  if (!reviewer || !recordId || !at || passed === null) return null;
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return {
    storyId: str(raw.storyId, INGEST_LIMITS.idText), reviewer, recordId, passed, failOpen: bool(raw.failOpen) ?? false,
    findingCount: findings.length, findingsBySeverity: countBySeverity(findings),
    advisoryCount: Array.isArray(raw.advisoryFindings) ? raw.advisoryFindings.length : 0, at,
  };
}

/** Spec §1.4, D374. */
export function parseReviews(files: readonly BundleFile[]): ParseResult<ReviewResultRow> {
  if (files.length === 0) return { rows: [], outcome: 'absent' };
  const rows = files.map((f) => obj(parseJson(f.text))).filter((r): r is Record<string, unknown> => r !== null)
    .map(toRow).filter((r): r is ReviewResultRow => r !== null);
  const unique = rows.filter((r, i) => rows.findIndex((o) => o.recordId === r.recordId) === i);
  return unique.length > INGEST_LIMITS.reviews
    ? { rows: unique.slice(0, INGEST_LIMITS.reviews), outcome: 'capped' }
    : { rows: unique, outcome: 'done' };
}
```

- [ ] **Step 7: Implement `finish.parser.ts`**

```ts
import { posix } from 'path';
import type { BundleFile } from '../bundle-reader';
import { INGEST_LIMITS } from '../domain/bundle-ingest.domain';
import { obj, parseJson, str } from './fields';

export interface StatusInfo {
  runId: string | null;
  runStatus: string | null;
}

export interface FinishInfo {
  status: string;
  escalationReason: string | null;
  prUrl: string | null;
  branch: string | null;
  headSha: string | null;
}

export function parseStatus(file: BundleFile | null): StatusInfo {
  const run = obj(obj(file ? parseJson(file.text) : null)?.run);
  return { runId: str(run?.id, INGEST_LIMITS.idText), runStatus: str(run?.status, INGEST_LIMITS.shortText) };
}

const https = (v: unknown): string | null => {
  const s = str(v, INGEST_LIMITS.reasonText);
  return s && s.startsWith('https://') ? s : null;
};

function toInfo(raw: Record<string, unknown>): FinishInfo | null {
  const status = str(raw.status, INGEST_LIMITS.shortText);
  if (!status) return null;
  return {
    status,
    escalationReason: str(raw.escalationReason, INGEST_LIMITS.reasonText),
    prUrl: https(raw.url) ?? https(raw.prUrl),
    branch: str(raw.branch, INGEST_LIMITS.idText),
    headSha: str(raw.headSha, INGEST_LIMITS.idText),
  };
}

/** Spec §3.2, D366: `<runId>.result.json`, else a `last.json` whose runId matches; null otherwise. */
export function parseFinish(results: readonly BundleFile[], last: readonly BundleFile[], naxRunId: string | null): FinishInfo | null {
  if (!naxRunId) return null;
  const own = results.find((f) => posix.basename(f.name) === `${naxRunId}.result.json`);
  const fromResult = own ? obj(parseJson(own.text)) : null;
  if (fromResult) return toInfo(fromResult);
  const match = last.map((f) => obj(parseJson(f.text))).find((r) => r !== null && r.runId === naxRunId);
  return match ? toInfo(match) : null;
}
```

- [ ] **Step 8: Implement `parse-bundle.ts`**

```ts
import { Prisma } from '@prisma/client';
import type { BundleFiles } from './bundle-reader';
import type { IngestRows } from './domain/bundle-ingest.domain';
import { parseCostLedger } from './parsers/cost-ledger.parser';
import { FinishInfo, parseFinish, parseStatus } from './parsers/finish.parser';
import { parseMetrics } from './parsers/metrics.parser';
import { parseReviews } from './parsers/review-audit.parser';

export interface ParsedBundle {
  naxRunId: string | null;
  runStatus: string | null;
  rows: IngestRows;
  finish: FinishInfo | null;
  files: Record<string, string>;
  partial: boolean;
  /** Unrounded sum of the parsed cost rows (A7). */
  ledgerCostUsd: string;
}

const isPartial = (outcome: string) => outcome !== 'done' && outcome !== 'absent';

/** Spec §2.3: one bundle's files -> rows + finish info + per-file outcomes. Pure. */
export function parseBundle(files: BundleFiles, fallbackRunId: string | null): ParsedBundle {
  const status = parseStatus(files.status);
  const naxRunId = status.runId ?? fallbackRunId;
  const oversized = (slot: string) => files.oversized.some((n) => n.startsWith(slot));
  const cost = parseCostLedger(files.cost);
  const metrics = oversized('nax-out/metrics.json') ? { rows: [], outcome: 'oversized' } : parseMetrics(files.metrics, naxRunId);
  const reviews = parseReviews(files.reviews);
  const finish = parseFinish(files.finishResults, files.finishLast, naxRunId);
  const outcomes: Record<string, string> = {
    cost: oversized('nax-out/cost/') && cost.outcome === 'done' ? 'partial' : cost.outcome,
    metrics: metrics.outcome,
    review: reviews.outcome,
    finish: finish ? 'done' : 'absent',
  };
  const ledger = cost.rows.reduce((sum, r) => sum.add(r.costUsd), new Prisma.Decimal(0));
  return {
    naxRunId,
    runStatus: status.runStatus,
    rows: { costEvents: cost.rows, stories: metrics.rows, reviews: reviews.rows },
    finish,
    files: outcomes,
    partial: Object.values(outcomes).some(isPartial) || files.oversized.length > 0,
    ledgerCostUsd: ledger.toFixed(),
  };
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped src/fleet/ingest/parsers/parsers.spec.ts src/fleet/ingest/parse-bundle.spec.ts`
Expected: PASS. The `parse-bundle` sum test pins two rules at once: the ledger total is the sum of the stored
per-row values (rounded only at display, A7), and money strings use plain notation (`toFixed()`, D365).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/fleet/ingest/parsers apps/api/src/fleet/ingest/parse-bundle.ts apps/api/src/fleet/ingest/parse-bundle.spec.ts
git commit -m "feat(fleet): S2b bundle parsers (D365, D366, D374, D375)"
```

---

### Task 4: Correction rules

**Files:**
- Create: `apps/api/src/fleet/ingest/ingest-corrections.ts`
- Test: `apps/api/src/fleet/ingest/ingest-corrections.spec.ts`

**Interfaces:**
- Consumes: `FinishInfo` (Task 3), `FleetJobRecord`, `FleetJobPatch` from `src/fleet/jobs/domain/fleet-job.domain.ts`.
- Produces:

```ts
export interface CorrectionInput {
  job: Pick<FleetJobRecord, 'state' | 'command' | 'leaseEpoch' | 'costSpentUsd' | 'stateReason' | 'finishResult' | 'escalationReason' | 'resultPrUrl' | 'resultBranch' | 'resultSha'>;
  leaseEpoch: number;          // the bundle's attempt
  ledgerCostUsd: string;       // unrounded
  runStatus: string | null;    // status.json run.status
  finish: FinishInfo | null;
}
export interface Correction { patch: FleetJobPatch; costRaised: boolean; escalated: boolean; liveCostUsd: string | null }
export const ESCALATED_FROM_AUDIT = 'finish escalated (from finish-audit)';
export const NOTHING_PUSHED = 'completed; nothing pushed (finish disabled or skipped)';
export function computeCorrection(input: CorrectionInput): Correction;
```

- [ ] **Step 1: Write the failing test**

```ts
import { computeCorrection, ESCALATED_FROM_AUDIT, NOTHING_PUSHED } from './ingest-corrections';

const job = (over = {}) => ({
  state: 'COMPLETED', command: 'RUN', leaseEpoch: 1, costSpentUsd: '0.0745', stateReason: null, finishResult: null,
  escalationReason: null, resultPrUrl: null, resultBranch: null, resultSha: null, ...over,
});
const finish = (over = {}) => ({ status: 'escalated', escalationReason: 'why', prUrl: 'https://x/pull/1', branch: 'feat/a', headSha: 'abc', ...over });
const input = (over = {}) => ({ job: job(), leaseEpoch: 1, ledgerCostUsd: '0.15730000', runStatus: 'completed', finish: null, ...over });

describe('computeCorrection (spec §3)', () => {
  it('raises cost to the rounded ledger total (#203, nax#2348)', () => {
    const c = computeCorrection(input());
    expect(c.patch.costSpentUsd).toBe('0.1573');
    expect(c.costRaised).toBe(true);
    expect(c.liveCostUsd).toBe('0.0745');
  });

  it('never lowers cost (ledger missed an in-flight session)', () => {
    const c = computeCorrection(input({ ledgerCostUsd: '0.01' }));
    expect(c.patch.costSpentUsd).toBeUndefined();
    expect(c.costRaised).toBe(false);
  });

  it('rounds half-up to 4 places (A7)', () => {
    expect(computeCorrection(input({ job: job({ costSpentUsd: '0' }), ledgerCostUsd: '0.00435' })).patch.costSpentUsd).toBe('0.0044');
  });

  it('corrects COMPLETED -> ESCALATED and fills empty finish fields only', () => {
    const c = computeCorrection(input({ job: job({ resultBranch: 'from-status' }), finish: finish() }));
    expect(c.escalated).toBe(true);
    expect(c.patch).toMatchObject({
      state: 'ESCALATED', stateReason: ESCALATED_FROM_AUDIT, finishResult: 'escalated', escalationReason: 'why',
      resultPrUrl: 'https://x/pull/1', resultSha: 'abc',
    });
    expect(c.patch.resultBranch).toBeUndefined();
  });

  it('fills a PR link without changing state for an opened finish', () => {
    const c = computeCorrection(input({ finish: finish({ status: 'opened', escalationReason: null }) }));
    expect(c.escalated).toBe(false);
    expect(c.patch.state).toBeUndefined();
    expect(c.patch).toMatchObject({ finishResult: 'opened', resultPrUrl: 'https://x/pull/1' });
  });

  it('never changes any other state', () => {
    for (const state of ['FAILED', 'CANCELLED', 'CRASHED', 'ESCALATED']) {
      expect(computeCorrection(input({ job: job({ state }), finish: finish() })).patch.state).toBeUndefined();
    }
  });

  it('marks a COMPLETED RUN with no finish and no branch as nothing pushed (#204)', () => {
    expect(computeCorrection(input()).patch.stateReason).toBe(NOTHING_PUSHED);
    expect(computeCorrection(input({ finish: finish({ status: 'skipped', prUrl: null, branch: null, headSha: null }) })).patch.stateReason).toBe(NOTHING_PUSHED);
    expect(computeCorrection(input({ job: job({ resultBranch: 'b' }) })).patch.stateReason).toBeUndefined();
    expect(computeCorrection(input({ job: job({ command: 'PLAN' }) })).patch.stateReason).toBeUndefined();
    expect(computeCorrection(input({ job: job({ stateReason: 'kept' }) })).patch.stateReason).toBeUndefined();
  });

  it('ignores finish for PLAN jobs and for runs not completed', () => {
    expect(computeCorrection(input({ job: job({ command: 'PLAN' }), finish: finish() })).escalated).toBe(false);
    expect(computeCorrection(input({ runStatus: 'failed', finish: finish() })).escalated).toBe(false);
  });

  it('changes nothing on the job for an earlier attempt (D367, Review Focus 2)', () => {
    const c = computeCorrection(input({ job: job({ leaseEpoch: 2 }), leaseEpoch: 1, finish: finish() }));
    expect(c).toEqual({ patch: {}, costRaised: false, escalated: false, liveCostUsd: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/ingest/ingest-corrections.spec.ts`
Expected: FAIL — `Cannot find module './ingest-corrections'`.

- [ ] **Step 3: Implement**

```ts
import { Prisma } from '@prisma/client';
import { FleetJobState } from '../../common/enums';
import type { FleetJobPatch, FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import type { FinishInfo } from './parsers/finish.parser';

export const ESCALATED_FROM_AUDIT = 'finish escalated (from finish-audit)';
export const NOTHING_PUSHED = 'completed; nothing pushed (finish disabled or skipped)';

export interface CorrectionInput {
  job: Pick<FleetJobRecord, 'state' | 'command' | 'leaseEpoch' | 'costSpentUsd' | 'stateReason' | 'finishResult' | 'escalationReason' | 'resultPrUrl' | 'resultBranch' | 'resultSha'>;
  leaseEpoch: number;
  ledgerCostUsd: string;
  runStatus: string | null;
  finish: FinishInfo | null;
}

export interface Correction {
  patch: FleetJobPatch;
  costRaised: boolean;
  escalated: boolean;
  liveCostUsd: string | null;
}

const round4 = (v: string) => new Prisma.Decimal(v).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
const fill = <K extends keyof FleetJobPatch>(current: string | null, value: string | null, key: K): FleetJobPatch =>
  current === null && value !== null ? ({ [key]: value } as FleetJobPatch) : {};

/** Spec §3, D367: what ingest changes on the job row. Pure; the caller holds the job lock. */
export function computeCorrection(input: CorrectionInput): Correction {
  const { job, finish } = input;
  if (input.leaseEpoch !== job.leaseEpoch) return { patch: {}, costRaised: false, escalated: false, liveCostUsd: null };

  const ledger = round4(input.ledgerCostUsd);
  const costRaised = ledger.gt(new Prisma.Decimal(job.costSpentUsd));
  const cost: FleetJobPatch = costRaised ? { costSpentUsd: ledger.toFixed(4) } : {};

  const usable = job.command === 'RUN' && input.runStatus === 'completed' && finish !== null ? finish : null;
  const fields: FleetJobPatch = usable
    ? {
      ...fill(job.finishResult, usable.status, 'finishResult'),
      ...fill(job.escalationReason, usable.escalationReason, 'escalationReason'),
      ...fill(job.resultPrUrl, usable.prUrl, 'resultPrUrl'),
      ...fill(job.resultBranch, usable.branch, 'resultBranch'),
      ...fill(job.resultSha, usable.headSha, 'resultSha'),
    }
    : {};
  const escalated = usable !== null && usable.status === 'escalated' && job.state === FleetJobState.COMPLETED;
  const state: FleetJobPatch = escalated ? { state: FleetJobState.ESCALATED, stateReason: ESCALATED_FROM_AUDIT } : {};

  const finishSilent = finish === null || finish.status === 'skipped';
  const branchAfter = job.resultBranch ?? (fields.resultBranch as string | undefined) ?? null;
  const nothingPushed = !escalated && job.state === FleetJobState.COMPLETED && job.command === 'RUN' && finishSilent && branchAfter === null && job.stateReason === null;
  const reason: FleetJobPatch = nothingPushed ? { stateReason: NOTHING_PUSHED } : {};

  return { patch: { ...cost, ...fields, ...state, ...reason }, costRaised, escalated, liveCostUsd: job.costSpentUsd };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/ingest/ingest-corrections.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/ingest/ingest-corrections.ts apps/api/src/fleet/ingest/ingest-corrections.spec.ts
git commit -m "feat(fleet): S2b ingest correction rules (spec §3, D367)"
```

---

### Task 5: Ingest repository

**Files:**
- Create: `apps/api/src/fleet/ingest/prisma-bundle-ingest.repository.ts`
- Test: `apps/api/test/integration/fleet/fleet-ingest-repository.integration.spec.ts`

**Interfaces:**
- Consumes: Task 1 models; Task 2 `IBundleIngestRepository` and row types.
- Produces: `PrismaBundleIngestRepository implements IBundleIngestRepository`.

- [ ] **Step 1: Write the failing integration test**

```ts
/**
 * Fleet S2b slice 1a — ingest repository (PG), spec §2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-repository.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { PrismaBundleIngestRepository } from '../../../src/fleet/ingest/prisma-bundle-ingest.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('bundle ingest repository (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaBundleIngestRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  const now = new Date('2026-10-05T10:00:00Z');

  const jobWithBundle = async (state: string, epoch = 1) => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: base.adminId, state, leaseEpoch: epoch,
      },
    });
    const artifact = await prisma.fleetJobArtifact.create({
      data: { jobId: job.id, leaseEpoch: epoch, kind: 'bundle', storageKey: `jobs/${job.id}/${epoch}/a.tar.gz`, sizeBytes: BigInt(1), sha256: 'a'.repeat(64) },
    });
    return { jobId: job.id, artifactId: artifact.id };
  };

  beforeAll(async () => {
    await resetDb();
    base = await seedFleetBase(prisma);
  });
  beforeEach(async () => {
    await prisma.fleetBundleIngest.deleteMany();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('enqueue inserts, and a second enqueue resets the same row (Review Focus 1)', async () => {
    const { jobId, artifactId } = await jobWithBundle('COMPLETED');
    await repo.enqueue(artifactId, jobId, 1, 1);
    await prisma.fleetBundleIngest.update({ where: { artifactId }, data: { status: 'done', attempts: 2 } });
    await repo.enqueue(artifactId, jobId, 1, 1);
    const rows = await prisma.fleetBundleIngest.findMany({ where: { artifactId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: null });
  });

  it('claims only rows whose job is terminal, oldest first', async () => {
    const running = await jobWithBundle('UPLOADING');
    const done = await jobWithBundle('COMPLETED');
    await repo.enqueue(running.artifactId, running.jobId, 1, 1);
    await repo.enqueue(done.artifactId, done.jobId, 1, 1);
    const claim = await repo.claimNext(now);
    expect(claim).toMatchObject({ jobId: done.jobId, leaseEpoch: 1, attempts: 0 });
    expect(await repo.claimNext(now)).toBeNull();
    expect((await prisma.fleetBundleIngest.findUniqueOrThrow({ where: { artifactId: done.artifactId } })).status).toBe('running');
  });

  it('skips a pending row whose backoff is not due', async () => {
    const a = await jobWithBundle('FAILED');
    await repo.enqueue(a.artifactId, a.jobId, 1, 1);
    const row = await prisma.fleetBundleIngest.findUniqueOrThrow({ where: { artifactId: a.artifactId } });
    await repo.markRetry(row.id, 1, new Date(now.getTime() + 60_000), 'boom');
    expect(await repo.claimNext(now)).toBeNull();
    expect(await repo.claimNext(new Date(now.getTime() + 60_000))).toMatchObject({ attempts: 1 });
  });

  it('re-claims a running row whose claim is older than 10 minutes (Review Focus 5)', async () => {
    const a = await jobWithBundle('COMPLETED');
    await repo.enqueue(a.artifactId, a.jobId, 1, 1);
    expect(await repo.claimNext(now)).not.toBeNull();
    expect(await repo.claimNext(new Date(now.getTime() + 599_000))).toBeNull();
    expect(await repo.claimNext(new Date(now.getTime() + 600_001))).toMatchObject({ jobId: a.jobId });
  });

  it('replaceRows deletes then inserts one attempt', async () => {
    const a = await jobWithBundle('COMPLETED');
    const ctx = { jobId: a.jobId, leaseEpoch: 1, projectId: base.projectId, repoId: base.repoId, runnerId: null, naxRunId: 'run-1' };
    const cost = (callId: string) => ({
      at: new Date(0), agentName: 'native', model: 'm', modelTier: null, profile: null, stage: 'run', sessionRole: null, featureName: 'f',
      storyId: null, callId, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: '0.5', pricingSource: null, confidence: null, durationMs: null,
    });
    await repo.replaceRows(ctx, { costEvents: [cost('a'), cost('b')], stories: [], reviews: [] });
    await repo.replaceRows(ctx, { costEvents: [cost('a')], stories: [], reviews: [] });
    expect(await prisma.fleetCostEvent.count({ where: { jobId: a.jobId } })).toBe(1);
    expect((await prisma.fleetCostEvent.findFirstOrThrow({ where: { jobId: a.jobId } })).projectId).toBe(base.projectId);
  });

  it('backfill enqueues unexpired artifacts without a row; rerun and rerunOutdated reset', async () => {
    const a = await jobWithBundle('COMPLETED');
    const b = await jobWithBundle('COMPLETED');
    await prisma.fleetJobArtifact.update({ where: { id: b.artifactId }, data: { expiredAt: now } });
    expect(await repo.backfill(1)).toBeGreaterThanOrEqual(1);
    expect(await prisma.fleetBundleIngest.count({ where: { artifactId: b.artifactId } })).toBe(0);
    const row = await prisma.fleetBundleIngest.findUniqueOrThrow({ where: { artifactId: a.artifactId } });
    await repo.markFailed(row.id, 5, 'bad');
    expect(await repo.rerunJob(a.jobId)).toBe(1);
    expect(await prisma.fleetBundleIngest.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'pending', attempts: 0, error: null });
    await prisma.fleetBundleIngest.update({ where: { id: row.id }, data: { status: 'done', parserVersion: 1 } });
    expect(await repo.rerunOutdated(2)).toBe(1);
    expect(await repo.rerunOutdated(1)).toBe(0);
  });

  it('pages rows filtered by status with the job project', async () => {
    const a = await jobWithBundle('COMPLETED');
    await repo.enqueue(a.artifactId, a.jobId, 1, 1);
    const page = await repo.findPage({ status: 'pending' }, { current: 1, size: 10 } as never);
    expect(page.records.some((r) => r.jobId === a.jobId && r.projectId === base.projectId && r.status === 'pending')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-repository.integration.spec.ts`
Expected: FAIL — `Cannot find module '.../prisma-bundle-ingest.repository'`.

- [ ] **Step 3: Implement the repository**

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { TERMINAL_STATES } from '../jobs/job-state';
import {
  IBundleIngestRepository, INGEST_STALE_CLAIM_MS, IngestArtifact, IngestClaim, IngestContext, IngestListRow, IngestOutcome,
  IngestRows, IngestStatus,
} from './domain/bundle-ingest.domain';

const RESET = { status: 'pending', attempts: 0, nextAttemptAt: null, claimedAt: null, error: null } as const;

@Injectable()
export class PrismaBundleIngestRepository implements IBundleIngestRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async enqueue(artifactId: string, jobId: string, leaseEpoch: number, parserVersion: number): Promise<void> {
    await this.db.fleetBundleIngest.upsert({
      where: { artifactId },
      create: { artifactId, jobId, leaseEpoch, parserVersion },
      update: { ...RESET, parserVersion },
    });
  }

  async claimNext(now: Date): Promise<IngestClaim | null> {
    const stale = new Date(now.getTime() - INGEST_STALE_CLAIM_MS);
    const rows = await this.db.$queryRaw<IngestClaim[]>(Prisma.sql`
      UPDATE "FleetBundleIngest" i SET "status" = 'running', "claimedAt" = ${now}, "updatedAt" = ${now}
      WHERE i."id" = (
        SELECT c."id" FROM "FleetBundleIngest" c JOIN "FleetJob" j ON j."id" = c."jobId"
        WHERE j."state" IN (${Prisma.join([...TERMINAL_STATES])})
          AND ((c."status" = 'pending' AND (c."nextAttemptAt" IS NULL OR c."nextAttemptAt" <= ${now}))
            OR (c."status" = 'running' AND c."claimedAt" < ${stale}))
        ORDER BY c."createdAt" ASC, c."id" ASC
        FOR UPDATE OF c SKIP LOCKED
        LIMIT 1
      )
      RETURNING i."id", i."artifactId", i."jobId", i."leaseEpoch", i."attempts"`);
    return rows[0] ?? null;
  }

  async findArtifact(artifactId: string): Promise<IngestArtifact | null> {
    return this.db.fleetJobArtifact.findUnique({ where: { id: artifactId }, select: { storageKey: true, expiredAt: true } });
  }

  async replaceRows(ctx: IngestContext, rows: IngestRows): Promise<void> {
    const where = { jobId: ctx.jobId, leaseEpoch: ctx.leaseEpoch };
    await this.db.fleetCostEvent.deleteMany({ where });
    await this.db.fleetStoryResult.deleteMany({ where });
    await this.db.fleetReviewResult.deleteMany({ where });
    const shared = { jobId: ctx.jobId, leaseEpoch: ctx.leaseEpoch, projectId: ctx.projectId };
    if (rows.costEvents.length > 0) {
      await this.db.fleetCostEvent.createMany({
        data: rows.costEvents.map((r) => ({ ...shared, ...r, repoId: ctx.repoId, runnerId: ctx.runnerId, naxRunId: ctx.naxRunId, costUsd: new Prisma.Decimal(r.costUsd) })),
      });
    }
    if (rows.stories.length > 0) {
      await this.db.fleetStoryResult.createMany({
        data: rows.stories.map((r) => ({ ...shared, ...r, repoId: ctx.repoId, costUsd: new Prisma.Decimal(r.costUsd) })),
      });
    }
    if (rows.reviews.length > 0) {
      await this.db.fleetReviewResult.createMany({
        data: rows.reviews.map((r) => ({ ...shared, ...r, findingsBySeverity: r.findingsBySeverity as Prisma.InputJsonValue })),
      });
    }
  }

  async markOutcome(id: string, o: IngestOutcome): Promise<void> {
    await this.db.fleetBundleIngest.update({
      where: { id },
      data: {
        status: o.kind, files: o.files as Prisma.InputJsonValue, ingestedAt: o.ingestedAt, claimedAt: null, error: null, nextAttemptAt: null,
        liveCostUsd: o.liveCostUsd === null ? null : new Prisma.Decimal(o.liveCostUsd), ledgerCostUsd: new Prisma.Decimal(o.ledgerCostUsd),
      },
    });
  }

  async markRetry(id: string, attempts: number, nextAttemptAt: Date, error: string): Promise<void> {
    await this.db.fleetBundleIngest.update({ where: { id }, data: { status: 'pending', attempts, nextAttemptAt, claimedAt: null, error } });
  }

  async markFailed(id: string, attempts: number, error: string): Promise<void> {
    await this.db.fleetBundleIngest.update({ where: { id }, data: { status: 'failed', attempts, claimedAt: null, nextAttemptAt: null, error } });
  }

  async backfill(parserVersion: number): Promise<number> {
    const missing = await this.db.fleetJobArtifact.findMany({
      where: { kind: 'bundle', expiredAt: null, ingest: null }, select: { id: true, jobId: true, leaseEpoch: true },
    });
    if (missing.length === 0) return 0;
    const { count } = await this.db.fleetBundleIngest.createMany({
      data: missing.map((a) => ({ artifactId: a.id, jobId: a.jobId, leaseEpoch: a.leaseEpoch, parserVersion })), skipDuplicates: true,
    });
    return count;
  }

  async rerunJob(jobId: string): Promise<number> {
    const { count } = await this.db.fleetBundleIngest.updateMany({ where: { jobId }, data: RESET });
    return count;
  }

  async rerunOutdated(parserVersion: number): Promise<number> {
    const { count } = await this.db.fleetBundleIngest.updateMany({
      where: { parserVersion: { lt: parserVersion }, status: { in: ['done', 'partial', 'failed'] }, artifact: { expiredAt: null } },
      data: { ...RESET, parserVersion },
    });
    return count;
  }

  async findPage(filters: { status?: IngestStatus }, page: IPageOption): Promise<IPageResult<IngestListRow>> {
    const rows = await Paginate(this.db.fleetBundleIngest, page, {
      where: filters.status ? { status: filters.status } : {},
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true, jobId: true, leaseEpoch: true, status: true, attempts: true, parserVersion: true, files: true, error: true,
        ingestedAt: true, updatedAt: true, job: { select: { projectId: true } },
      },
    });
    return rows.remap((m: { job: { projectId: string }; files: unknown; status: string } & Omit<IngestListRow, 'projectId' | 'files' | 'status'>) => ({
      id: m.id, jobId: m.jobId, leaseEpoch: m.leaseEpoch, projectId: m.job.projectId, status: m.status as IngestStatus, attempts: m.attempts,
      parserVersion: m.parserVersion, files: (m.files ?? {}) as Record<string, string>, error: m.error, ingestedAt: m.ingestedAt, updatedAt: m.updatedAt,
    }));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-repository.integration.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/ingest/prisma-bundle-ingest.repository.ts apps/api/test/integration/fleet/fleet-ingest-repository.integration.spec.ts
git commit -m "feat(fleet): S2b ingest repository with SKIP LOCKED claim"
```

---

### Task 6: Ingest service, sweeper and module

**Files:**
- Create: `apps/api/src/fleet/ingest/bundle-ingest.service.ts`, `bundle-ingest.sweeper.ts`, `ingest.module.ts`
- Modify: `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` (D371)
- Modify: `apps/api/src/fleet/fleet.module.ts`
- Test: `apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts`, `apps/api/test/integration/fleet/fleet-ingest.integration.spec.ts`

**Interfaces:**
- Consumes: Tasks 2-5; `ARTIFACT_STORE`/`ArtifactStore.get` (`src/fleet/artifacts/artifact-store.ts`);
  `FLEET_JOB_REPOSITORY` (`lockById`, `findById`, `update`, `appendEvent`); `FleetJobLivePublisher.event/publish`;
  `FleetActivityService.record`; `BudgetEvaluator.signal(keys)`; `jobSpendKeys(job)` (`budgets/budget-rules.ts:45`);
  `TRANSACTION_MANAGER`.
- Produces: `BundleIngestService` with `kick(): void`, `idle(): Promise<void>`, `drain(now?: Date): Promise<number>`,
  `ingestOne(now: Date): Promise<boolean>`; `IngestModule` exporting `BUNDLE_INGEST_REPOSITORY` and
  `BundleIngestService`.

- [ ] **Step 1: Add the activity entity type**

In `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` change:

```ts
export type FleetEntityType = 'runner' | 'enrollment' | 'repo' | 'job' | 'budget' | 'schedule' | 'approval' | 'ingest';
```

- [ ] **Step 2: Write the failing unit test for retry/backoff**

`apps/api/src/fleet/ingest/bundle-ingest.service.spec.ts`:

```ts
import { Readable } from 'stream';
import { BundleIngestService } from './bundle-ingest.service';

const now = new Date('2026-10-05T10:00:00Z');
const claim = (attempts: number) => ({ id: 'i1', artifactId: 'a1', jobId: 'j1', leaseEpoch: 1, attempts });

function make(attempts: number, opts: { expired?: boolean; storeFails?: boolean } = {}) {
  const repo = {
    claimNext: jest.fn().mockResolvedValueOnce(claim(attempts)).mockResolvedValue(null),
    findArtifact: jest.fn(async () => ({ storageKey: 'k', expiredAt: opts.expired ? now : null })),
    markRetry: jest.fn(), markFailed: jest.fn(), markOutcome: jest.fn(), replaceRows: jest.fn(),
  };
  const store = { get: jest.fn(async () => (opts.storeFails ? Promise.reject(new Error('EIO disk')) : Readable.from([Buffer.from('not gzip')]))) };
  const svc = new BundleIngestService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, { run: (fn: () => unknown) => fn() } as never);
  return { svc, repo };
}

describe('BundleIngestService failure handling (spec §2.5)', () => {
  it('backs off 1 minute after the first failure', async () => {
    const { svc, repo } = make(0);
    await svc.ingestOne(now);
    expect(repo.markRetry).toHaveBeenCalledWith('i1', 1, new Date(now.getTime() + 60_000), expect.stringContaining(''));
  });

  it('uses the 4th backoff (2 h) after the 4th failure and fails on the 5th', async () => {
    const fourth = make(3);
    await fourth.svc.ingestOne(now);
    expect(fourth.repo.markRetry).toHaveBeenCalledWith('i1', 4, new Date(now.getTime() + 7_200_000), expect.any(String));
    const fifth = make(4);
    await fifth.svc.ingestOne(now);
    expect(fifth.repo.markFailed).toHaveBeenCalledWith('i1', 5, expect.any(String));
  });

  it('fails an expired bundle at once without retry', async () => {
    const { svc, repo } = make(0, { expired: true });
    await svc.ingestOne(now);
    expect(repo.markFailed).toHaveBeenCalledWith('i1', 1, 'bundle expired');
    expect(repo.markRetry).not.toHaveBeenCalled();
  });

  it('trims the stored error to 500 chars', async () => {
    const { svc, repo } = make(0, { storeFails: true });
    await svc.ingestOne(now);
    const error = repo.markRetry.mock.calls[0][3] as string;
    expect(error.length).toBeLessThanOrEqual(500);
    expect(error).toContain('EIO disk');
  });

  it('returns false when nothing is claimable', async () => {
    const { svc, repo } = make(0);
    repo.claimNext.mockReset().mockResolvedValue(null);
    await expect(svc.ingestOne(now)).resolves.toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/ingest/bundle-ingest.service.spec.ts`
Expected: FAIL — `Cannot find module './bundle-ingest.service'`.

- [ ] **Step 4: Implement the service**

`apps/api/src/fleet/ingest/bundle-ingest.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { ARTIFACT_STORE, ArtifactStore } from '../artifacts/artifact-store';
import { BudgetEvaluator } from '../budgets/budget-evaluator';
import { jobSpendKeys } from '../budgets/budget-rules';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { readBundleFiles } from './bundle-reader';
import {
  BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository, INGEST_BACKOFF_MS, INGEST_DRAIN_LIMIT, INGEST_LIMITS, INGEST_MAX_ATTEMPTS, IngestClaim,
} from './domain/bundle-ingest.domain';
import { computeCorrection } from './ingest-corrections';
import { parseBundle } from './parse-bundle';

const SECRETISH = /(token|secret|password|key)=\S+/gi;
const trimError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(SECRETISH, '$1=***').slice(0, INGEST_LIMITS.errorText);

/** Fleet S2b (d) §2-§3: claim one bundle, parse it, write rows and corrections in one transaction. */
@Injectable()
export class BundleIngestService {
  private readonly logger = new Logger(BundleIngestService.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(BUNDLE_INGEST_REPOSITORY) private readonly repo: IBundleIngestRepository,
    @Inject(ARTIFACT_STORE) private readonly store: Pick<ArtifactStore, 'get'>,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById' | 'update' | 'appendEvent'>,
    private readonly live: FleetJobLivePublisher,
    private readonly activity: FleetActivityService,
    private readonly budgets: BudgetEvaluator,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** D369: off the request path; never throws. */
  kick(): void {
    this.queue = this.queue.then(() => this.drain().then(() => undefined)).catch((error: unknown) => {
      this.logger.warn(`bundle ingest drain failed: ${trimError(error)}`);
    });
  }

  idle(): Promise<void> {
    return this.queue;
  }

  async drain(now = new Date()): Promise<number> {
    let done = 0;
    while (done < INGEST_DRAIN_LIMIT && (await this.ingestOne(now))) done += 1;
    return done;
  }

  /** One claimed row end to end. Returns false when nothing was claimable. Failures are recorded, never thrown. */
  async ingestOne(now: Date): Promise<boolean> {
    const claim = await this.repo.claimNext(now);
    if (!claim) return false;
    try {
      const artifact = await this.repo.findArtifact(claim.artifactId);
      if (!artifact || artifact.expiredAt) {
        await this.repo.markFailed(claim.id, claim.attempts + 1, 'bundle expired');
        return true;
      }
      const files = await readBundleFiles(await this.store.get(artifact.storageKey));
      await this.write(claim, files, now);
    } catch (error) {
      await this.recordFailure(claim, error, now);
    }
    return true;
  }

  private async write(claim: IngestClaim, files: Awaited<ReturnType<typeof readBundleFiles>>, now: Date): Promise<void> {
    const result = await this.txManager.run(async () => {
      const job = await this.jobs.lockById(claim.jobId);
      if (!job) return null;
      const parsed = parseBundle(files, job.leaseEpoch === claim.leaseEpoch ? job.naxRunId : null);
      await this.repo.replaceRows(
        { jobId: job.id, leaseEpoch: claim.leaseEpoch, projectId: job.projectId, repoId: job.repoId, runnerId: job.runnerId, naxRunId: parsed.naxRunId },
        parsed.rows,
      );
      const correction = computeCorrection({ job, leaseEpoch: claim.leaseEpoch, ledgerCostUsd: parsed.ledgerCostUsd, runStatus: parsed.runStatus, finish: parsed.finish });
      const changed = Object.keys(correction.patch).length > 0;
      const updated = changed ? await this.jobs.update(job.id, correction.patch) : job;
      if (correction.escalated) {
        await this.jobs.appendEvent(job.id, { leaseEpoch: claim.leaseEpoch, runnerSeq: null, type: 'state', payload: { from: job.state, to: updated.state, by: 'server', reason: updated.stateReason } });
        await this.activity.record({
          actorType: 'SYSTEM', actorId: 'system', action: 'job.verdict_corrected', entityType: 'job', entityId: job.id, jobId: job.id,
          projectId: job.projectId, responsibleUserId: job.requestedById, payload: { from: job.state, to: updated.state, source: 'finish-audit' },
        });
      }
      await this.repo.markOutcome(claim.id, {
        kind: parsed.partial ? 'partial' : 'done', files: parsed.files, liveCostUsd: correction.liveCostUsd, ledgerCostUsd: parsed.ledgerCostUsd, ingestedAt: now,
      });
      return { event: this.live.event(updated), spendKeys: correction.costRaised ? jobSpendKeys(updated) : [] };
    });
    if (!result) return;
    this.live.publish([result.event]);
    if (result.spendKeys.length > 0) this.budgets.signal(result.spendKeys);
  }

  private async recordFailure(claim: IngestClaim, error: unknown, now: Date): Promise<void> {
    const attempts = claim.attempts + 1;
    const message = trimError(error);
    this.logger.warn(`bundle ingest ${claim.id} (job ${claim.jobId}) failed attempt ${attempts}: ${message}`);
    if (attempts >= INGEST_MAX_ATTEMPTS) await this.repo.markFailed(claim.id, attempts, message);
    else await this.repo.markRetry(claim.id, attempts, new Date(now.getTime() + INGEST_BACKOFF_MS[attempts - 1]), message);
  }
}
```

`IFleetJobRepository.update(id, patch)` returns `FleetJobRecord` (with `projectId`, `repoId`, `runnerId`,
`requestedById`, `naxRunId`, `leaseEpoch`). The `state` event payload `{ from, to, by, reason }` is the shape
`job-transitions.service.ts:76-78` writes; `by` is a `TransitionActor` (`'server' | 'runner'`).

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/ingest/bundle-ingest.service.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Implement the sweeper and module**

`apps/api/src/fleet/ingest/bundle-ingest.sweeper.ts`:

```ts
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { BundleIngestService } from './bundle-ingest.service';

export const INGEST_SWEEP_MS = 30_000;

/** Spec §2.1, D368: catches rows the in-process kick missed (restart, retry due, stale claim). */
@Injectable()
export class BundleIngestSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ingest: BundleIngestService,
    @Inject(FLEET_CFG) private readonly cfg: Pick<IFleetConfig, 'sweepEnabled'>,
  ) {}

  onModuleInit(): void {
    if (!this.cfg.sweepEnabled) return;
    this.timer = setInterval(() => this.ingest.kick(), INGEST_SWEEP_MS);
    this.timer.unref();
    this.ingest.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
```

`apps/api/src/fleet/ingest/ingest.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ArtifactStoreModule } from '../artifacts/artifact-store.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { BundleIngestService } from './bundle-ingest.service';
import { BundleIngestSweeper } from './bundle-ingest.sweeper';
import { BUNDLE_INGEST_REPOSITORY } from './domain/bundle-ingest.domain';
import { PrismaBundleIngestRepository } from './prisma-bundle-ingest.repository';

/** Fleet S2b (d) (spec docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md). */
@Module({
  imports: [PrismaModule, ArtifactStoreModule, FleetJobsModule, FleetActivityModule, BudgetsModule],
  providers: [
    PrismaBundleIngestRepository, { provide: BUNDLE_INGEST_REPOSITORY, useExisting: PrismaBundleIngestRepository },
    BundleIngestService, BundleIngestSweeper,
  ],
  exports: [BUNDLE_INGEST_REPOSITORY, BundleIngestService],
})
export class IngestModule {}
```

In `apps/api/src/fleet/fleet.module.ts` add `import { IngestModule } from './ingest/ingest.module';` and append
`IngestModule` to the `imports` array. There is no cycle: `BudgetsModule` already imports `FleetJobsModule`, and
neither imports `IngestModule`.

- [ ] **Step 7: Write the failing integration test**

`apps/api/test/integration/fleet/fleet-ingest.integration.spec.ts`:

```ts
/**
 * Fleet S2b slice 1a — ingest end to end over the real store and DB (PG), spec §2-§3.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest.integration.spec.ts
 */
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { tarGz } from '../../helpers/tar-gz';
import { ARTIFACT_STORE, ArtifactStore } from '../../../src/fleet/artifacts/artifact-store';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository } from '../../../src/fleet/ingest/domain/bundle-ingest.domain';
import { ESCALATED_FROM_AUDIT, NOTHING_PUSHED } from '../../../src/fleet/ingest/ingest-corrections';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const costLine = (callId: string, costUsd: number, stage = 'run') => JSON.stringify({
  ts: 1791117579984, schemaVersion: 8, agentName: 'native', model: 'minimax/MiniMax-M2.7', stage, sessionRole: 'implementer',
  featureName: 'f', storyId: 'US-001', callId, tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, costUsd,
});
const statusJson = (runId: string) => JSON.stringify({ run: { id: runId, status: 'completed' }, cost: { spent: 0.0745 } });
const metricsJson = (runId: string) => JSON.stringify([{ runId, feature: 'f', stories: [{ storyId: 'US-001', attempts: 2, success: true, firstPassSuccess: false, cost: 0.15 }] }]);
const reviewJson = JSON.stringify({ timestamp: '2026-10-04T12:45:36.045Z', storyId: 'US-001', reviewer: 'semantic', recordId: 'rec1', passed: true, failOpen: false, result: { passed: true, findings: [] } });
const finishJson = (status: string) => JSON.stringify({ status, escalationReason: 'quality review never discharged', branch: 'feat/f', headSha: 'd24d0a97', url: 'https://github.com/o/r/pull/1' });

describeIntegration('fleet bundle ingest (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let store: ArtifactStore;
  let ingest: BundleIngestService;
  let repo: IBundleIngestRepository;
  const savedDir = process.env.FLEET_ARTIFACT_DIR;
  const now = new Date('2026-10-05T10:00:00Z');

  const seedJob = async (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(5), requestedById: base.adminId, state: 'COMPLETED', leaseEpoch: 1, naxRunId: 'run-1',
      costSpentUsd: new Prisma.Decimal('0.0745'), finishedAt: now, ...over,
    },
  });
  const attach = async (jobId: string, files: { name: string; body: string }[], epoch = 1) => {
    const gz = await tarGz(files);
    const key = `jobs/${jobId}/${epoch}/${sha(gz).slice(0, 8)}.tar.gz`;
    await store.put(key, Readable.from([gz]), { maxBytes: 10_000_000, expectedSha256: sha(gz) });
    const artifact = await prisma.fleetJobArtifact.upsert({
      where: { jobId_kind_leaseEpoch: { jobId, kind: 'bundle', leaseEpoch: epoch } },
      create: { jobId, leaseEpoch: epoch, kind: 'bundle', storageKey: key, sizeBytes: BigInt(gz.length), sha256: sha(gz) },
      update: { storageKey: key, sizeBytes: BigInt(gz.length), sha256: sha(gz) },
    });
    await repo.enqueue(artifact.id, jobId, epoch, 1);
    return artifact.id;
  };
  const fullBundle = (finish: string | null) => [
    { name: 'nax-out/cost/u.jsonl', body: [costLine('c1', 0.07), costLine('c2', 0.0873, 'finish')].join('\n') },
    { name: 'nax-out/metrics.json', body: metricsJson('run-1') },
    { name: 'nax-out/review-audit/f/1-semantic.json', body: reviewJson },
    { name: 'nax-out/status.json', body: statusJson('run-1') },
    ...(finish ? [{ name: 'nax-out/finish-audit/f/run-1.result.json', body: finishJson(finish) }] : []),
  ];

  beforeAll(async () => {
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-ingest-'));
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    store = app.get<ArtifactStore>(ARTIFACT_STORE);
    ingest = app.get(BundleIngestService);
    repo = app.get<IBundleIngestRepository>(BUNDLE_INGEST_REPOSITORY);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
    if (savedDir === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = savedDir;
  });

  it('ingests rows, raises cost, corrects an escalated finish, and is idempotent (Review Focus 1)', async () => {
    const signal = jest.spyOn(app.get(BudgetEvaluator), 'signal').mockImplementation(() => undefined);
    const job = await seedJob();
    await attach(job.id, fullBundle('escalated'));
    expect(await ingest.drain(now)).toBe(1);

    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id } })).toBe(2);
    expect(await prisma.fleetStoryResult.count({ where: { jobId: job.id } })).toBe(1);
    expect(await prisma.fleetReviewResult.count({ where: { jobId: job.id } })).toBe(1);
    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.costSpentUsd.toString()).toBe('0.1573');
    expect(after).toMatchObject({ state: 'ESCALATED', stateReason: ESCALATED_FROM_AUDIT, finishResult: 'escalated', resultPrUrl: 'https://github.com/o/r/pull/1' });
    expect(await prisma.fleetActivity.count({ where: { jobId: job.id, action: 'job.verdict_corrected' } })).toBe(1);
    const row = await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row).toMatchObject({ status: 'done', files: { cost: 'done', metrics: 'done', review: 'done', finish: 'done' } });
    expect(row.ledgerCostUsd?.toString()).toBe('0.1573');
    expect(signal).toHaveBeenCalledWith(expect.arrayContaining([`project:${base.projectId}`]));

    await repo.rerunJob(job.id);
    expect(await ingest.drain(now)).toBe(1);
    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id } })).toBe(2);
    expect(await prisma.fleetActivity.count({ where: { jobId: job.id, action: 'job.verdict_corrected' } })).toBe(1);
    signal.mockRestore();
  });

  it('waits for a terminal job before ingesting', async () => {
    const job = await seedJob({ state: 'UPLOADING', finishedAt: null });
    await attach(job.id, fullBundle(null));
    expect(await ingest.drain(now)).toBe(0);
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'COMPLETED', finishedAt: now } });
    expect(await ingest.drain(now)).toBe(1);
  });

  it('marks a COMPLETED run without finish or branch as nothing pushed (#204)', async () => {
    const job = await seedJob();
    await attach(job.id, fullBundle(null));
    await ingest.drain(now);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } }))).toMatchObject({ state: 'COMPLETED', stateReason: NOTHING_PUSHED });
  });

  it('raises a PLAN job cost from its ledger (#203)', async () => {
    const job = await seedJob({ command: 'PLAN', costSpentUsd: new Prisma.Decimal(0) });
    await attach(job.id, [{ name: 'nax-out/cost/u.jsonl', body: costLine('p1', 0.0044) }]);
    await ingest.drain(now);
    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.costSpentUsd.toString()).toBe('0.0044');
    expect(after.stateReason).toBeNull();
  });

  it('an earlier attempt adds rows but never touches the job (D367, Review Focus 2)', async () => {
    const job = await seedJob({ leaseEpoch: 2, naxRunId: 'run-2' });
    await attach(job.id, fullBundle('escalated'), 1);
    await ingest.drain(now);
    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ state: 'COMPLETED', stateReason: null });
    expect(after.costSpentUsd.toString()).toBe('0.0745');
    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id, leaseEpoch: 1 } })).toBe(2);
  });

  it('a failure halfway through the write leaves nothing and backs off (Review Focus 4)', async () => {
    const job = await seedJob();
    await attach(job.id, fullBundle(null));
    const spy = jest.spyOn(repo, 'markOutcome').mockRejectedValueOnce(new Error('db went away'));
    await ingest.drain(now);
    spy.mockRestore();
    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id } })).toBe(0);
    const row = await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row).toMatchObject({ status: 'pending', attempts: 1, error: 'db went away' });
    expect(row.nextAttemptAt?.getTime()).toBe(now.getTime() + 60_000);
  });

  it('fails an expired bundle without retry, and analytics survive bundle expiry', async () => {
    const job = await seedJob();
    const artifactId = await attach(job.id, fullBundle(null));
    await ingest.drain(now);
    await prisma.fleetJobArtifact.update({ where: { id: artifactId }, data: { expiredAt: now } });
    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id } })).toBe(2);
    await repo.rerunJob(job.id);
    await ingest.drain(now);
    expect(await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'failed', error: 'bundle expired' });
  });

  it('records partial for an unknown cost schemaVersion and still ingests metrics', async () => {
    const job = await seedJob();
    await attach(job.id, [
      { name: 'nax-out/cost/u.jsonl', body: JSON.stringify({ schemaVersion: 99, callId: 'x' }) },
      { name: 'nax-out/metrics.json', body: metricsJson('run-1') },
      { name: 'nax-out/status.json', body: statusJson('run-1') },
    ]);
    await ingest.drain(now);
    expect(await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'partial', files: { cost: 'skipped:v99', metrics: 'done' } });
    expect(await prisma.fleetStoryResult.count({ where: { jobId: job.id } })).toBe(1);
  });
});
```

(`fleetActivity` is the Prisma accessor for `FleetActivity`. `FLEET_ARTIFACT_DIR` is set before `bootHttpApp`, the same
order as `fleet-log-fallback.integration.spec.ts`, because `fleetConfig.artifactDir` is read at boot.)

- [ ] **Step 8: Run it and fix until it passes**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest.integration.spec.ts src/fleet/ingest`
Expected: PASS (7 integration + all unit tests). The cost assertion `0.07 + 0.0873 = 0.1573` checks raise-to-ledger
and 4-place rounding together.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet/ingest apps/api/src/fleet/fleet.module.ts apps/api/src/fleet/activity/domain/fleet-activity.domain.ts apps/api/test/integration/fleet/fleet-ingest.integration.spec.ts
git commit -m "feat(fleet): S2b bundle ingest service, sweeper and corrections (D366-D369, D371)"
```

---

### Task 7: Enqueue on upload

**Files:**
- Modify: `apps/api/src/fleet/artifacts/bundle.service.ts:30-90`
- Modify: `apps/api/src/fleet/artifacts/artifacts.module.ts`
- Modify: `apps/api/src/fleet/artifacts/bundle.service.spec.ts` (constructor arity)
- Test: `apps/api/test/integration/fleet/fleet-bundles.integration.spec.ts` (add one case)

**Interfaces:**
- Consumes: `BUNDLE_INGEST_REPOSITORY.enqueue`, `BundleIngestService.kick/idle/drain`, `INGEST_PARSER_VERSION`.

- [ ] **Step 1: Write the failing integration case**

Append inside the top-level `describeIntegration` of `fleet-bundles.integration.spec.ts`; it uses that file's
`job(feature, state, leaseEpoch = 1)` and `upload(jobId, body)` helpers (lines 33-41). Add:

```ts
  it('enqueues ingest in the upload transaction; a re-upload resets the same row (S2b §2.1, Review Focus 1)', async () => {
    const j = await job('ingest', 'UPLOADING');
    const gz = await tarGz([{ name: 'nax-out/cost/u.jsonl', body: JSON.stringify({ ts: 0, schemaVersion: 8, agentName: 'native', model: 'm', stage: 'run', featureName: 'f', callId: 'c1', tokens: {}, costUsd: 0.01 }) }]);
    await upload(j.id, gz).expect(201);
    const first = await prisma.fleetBundleIngest.findMany({ where: { jobId: j.id } });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: 'pending', leaseEpoch: 1, parserVersion: 1 });
    await upload(j.id, gz).expect(201);
    const second = await prisma.fleetBundleIngest.findMany({ where: { jobId: j.id } });
    expect(second.map((r) => r.id)).toEqual([first[0].id]);
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'COMPLETED', finishedAt: new Date() } });
    await app.get(BundleIngestService).drain();
    expect(await prisma.fleetCostEvent.count({ where: { jobId: j.id } })).toBe(1);
  });
```

and add the imports `import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';` and
`import { tarGz } from '../../helpers/tar-gz';`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-bundles.integration.spec.ts`
Expected: FAIL — `expect(first).toHaveLength(1)` receives 0.

- [ ] **Step 3: Wire `BundleService`**

In `bundle.service.ts` add imports:

```ts
import { BundleIngestService } from '../ingest/bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository, INGEST_PARSER_VERSION } from '../ingest/domain/bundle-ingest.domain';
```

Add two constructor parameters at the end:

```ts
    @Inject(BUNDLE_INGEST_REPOSITORY) private readonly ingestRepo: Pick<IBundleIngestRepository, 'enqueue'>,
    private readonly ingest: Pick<BundleIngestService, 'kick'>,
```

Inside the `recorded` transaction, replace the `upsertArtifact` line with:

```ts
      const artifact = await this.repo.upsertArtifact({ jobId: job.id, leaseEpoch, kind: 'bundle', storageKey: key, sizeBytes: BigInt(stored.sizeBytes), sha256: stored.sha256 });
      await this.ingestRepo.enqueue(artifact.id, job.id, leaseEpoch, INGEST_PARSER_VERSION); // S2b §2.1: same transaction
```

After `this.fallback.schedule({ jobId: u.jobId, leaseEpoch, storageKey: key });` add:

```ts
    // S2b §2.1: ingest waits for a terminal job (§2.2); the kick covers the common case where the verdict lands first.
    this.ingest.kick();
```

In `artifacts.module.ts` add `import { IngestModule } from '../ingest/ingest.module';` and append `IngestModule` to
`imports`.

In `bundle.service.spec.ts` the constructor call gains two arguments: change
`new BundleService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, {} as never)` to
`new BundleService(repo as never, store as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-bundles.integration.spec.ts test/integration/fleet/fleet-log-fallback.integration.spec.ts src/fleet/artifacts`
Expected: PASS (the fallback suite proves the upload path is otherwise unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/fleet/artifacts apps/api/test/integration/fleet/fleet-bundles.integration.spec.ts
git commit -m "feat(fleet): enqueue bundle ingest in the upload transaction (S2b §2.1)"
```

---

### Task 8: Admin ingest routes

**Files:**
- Create: `apps/api/src/fleet/ingest/fleet-ingest.controller.ts`, `apps/api/src/fleet/ingest/dto/ingest-row.dto.ts`,
  `apps/api/src/fleet/ingest/dto/list-ingest.query.ts`
- Modify: `apps/api/src/fleet/ingest/ingest.module.ts` (controller + `ProjectAccessModule` not needed; admin only)
- Modify: `openapi.json`, `apps/cli/src/generated/*` (generated)
- Test: `apps/api/test/integration/fleet/fleet-ingest-api.integration.spec.ts`

**Interfaces:**
- Consumes: `IBundleIngestRepository.findPage/backfill/rerunJob/rerunOutdated`, `BundleIngestService.kick`,
  `FleetActivityService.record`, `FLEET_JOB_REPOSITORY.findById`, `INGEST_PARSER_VERSION`, `INGEST_STATUSES`.
- Produces (D370): `GET /fleet/ingest?status&current&size` -> page of `IngestRowDto`;
  `POST /fleet/ingest/backfill` -> `{ queued }`; `POST /fleet/ingest/jobs/:jobId/rerun` -> `{ queued }` (404 unknown
  job); `POST /fleet/ingest/rerun-outdated` -> `{ queued }`. All `@RequiredPermission('ADMIN')`.

- [ ] **Step 1: Write the failing API test**

```ts
/**
 * Fleet S2b slice 1a — admin ingest routes (PG), spec §2.6, D370.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet ingest admin API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let jobId: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
      },
    });
    jobId = job.id;
    await prisma.fleetJobArtifact.create({ data: { jobId, leaseEpoch: 1, kind: 'bundle', storageKey: 'jobs/x/1/a.tar.gz', sizeBytes: BigInt(1), sha256: 'a'.repeat(64) } });
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses non-admins', async () => {
    await request(server).get('/api/fleet/ingest').set(auth('dev')).expect(403);
    await request(server).post('/api/fleet/ingest/backfill').set(auth('dev')).expect(403);
  });

  it('backfills, lists, reruns one job and reruns outdated, recording activity', async () => {
    const backfill = await request(server).post('/api/fleet/ingest/backfill').set(auth('root')).expect(201);
    expect(data(backfill)).toEqual({ queued: 1 });
    const list = await request(server).get('/api/fleet/ingest?status=pending').set(auth('root')).expect(200);
    expect(data(list).records[0]).toMatchObject({ jobId, leaseEpoch: 1, status: 'pending', projectId: world.projectId });
    const rerun = await request(server).post(`/api/fleet/ingest/jobs/${jobId}/rerun`).set(auth('root')).expect(201);
    expect(data(rerun)).toEqual({ queued: 1 });
    await request(server).post('/api/fleet/ingest/jobs/nope/rerun').set(auth('root')).expect(404);
    const outdated = await request(server).post('/api/fleet/ingest/rerun-outdated').set(auth('root')).expect(201);
    expect(data(outdated)).toEqual({ queued: 0 });
    expect(await prisma.fleetActivity.count({ where: { action: { in: ['ingest.backfill', 'ingest.rerun', 'ingest.rerun_outdated'] } } })).toBe(3);
  });

  it('rejects an unknown status filter', async () => {
    await request(server).get('/api/fleet/ingest?status=bogus').set(auth('root')).expect(400);
  });
});
```

(`data(res)` unwraps the `JsonResponse` envelope, as in `fleet-admin-guards.integration.spec.ts`; a page result
carries `records`, `total`, `current`, `size`, `hasNext`, `hasPrev` — `toPageResult` in `src/common/dto/koda-page.query.ts`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-api.integration.spec.ts`
Expected: FAIL — 404 on `/api/fleet/ingest`.

- [ ] **Step 3: Implement DTOs and controller**

`apps/api/src/fleet/ingest/dto/list-ingest.query.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';
import { INGEST_STATUSES, IngestStatus } from '../domain/bundle-ingest.domain';

export class ListIngestQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: INGEST_STATUSES })
  @IsOptional()
  @IsIn(INGEST_STATUSES as unknown as string[])
  status?: IngestStatus;
}
```

`apps/api/src/fleet/ingest/dto/ingest-row.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { INGEST_STATUSES, IngestListRow, IngestStatus } from '../domain/bundle-ingest.domain';

export class IngestRowDto {
  @ApiProperty() id: string;
  @ApiProperty() jobId: string;
  @ApiProperty() leaseEpoch: number;
  @ApiProperty() projectId: string;
  @ApiProperty({ enum: INGEST_STATUSES }) status: IngestStatus;
  @ApiProperty() attempts: number;
  @ApiProperty() parserVersion: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) files: Record<string, string>;
  @ApiPropertyOptional({ nullable: true }) error: string | null;
  @ApiPropertyOptional({ nullable: true }) ingestedAt: string | null;
  @ApiProperty() updatedAt: string;

  static from(r: IngestListRow): IngestRowDto {
    return Object.assign(new IngestRowDto(), {
      ...r, ingestedAt: r.ingestedAt ? r.ingestedAt.toISOString() : null, updatedAt: r.updatedAt.toISOString(),
    });
  }
}

export class IngestQueuedDto {
  @ApiProperty() queued: number;
}
```

`apps/api/src/fleet/ingest/fleet-ingest.controller.ts`:

```ts
import { Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { parseQuery, remapPage, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { BundleIngestService } from './bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository, INGEST_PARSER_VERSION } from './domain/bundle-ingest.domain';
import { IngestQueuedDto, IngestRowDto } from './dto/ingest-row.dto';
import { ListIngestQuery } from './dto/list-ingest.query';

/** Fleet S2b (d) §2.6, D370: ingest health and re-runs (global admin). */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/ingest')
export class FleetIngestController {
  constructor(
    @Inject(BUNDLE_INGEST_REPOSITORY) private readonly repo: IBundleIngestRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById'>,
    private readonly ingest: BundleIngestService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'List bundle ingest rows (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of IngestRowDto' })
  async list(@Query() rawQuery: ListIngestQuery) {
    const q = parseQuery(ListIngestQuery, rawQuery);
    const page = await this.repo.findPage({ status: q.status }, { current: q.current, size: q.size });
    return JsonResponse.Ok(toPageResult(remapPage(page, IngestRowDto.from)));
  }

  @Post('backfill')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Queue every unexpired bundle that has no ingest row (global admin)' })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  async backfill(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.queue(principal.id, 'ingest.backfill', 'ingest', 'all', null, () => this.repo.backfill(INGEST_PARSER_VERSION)));
  }

  @Post('jobs/:jobId/rerun')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: "Re-ingest a job's bundles (global admin)" })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  async rerunJob(@Param('jobId') jobId: string, @Principal() principal: KodaPrincipal) {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundAppException({}, 'fleet.jobs');
    return JsonResponse.Ok(await this.queue(principal.id, 'ingest.rerun', 'job', job.id, job.projectId, () => this.repo.rerunJob(job.id)));
  }

  @Post('rerun-outdated')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Re-ingest bundles ingested by an older parser version (global admin)' })
  @ApiResponse({ status: 201, type: IngestQueuedDto })
  async rerunOutdated(@Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.queue(principal.id, 'ingest.rerun_outdated', 'ingest', 'all', null, () => this.repo.rerunOutdated(INGEST_PARSER_VERSION)));
  }

  private async queue(
    actorId: string, action: string, entityType: 'ingest' | 'job', entityId: string, projectId: string | null, run: () => Promise<number>,
  ): Promise<{ queued: number }> {
    const queued = await this.txManager.run(async () => {
      const n = await run();
      await this.activity.record({
        actorType: 'USER', actorId, action, entityType, entityId, jobId: entityType === 'job' ? entityId : null, projectId,
        responsibleUserId: actorId, payload: { queued: n, parserVersion: INGEST_PARSER_VERSION },
      });
      return n;
    });
    this.ingest.kick();
    return { queued };
  }
}
```

In `ingest.module.ts` add `controllers: [FleetIngestController]` (import it). `FleetActivityModule` is already imported.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-api.integration.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Regenerate the contract and run the OpenAPI contract spec**

Run: `bun run generate` (repo root), then `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts`
Expected: `openapi.json` gains the four `/fleet/ingest` operations; the contract spec passes (update its expected
operation list if it enumerates fleet operations).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/ingest openapi.json apps/cli/src/generated apps/api/test/integration/fleet/fleet-ingest-api.integration.spec.ts apps/api/src/fleet/fleet-openapi.contract.spec.ts
git commit -m "feat(fleet): S2b admin ingest routes: list, backfill, rerun (D370)"
```

---

### Task 9: Docs, full verification, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md` (D365, D370 corrections)
- Modify: `.nax/mono/apps/api/context.md`, then regenerate agent files

- [ ] **Step 1: Apply the spec corrections**

In the spec, §2.3 bullet "Untrusted input": replace "validated with a zod schema chosen by `schemaVersion`" with
"validated by the typed field readers in `src/fleet/ingest/parsers/fields.ts` (plan D365), chosen by
`schemaVersion`". In §2.6 and §4.3 replace the route list with the D370 routes (`GET /fleet/ingest`,
`POST /fleet/ingest/backfill`, `POST /fleet/ingest/jobs/:jobId/rerun`, `POST /fleet/ingest/rerun-outdated`) and note
"admin analytics routes in slice 1b use `fleet/analytics/...` + `RequiredPermission('ADMIN')`".

- [ ] **Step 2: Document the module in the API context**

Append to `.nax/mono/apps/api/context.md` under its fleet section:

```markdown
- `src/fleet/ingest/` (S2b): parses uploaded run bundles of terminal jobs into `FleetCostEvent`, `FleetStoryResult`
  and `FleetReviewResult` rows (kept forever), and corrects the job: cost raised to the ledger total, COMPLETED ->
  ESCALATED from finish-audit, "nothing pushed" reason. The queue is `FleetBundleIngest` (enqueued in the bundle
  upload transaction, drained by a kick plus a 30 s sweeper gated by `FLEET_SWEEP_ENABLED`). Bundle contents are
  untrusted: only allowlisted paths, capped sizes, typed field readers. Admin routes: `fleet/ingest`.
```

Run: `nax generate` (repo root), then confirm only generated agent files changed besides the context file.

- [ ] **Step 3: Full verification**

Run, from the repo root and `apps/api`:

```bash
bun run lint
bun run type-check
cd apps/api && bun run test:unit && bun run test:db:up && bun run test:scoped test/integration/fleet
```

Expected: all green. Fix any failure before continuing.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/superpowers/specs/2026-10-04-fleet-s2b-d-analytics-design.md .nax AGENTS.md CLAUDE.md GEMINI.md codex.md apps/*/AGENTS.md apps/*/CLAUDE.md apps/*/GEMINI.md apps/*/codex.md
git commit -m "docs(fleet): S2b ingest spec corrections (D365, D370) and api context"
git push -u origin feat/fleet-s2b-analytics
gh pr create --title "feat(fleet): S2b slice 1a — bundle ingestion and job corrections (D365-D375)" --body "$(cat <<'EOF'
## Summary
- New `src/fleet/ingest/`: bundles of terminal jobs are parsed into indefinitely kept cost, story and review rows (spec §1-§2).
- Ingest corrects the job: cost raised to the ledger total (#203, nax#2348), COMPLETED -> ESCALATED from finish-audit, "nothing pushed" reason (#204).
- Admin routes `fleet/ingest` (list, backfill, rerun job, rerun outdated).

## Test plan
- [ ] Unit: reader, parsers, corrections, service retry
- [ ] Integration (PG): schema, repository (SKIP LOCKED claim, stale claim), ingest end to end, upload enqueue, admin API
- [ ] After deploy to koda-wk: `POST /api/fleet/ingest/backfill`; PLAN job cost no longer $0; finish-escalated job ESCALATED with its PR; finish-disabled job "nothing pushed"
EOF
)"
```

---

## Self-review notes

- Spec §1.1-1.4 -> Task 1; §1.5 + §3 -> Task 4 + Task 6; §2.1 -> Tasks 6-7; §2.2 -> Task 5; §2.3 -> Tasks 2-3; §2.4 ->
  Task 6; §2.5 -> Task 6; §2.6 + §4.3 (ingest routes) -> Tasks 5 and 8; §6 parser and ingest rows -> Tasks 2-8.
  §4.1-4.2, §4.3 analytics/delete routes, §4.4 CLI, §5 web are slices 1b/2 by design.
- Review Focus: 1 -> Tasks 5 and 7; 2 -> Tasks 4 and 6; 3 -> Tasks 2 and 3; 4 -> Task 6; 5 -> Task 5.
