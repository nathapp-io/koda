# Fleet S1b Slice 2a — Budgets Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins can cap what a fleet scope (global, project, repo, runner) spends per UTC month or lifetime. When a
scope reaches its amount, no new job in it is dispatched or assigned, its QUEUED jobs are cancelled, and (with
`runningJobs: cancel`) its running jobs are asked to stop. An admin sees why a scope is paused and resumes it,
optionally raising the amount. API and CLI only; the web pages are slice 2b.

**Architecture:** Two new tables (`BudgetPolicy`, `BudgetIncident`) and three `FleetJob` columns
(`costCarriedUsd`, `firstStartedAt`, `cancelReason`). A pure rules module (`budget-rules.ts`) owns window math,
scope keys and the "effectively paused" rule. A small `BudgetStoreModule` (repository + `BudgetGate`) is imported by
the jobs module, so dispatch, requeue and both placement entry points can refuse or cancel work in a paused scope.
A `BudgetsModule` holds the `BudgetEvaluator` (signalled after each sync that changed a job's cost, debounced per
scope key), the 60 s `BudgetSweeper`, the management service and the two controllers. `FleetJobsService` gains
`cancelForBudget`.

**Tech Stack:** NestJS + Prisma 6 (PostgreSQL) + Jest (API), commander 12 + Jest (CLI), Nuxt 3 i18n (one web
label).

**Spec:** `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` §2.1-§2.4 (the 2a parts), §2.5
(2a tests), §4 (error codes, i18n, webhooks, activity, migrations, OpenAPI). Rulings B1, B2, B3, B7, B8.

## Global Constraints

- Window start: `calendar_month_utc` = first instant of the current **UTC** month; `lifetime` = no lower bound.
- Window spend = `SUM(costSpentUsd + costCarriedUsd)` over jobs in scope with `firstStartedAt >= windowStart`
  (lifetime: every job in scope). Scope filters: global = all jobs; project = `projectId`; repo = `repoId`;
  runner = `runnerId`.
- Money is `Decimal(12,4)` in the database and a decimal **string** in records and DTO responses; all comparisons use
  `Prisma.Decimal`, never JS floats.
- Warn when `warnPercent` is set and spend `>= amountUsd * warnPercent / 100`; hard stop when `hardStop` is on, the
  policy is not effectively paused and spend `>= amountUsd`.
- A policy is **effectively paused** when `pausedAt` is set and, for `calendar_month_utc`, `pausedWindowStart`
  equals the current window start.
- `warnPercent` in the create DTO: omitted = `80`; explicit `null` = no warn; on update, omitted = unchanged.
  Range 1-99.
- Incident uniqueness: `(policyId, kind, windowStart, amountUsd)` for `warn` and `hard_stop` only (partial unique
  index, raw SQL in the migration and in `PARTIAL_UNIQUE_INDEXES`).
- Stop reason string: `budget:<policyId>` (job `stateReason` and `cancelReason`).
- Error codes (i18n prefixes): `fleet.budgetPaused` (409), `fleet.budgetAmountNotAboveSpend` (400, code `-2`),
  plus `fleet.budgets` (404/409), `fleet.budgetInput` (400, `-2`), `fleet.budgetNotPaused` (409). Every key in
  both `apps/api/src/i18n/en/fleet.json` and `.../zh/fleet.json`.
- Webhooks `fleet.budget.warn` and `fleet.budget.hard_stop` go through
  `WebhookDispatcherService.dispatch(projectId, event, payload)` inside the evaluating transaction, only for policies
  with a `projectId` (project and repo scopes).
- Every policy mutation, resume, rollover, warn, hard stop and orphan delete writes a `FleetActivity` row with
  `entityType: 'budget'`, `projectId` set for project and repo policies. Automatic rows use `actorType: 'SYSTEM'`,
  `actorId: 'system'` and `responsibleUserId` = the policy's `updatedById`.
- `FleetActivityService.record` **throws** when a payload key matches `/token|secret|key|password|credential/i`.
  Never put `scopeKey` (or any `*Key`) in an activity payload; use `scopeType` and `scopeId`.
- Evaluator and sweeper are in-process (single API instance); the sweeper is gated by `fleetConfig.sweepEnabled`
  and `unref()`s its timer, like `FleetSweeper`.
- The sync transaction runs no budget queries; the evaluator is signalled **after** `txManager.run` returns.
- Live events and runner wake-ups collected inside a transaction are published only after it commits.
- `txManager.run` joins an outer transaction when one is open (ALS); a unique violation inside a Prisma interactive
  transaction aborts it, so idempotent inserts use `INSERT ... ON CONFLICT DO NOTHING`.
- API tests: `cd apps/api && bun run test:scoped <paths>` (paths relative to `apps/api`; unit specs need no DB;
  integration specs need `bun run test:db:up` and set `KODA_DB_TESTS=1` themselves through the wrapper). Never
  `bun run test:unit -- <path>`: the script's `--testPathIgnorePatterns` swallows the path and runs the whole suite.
  CLI: `cd apps/cli && bun run test -- <path>`. Web: `cd apps/web && bun run test -- <path>`. Never run bare
  `bun test` at the repo root.
- `bun run generate` (repo root) needs `apps/api/.env`; in a fresh worktree copy it from the main checkout, or
  `api:export-spec` exits 1 with no message. `apps/cli/src/generated` is gitignored; commit only `openapi.json`.
- No emojis in source; no `console.log` in API source (the CLI prints with `console.log` by design).

## Decisions

| # | Decision | Why |
|:--|:--|:--|
| D154 | Error arguments reach clients only through the translated message: an `AppException` answers `{ ret, message }` with `args` interpolated into the i18n template. The `fleet.budgetPaused` args are `{ policyId, scopeType, scopeId, scope }` (`scope` = `global` or `<scopeType>:<scopeId>`) and the message reads "The fleet budget for {scope} is paused (policy {policyId})"; tests assert on `res.body.message`. | The spec asks for `{ policyId, scopeType, scopeId }` in the body; this is the only carrier the exception filter has. A structured body would need a new filter, out of scope. |
| D155 | `lifetime` uses the epoch (`1970-01-01T00:00:00.000Z`) as its window start in incidents and in `pausedWindowStart`. | Both columns are non-null in one case and need one stable value; the epoch is before every job. |
| D156 | When a runner reports `CANCELLED` and the job has a `cancelReason`, the transition's `stateReason` is the `cancelReason`, whatever reason the runner sent. | The runner sends `null` or the generic `cancelled before start`; the budget reason is the useful one, and the spec's test wants `budget:<policyId>` as the final reason. |
| D157 | `cancelForBudget` takes QUEUED jobs (server `CANCELLED`), never-acked ASSIGNED jobs (server `CANCELLED`, as `cancel()` does), and acked ASSIGNED or RUNNING jobs (`cancelReason` + `cancelRequestedAt` + one `CANCEL`). UPLOADING and finished jobs, and jobs with a cancel already pending, are skipped. It runs inside the caller's transaction and returns live events and runner ids to wake. | One method for every budget cancel keeps the epoch and command rules in `FleetJobsService`. A CANCEL to a runner that has not taken the ASSIGN is what `cancel()` already avoids. UPLOADING means nax has finished; the spec names only ASSIGNED and RUNNING. |
| D158 | Placement reads one `PauseSnapshot` (all effectively paused policies) per transaction and matches keys in memory. | `fillRunner` scans up to 50 jobs; one query instead of 50. |
| D159 | `PlacementRunner.budgetPaused` is optional (absent = not paused); `PlacementService` fills it from the snapshot. | The repository's `PlacementRunnerRow` and the sweeper's use of it stay unchanged. |
| D160 | Modules: `BudgetStoreModule` (repository + `BudgetGate`) is imported by `FleetJobsModule`; `BudgetsModule` (evaluator, sweeper, service, controllers) imports `FleetJobsModule` and `WebhookModule`; `SyncModule` imports `BudgetsModule` for the signal. | Dispatch and placement need the gate, and the evaluator needs `FleetJobsService`: a single module would be a cycle. |
| D161 | A policy's scope and window are fixed after create; `PATCH` changes `amountUsd`, `warnPercent`, `hardStop`, `runningJobs`. | The unique key is `(scopeKey, windowKind)`; moving it would orphan incidents. Delete and create instead. |
| D162 | Admin routes act only on global and runner policies; project routes only on that project's project and repo policies. Any other policy id answers 404 `fleet.budgets`. Global admins edit project policies through the project routes (their project role resolves to `ADMIN`). | One owner route per policy keeps the B3 permission check in one place. |
| D163 | Policy lists are plain arrays, not pages. | At most two policies (one per window kind) exist per scope. |
| D164 | Resume on a policy with `pausedAt` null answers 409 `fleet.budgetNotPaused`. A stale monthly pause (not effective) can be resumed, which clears it early. | Resuming nothing is a client mistake worth telling; clearing a stale pause is harmless. |
| D165 | After create and update the service signals the policy's scope key, so a new or lowered amount takes effect within about 1 s. | Otherwise it waits for the 60 s sweep. |
| D166 | A soft-deleted project (`deletedAt` set) counts as a gone scope: its policies are ignored and the sweep deletes them. | The project no longer exists for users. |
| D167 | The migration backfills `firstStartedAt = startedAt` where `startedAt` is set. | Jobs that already ran then count in the window they last started in; the true first start was never recorded. |
| D168 | A warn also writes a `budget.warn` activity row. | The admin page (2b) and `fleet/activity` show it; the spec lists warn under incidents and webhooks only. |
| D169 | CLI `koda fleet budget set` upserts by (scope, window) on the route the scope belongs to (global and runner: admin routes; project and repo: project routes). Hard stop is `--hard-stop on|off` (commander's `--no-` form cannot tell "not given" on an update). Amounts use a new `parseBudgetUsd` (up to 1,000,000). | `set` reads as "make it so"; the CLI picks create or update. `parseUsd` caps at 10,000 for `--max-cost`. |
| D170 | A placement-time budget cancel is recorded by its `job.cancelled` transition row (reason `budget:<policyId>`); a hard stop writes one `budget.hard_stop` row listing `cancelledJobIds` and `cancelRequestedJobIds`. | The transition row already names the policy; one summary row per stop keeps activity readable. |
| D171 | 2a ships the web `budget_paused` misfit type and label (en, zh) only. | The dispatch placement result already renders misfits by key; without the label it shows a raw key. Pages are 2b. |
| D172 | Runner-scope spend follows the job's current `runnerId` (spec): a requeued job's carried spend counts for the runner that ran it last. | Spec-defined; noted so a reviewer does not "fix" it. |

## Review Focus

1. Decimal edges: spend `0.1 + 0.2` against an amount of `0.3` must hard-stop, and `amount * warnPercent / 100`
   with a non-terminating quotient must compare exactly. (Task 3 "decimal thresholds".)
2. A server running in a non-UTC zone at 23:30 local on the last day of a month: the window is still the UTC month.
   (Task 3 "UTC month".)
3. A debounced signal and the sweep evaluating the same policy at once: one `hard_stop` incident, one webhook outbox
   row, the jobs cancelled once. (Task 8 "concurrent evaluations".)
4. An admin lowers a policy's amount below the current spend: the scope pauses within a second, and a resume without
   a new amount is refused with 400. (Task 10 "lowered amount".)
5. The runner a runner policy names is deleted: dispatch is not blocked by the leftover policy, and the sweep deletes
   it with its incidents. (Task 9 "orphan".)

---
### Task 1: Schema, migration and the new `FleetJob` fields

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`FleetJob`, `FleetActivity` comment; new `BudgetPolicy`, `BudgetIncident`)
- Create: `apps/api/prisma/migrations/20261002090000_fleet_budgets/migration.sql`
- Modify: `apps/api/test/helpers/partial-indexes.ts`
- Modify: `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts` (`FleetJobRecord`, `Mutable`)
- Modify: `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts` (`toJob`, `update`)
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts`
  (record literals)
- Test: `apps/api/test/integration/fleet/fleet-budgets-schema.integration.spec.ts`

**Interfaces:**
- Produces: Prisma models `BudgetPolicy`, `BudgetIncident` (client `prisma.budgetPolicy`, `prisma.budgetIncident`);
  `FleetJobRecord.costCarriedUsd: string`, `.firstStartedAt: Date | null`, `.cancelReason: string | null`, all
  three in `FleetJobPatch`; `PARTIAL_UNIQUE_INDEXES` gains the `BudgetIncident_threshold_key` statement.

- [ ] **Step 1: Write the failing schema test**

Create `apps/api/test/integration/fleet/fleet-budgets-schema.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 2a — budget tables and the FleetJob spend columns (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budgets-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet budgets schema (PG)', () => {
  const prisma = new PrismaClient();
  const WINDOW = new Date('2026-10-01T00:00:00.000Z');

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const policy = (scopeKey: string, windowKind = 'calendar_month_utc') => prisma.budgetPolicy.create({
    data: {
      scopeType: 'global', scopeKey, windowKind, amountUsd: new Prisma.Decimal('10'), createdById: 'u1', updatedById: 'u1',
    },
  });
  const incident = (policyId: string, kind: string, amountUsd = '10') => prisma.budgetIncident.create({
    data: { policyId, kind, windowStart: WINDOW, spentUsd: new Prisma.Decimal('8'), amountUsd: new Prisma.Decimal(amountUsd) },
  });

  it('defaults a policy to warn-less hard stop with finish, and refuses a second policy for the same scope and window', async () => {
    const p = await policy('global');
    expect(p).toEqual(expect.objectContaining({ warnPercent: null, hardStop: true, runningJobs: 'finish', pausedAt: null, pausedWindowStart: null }));
    await expect(policy('global')).rejects.toMatchObject({ code: 'P2002' });
    await expect(policy('global', 'lifetime')).resolves.toBeDefined();
  });

  it('keeps one warn and one hard_stop per (policy, window, amount), any number of resumed rows', async () => {
    const p = await policy('project:p-1');
    await incident(p.id, 'warn');
    await expect(incident(p.id, 'warn')).rejects.toMatchObject({ code: 'P2002' });
    await expect(incident(p.id, 'warn', '20')).resolves.toBeDefined();
    await incident(p.id, 'hard_stop');
    await expect(incident(p.id, 'hard_stop')).rejects.toMatchObject({ code: 'P2002' });
    await incident(p.id, 'resumed');
    await expect(incident(p.id, 'resumed')).resolves.toBeDefined();
  });

  it('deletes incidents with their policy', async () => {
    const p = await policy('repo:r-1');
    await incident(p.id, 'resumed');
    await prisma.budgetPolicy.delete({ where: { id: p.id } });
    expect(await prisma.budgetIncident.count({ where: { policyId: p.id } })).toBe(0);
  });

  it('gives FleetJob zero carried spend, no first start and no cancel reason by default', async () => {
    const base = await seedFleetBase(prisma);
    const job = await prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId,
      },
    });
    expect(job.costCarriedUsd.toString()).toBe('0');
    expect(job.firstStartedAt).toBeNull();
    expect(job.cancelReason).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budgets-schema.integration.spec.ts`
Expected: FAIL at compile time (`Property 'budgetPolicy' does not exist on type 'PrismaClient'`).

- [ ] **Step 3: Edit the Prisma schema**

In `apps/api/prisma/schema.prisma`, inside `model FleetJob`, after the `storiesTruncated` line:

```prisma
  costCarriedUsd    Decimal   @default(0) @db.Decimal(12, 4) // S1b §2.1: spend of earlier attempts, kept across requeue
  firstStartedAt    DateTime? // S1b §2.1: first RUNNING; set once, never cleared; the job's budget window
  cancelReason      String? // S1b §2.2: why the server asked for the cancel, e.g. budget:<policyId>
```

and after `@@index([projectId, queuedAt])`:

```prisma
  @@index([projectId, firstStartedAt])
  @@index([repoId, firstStartedAt])
  @@index([runnerId, firstStartedAt])
```

In `model FleetActivity`, change the `entityType` comment to `// runner | enrollment | repo | job | budget | schedule`
and the `projectId` comment to `// set on job rows and on project/repo budget rows`.

Append two models after `model FleetActivity { ... }`:

```prisma
/// S1b §2.1 C1 budget policy. scopeId is polymorphic (project, repo or runner id): no foreign key.
model BudgetPolicy {
  id                String    @id @default(cuid())
  scopeType         String // global | project | repo | runner
  scopeId           String? // null for global
  scopeKey          String // 'global' or '<scopeType>:<scopeId>'
  projectId         String? // owning project for project and repo scopes; null for global and runner
  windowKind        String // calendar_month_utc | lifetime
  amountUsd         Decimal   @db.Decimal(12, 4)
  warnPercent       Int? // 1-99; null = no warn
  hardStop          Boolean   @default(true)
  runningJobs       String    @default("finish") // finish | cancel
  pausedAt          DateTime?
  pausedWindowStart DateTime? // window the pause belongs to; the epoch for lifetime (plan D155)
  createdById       String
  updatedById       String
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  incidents BudgetIncident[]

  @@unique([scopeKey, windowKind])
  @@index([projectId])
}

/// S1b §2.1. Partial unique (policyId, kind, windowStart, amountUsd) WHERE kind IN ('warn', 'hard_stop') is raw SQL.
model BudgetIncident {
  id          String   @id @default(cuid())
  policyId    String
  kind        String // warn | hard_stop | resumed | window_reset
  windowStart DateTime
  spentUsd    Decimal  @db.Decimal(12, 4)
  amountUsd   Decimal  @db.Decimal(12, 4)
  actorId     String?
  approvalId  String? // C8 (S1.5); null until then
  createdAt   DateTime @default(now())

  policy BudgetPolicy @relation(fields: [policyId], references: [id], onDelete: Cascade)

  @@index([policyId, createdAt])
}
```

Run: `cd apps/api && bunx prisma format && bunx prisma generate`
Expected: both succeed.

- [ ] **Step 4: Generate the migration, then append the backfill and the partial index**

The test Postgres must be up (`cd apps/api && bun run test:db:up`). Use a scratch shadow database so concurrent test
runs are not disturbed:

```bash
docker exec koda-postgres-test-1 psql -U koda -d postgres -c 'CREATE DATABASE koda_shadow'
cd apps/api
bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://koda:koda@localhost:5433/koda_shadow --script > "$TMPDIR/fleet_budgets.sql"
mkdir -p prisma/migrations/20261002090000_fleet_budgets
{ echo '-- S1b slice 2a: budget policies and incidents; carried spend, first start and cancel reason on FleetJob.'; cat "$TMPDIR/fleet_budgets.sql"; } \
  > prisma/migrations/20261002090000_fleet_budgets/migration.sql
```

Check the generated file: it adds the three `FleetJob` columns, creates `BudgetPolicy` and `BudgetIncident`, the
unique and plain indexes, and the `BudgetIncident_policyId_fkey` foreign key with `ON DELETE CASCADE`. It must not
drop anything; if it does, the schema edit is wrong — fix the schema, not the SQL.

Append to the end of `migration.sql`:

```sql

-- Plan D167: a job that already ran counts in the window it last started in (the first start was never recorded).
UPDATE "FleetJob" SET "firstStartedAt" = "startedAt" WHERE "startedAt" IS NOT NULL;

-- S1b §2.1: one warn and one hard_stop per (policy, window, amount); prisma db push cannot express this.
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetIncident_threshold_key" ON "BudgetIncident" ("policyId", "kind", "windowStart", "amountUsd") WHERE "kind" IN ('warn', 'hard_stop');
```

Verify the migration reproduces the schema, then drop the scratch database:

```bash
cd apps/api && bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://koda:koda@localhost:5433/koda_shadow --exit-code
docker exec koda-postgres-test-1 psql -U koda -d postgres -c 'DROP DATABASE koda_shadow'
```

Expected: `No difference detected.` (Prisma ignores partial indexes in a diff, as it does for the existing
`FleetJob_active_repo_feature_key`.)

- [ ] **Step 5: Replay the partial index in tests**

In `apps/api/test/helpers/partial-indexes.ts`, add a second element to `PARTIAL_UNIQUE_INDEXES`, copied verbatim
from the migration without the trailing `;`:

```ts
  `CREATE UNIQUE INDEX IF NOT EXISTS "BudgetIncident_threshold_key" ON "BudgetIncident" ("policyId", "kind", "windowStart", "amountUsd") WHERE "kind" IN ('warn', 'hard_stop')`,
```

Run: `cd apps/api && bun run test:scoped test/unit/fleet/partial-indexes.spec.ts`
Expected: PASS (2 cases).

- [ ] **Step 6: Run the schema test**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budgets-schema.integration.spec.ts`
Expected: PASS (4 cases).

- [ ] **Step 7: Carry the new columns in the job record**

In `apps/api/src/fleet/jobs/domain/fleet-job.domain.ts`, in `FleetJobRecord` after `costSpentUsd: string;`:

```ts
  /** Decimal as string. Spend of earlier attempts, added by requeue (S1b §2.1). */
  costCarriedUsd: string;
  /** First RUNNING; never cleared. The job's budget window (S1b §2.1). */
  firstStartedAt: Date | null;
  /** Why the server asked for the cancel (`budget:<policyId>`); becomes stateReason (plan D156). */
  cancelReason: string | null;
```

Extend `Mutable` with `| 'costCarriedUsd' | 'firstStartedAt' | 'cancelReason'`.

In `apps/api/src/fleet/jobs/prisma-fleet-job.repository.ts`, `toJob` gains
`costCarriedUsd: r.costCarriedUsd.toString(),` after `costSpentUsd`. In `update`, destructure `costCarriedUsd` with
the others and add, after the `costSpentUsd` line:

```ts
      ...(costCarriedUsd !== undefined ? { costCarriedUsd: new Prisma.Decimal(costCarriedUsd) } : {}),
```

so the destructuring line reads
`const { bumpEpoch, costSpentUsd, costCarriedUsd, progress, stories, ...rest } = patch;`.

- [ ] **Step 8: Update the record literals**

In every `FleetJobRecord` literal in `apps/api/src/fleet/jobs/job-transitions.service.spec.ts` (the `job()` factory)
and `apps/api/src/fleet/jobs/dto/fleet-job.dto.spec.ts` (both records), add
`costCarriedUsd: '0', firstStartedAt: null, cancelReason: null,` right after the `costSpentUsd` entry. Find any other
literal with `grep -rn "storiesTruncated:" apps/api/src apps/api/test` and update it the same way.

The job DTO does not gain these fields in 2a (no client reads them yet).

- [ ] **Step 9: Type-check and run the touched unit specs**

Run: `cd apps/api && bun run type-check && bun run test:scoped src/fleet/jobs/job-transitions.service.spec.ts src/fleet/jobs/dto/fleet-job.dto.spec.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma apps/api/test/helpers/partial-indexes.ts apps/api/src/fleet/jobs \
  apps/api/test/integration/fleet/fleet-budgets-schema.integration.spec.ts
git commit -m "feat(fleet): budget tables and FleetJob carried spend, first start and cancel reason"
```

### Task 2: Job lifecycle — first start, carried spend, cancel reason

**Files:**
- Modify: `apps/api/src/fleet/jobs/job-transitions.service.ts` (`apply`)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts` (`requeue`)
- Modify: `apps/api/src/fleet/sync/job-report.processor.ts` (`applyOne`)
- Create: `apps/api/src/fleet/budgets/money.ts`
- Test: `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, `apps/api/src/fleet/budgets/money.spec.ts`,
  `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`,
  `apps/api/test/integration/fleet/fleet-budget-lifecycle.integration.spec.ts`

**Interfaces:**
- Consumes: `FleetJobRecord.costCarriedUsd`, `.firstStartedAt`, `.cancelReason` (Task 1).
- Produces: `addUsd(a: string, b: string): string` in `apps/api/src/fleet/budgets/money.ts` (4-decimal string);
  transitions set `firstStartedAt` on the first RUNNING; requeue sets `costCarriedUsd += costSpentUsd`,
  `costSpentUsd = '0'`, `cancelReason = null`; a runner `CANCELLED` report on a job with `cancelReason` uses it as
  `stateReason`.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/api/src/fleet/budgets/money.spec.ts`:

```ts
import { addUsd } from './money';

describe('addUsd', () => {
  it('adds decimal strings exactly and keeps four decimals', () => {
    expect(addUsd('0.1', '0.2')).toBe('0.3000');
    expect(addUsd('1.2345', '0')).toBe('1.2345');
    expect(addUsd('99999999.9999', '0.0001')).toBe('100000000.0000');
  });
});
```

In `apps/api/src/fleet/jobs/job-transitions.service.spec.ts`, add inside the `describe`:

```ts
  it('sets firstStartedAt on the first RUNNING only (S1b §2.1)', async () => {
    await svc.apply({ job: job(), to: 'RUNNING', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(repo.update).toHaveBeenLastCalledWith('j1', expect.objectContaining({ startedAt: NOW, firstStartedAt: NOW }));
    const earlier = new Date('2026-09-01T00:00:00.000Z');
    await svc.apply({ job: job({ firstStartedAt: earlier }), to: 'RUNNING', by: 'runner', now: NOW, actor: { type: 'RUNNER', id: 'run-1' } });
    expect(repo.update.mock.calls[1][1]).not.toHaveProperty('firstStartedAt');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/money.spec.ts src/fleet/jobs/job-transitions.service.spec.ts`
Expected: FAIL (`Cannot find module './money'`; the transitions case: `firstStartedAt` missing from the patch).

- [ ] **Step 3: Implement `addUsd` and the first start**

Create `apps/api/src/fleet/budgets/money.ts`:

```ts
import { Prisma } from '@prisma/client';

/** Exact decimal sum of two USD strings, as the 4-decimal string the Decimal(12,4) columns hold. */
export function addUsd(a: string, b: string): string {
  return new Prisma.Decimal(a).add(b).toFixed(4);
}
```

In `apps/api/src/fleet/jobs/job-transitions.service.ts` `apply`, replace
`...(to === 'RUNNING' ? { startedAt: now } : {}),` with:

```ts
      // S1b §2.1: firstStartedAt is the job's budget window; set once, never cleared (not even by requeue).
      ...(to === 'RUNNING' ? { startedAt: now, ...(job.firstStartedAt ? {} : { firstStartedAt: now }) } : {}),
```

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/money.spec.ts src/fleet/jobs/job-transitions.service.spec.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing requeue integration test**

In `apps/api/test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`, add:

```ts
  it('carries the attempt spend into costCarriedUsd on requeue and keeps firstStartedAt (S1b §2.1)', async () => {
    const runner = await insertRunner(prisma);
    const first = new Date('2026-10-01T08:00:00.000Z');
    const job = await insertJob('rq-carry', {
      state: 'FAILED', runnerId: runner.id, leaseEpoch: 1, costSpentUsd: 1.25, costCarriedUsd: 0.5,
      firstStartedAt: first, startedAt: new Date(), finishedAt: new Date(), cancelReason: 'budget:old',
    });
    await post('dev', job.id, 'requeue').expect(200);
    const after = await reload(job.id);
    expect(after.costSpentUsd.toString()).toBe('0');
    expect(after.costCarriedUsd.toString()).toBe('1.75');
    expect(after.firstStartedAt).toEqual(first);
    expect(after.cancelReason).toBeNull();
  });
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
Expected: FAIL (`costCarriedUsd` stays `0.5`).

- [ ] **Step 5: Carry the spend in `requeue`**

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts` add `import { addUsd } from '../budgets/money';` and, in the
`requeue` transition's `extra`, replace `costSpentUsd: '0',` with:

```ts
            // S1b §2.1: requeue keeps spend; the attempt's cost moves into costCarriedUsd.
            costSpentUsd: '0', costCarriedUsd: addUsd(current.costCarriedUsd, current.costSpentUsd), cancelReason: null,
```

(`firstStartedAt` is deliberately not in the list.)

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing sync test for the first start and the cancel reason**

Create `apps/api/test/integration/fleet/fleet-budget-lifecycle.integration.spec.ts`:

```ts
/* eslint-disable @typescript-eslint/no-non-null-assertion -- commands are asserted present before use */
/**
 * Fleet S1b slice 2a — budget-related job fields through the real sync path (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-lifecycle.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('fleet budget lifecycle fields (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));
  const dispatch = async (feature: string) =>
    data<{ job: { id: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
        .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;
  const job = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const startRunning = async (feature: string) => {
    const j = await dispatch(feature);
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN')!;
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }],
    });
    return j;
  };
  // The runner has capacity 1: free it between cases so each dispatch is assigned at once.
  const finishAll = () => prisma.fleetJob.updateMany({ where: { state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'COMPLETED' } });

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '200';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'box-1');
  });
  afterEach(async () => {
    await finishAll();
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = saved;
  });

  it('stamps firstStartedAt when the runner reports RUNNING', async () => {
    const j = await startRunning('first-start');
    const row = await job(j.id);
    expect(row.state).toBe('RUNNING');
    expect(row.firstStartedAt).not.toBeNull();
    expect(row.firstStartedAt).toEqual(row.startedAt);
  });

  it('uses the server cancelReason as the final stateReason when the runner reports CANCELLED (plan D156)', async () => {
    const j = await startRunning('cancel-reason');
    await prisma.fleetJob.update({ where: { id: j.id }, data: { cancelReason: 'budget:pol-1', cancelRequestedAt: new Date() } });
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 2, type: 'state', payload: { to: 'CANCELLED', reason: null } }] }] });
    expect(await job(j.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: 'budget:pol-1' }));
  });

  it('keeps the runner reason for a cancel without a server reason', async () => {
    const j = await startRunning('cancel-plain');
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 2, type: 'state', payload: { to: 'CANCELLED', reason: 'cancelled before start' } }] }] });
    expect(await job(j.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: 'cancelled before start' }));
  });
});
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-lifecycle.integration.spec.ts`
Expected: the first and third cases PASS (Step 3 already sets `firstStartedAt`); the second FAILS with
`stateReason: null`.

- [ ] **Step 7: Prefer the server's cancel reason**

In `apps/api/src/fleet/sync/job-report.processor.ts` `applyOne`, inside the `transition` branch, replace
`reason: effect.reason,` with `reason: cancelReasonFor(job, effect.to, effect.reason),` and add above the class:

```ts
/** Plan D156: a server-requested cancel keeps its reason (e.g. `budget:<policyId>`) over the runner's. */
function cancelReasonFor(job: FleetJobRecord, to: string, reported: string | null): string | null {
  return to === 'CANCELLED' && job.cancelReason ? job.cancelReason : reported;
}
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-lifecycle.integration.spec.ts test/integration/fleet/runner-sync-lifecycle.integration.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet
git commit -m "feat(fleet): first start, carried spend on requeue, server cancel reason"
```

### Task 3: Budget domain types and pure rules

**Files:**
- Create: `apps/api/src/fleet/budgets/domain/budget.domain.ts`
- Create: `apps/api/src/fleet/budgets/budget-rules.ts`
- Test: `apps/api/src/fleet/budgets/budget-rules.spec.ts`

**Interfaces:**
- Produces (domain): `BUDGET_SCOPE_TYPES`, `BudgetScopeType`, `BUDGET_WINDOW_KINDS`, `BudgetWindowKind`,
  `BUDGET_RUNNING_JOBS`, `BudgetRunningJobs`, `BudgetIncidentKind`, `BudgetPolicyRecord`, `BudgetScope`.
- Produces (rules): `LIFETIME_WINDOW_START: Date`; `windowStart(kind, now): Date`;
  `spendSince(kind, now): Date | null`; `scopeKeyOf(scopeType, scopeId): string`;
  `budgetReason(policyId): string`; `isEffectivelyPaused(p, now): boolean`; `isStaleMonthlyPause(p, now): boolean`;
  `jobGateKeys({ projectId, repoId, pinnedRunnerId }): string[]`;
  `jobSpendKeys({ projectId, repoId, runnerId }): string[]`;
  `warnReached(spent, amount, warnPercent): boolean`; `hardReached(spent, amount): boolean`;
  `isAboveSpend(amount, spent): boolean`; class `PauseSnapshot` with `static of(policies, now)`,
  `match(keys): BudgetPolicyRecord | null`, `runnerPaused(runnerId): boolean`.

- [ ] **Step 1: Create the domain types**

Create `apps/api/src/fleet/budgets/domain/budget.domain.ts`:

```ts
export const BUDGET_SCOPE_TYPES = ['global', 'project', 'repo', 'runner'] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export const BUDGET_WINDOW_KINDS = ['calendar_month_utc', 'lifetime'] as const;
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number];

/** S1 ruling R2: what a hard stop does to ASSIGNED and RUNNING jobs. */
export const BUDGET_RUNNING_JOBS = ['finish', 'cancel'] as const;
export type BudgetRunningJobs = (typeof BUDGET_RUNNING_JOBS)[number];

export type BudgetIncidentKind = 'warn' | 'hard_stop' | 'resumed' | 'window_reset';

/** S1b §2.1. Money fields are decimal strings. */
export interface BudgetPolicyRecord {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string | null;
  scopeKey: string;
  projectId: string | null;
  windowKind: BudgetWindowKind;
  amountUsd: string;
  warnPercent: number | null;
  hardStop: boolean;
  runningJobs: BudgetRunningJobs;
  pausedAt: Date | null;
  pausedWindowStart: Date | null;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export type BudgetScope = Pick<BudgetPolicyRecord, 'scopeType' | 'scopeId'>;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/api/src/fleet/budgets/budget-rules.spec.ts`:

```ts
import {
  budgetReason, hardReached, isAboveSpend, isEffectivelyPaused, isStaleMonthlyPause, jobGateKeys, jobSpendKeys,
  LIFETIME_WINDOW_START, PauseSnapshot, scopeKeyOf, spendSince, warnReached, windowStart,
} from './budget-rules';
import type { BudgetPolicyRecord } from './domain/budget.domain';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const OCT = new Date('2026-10-01T00:00:00.000Z');
const SEP = new Date('2026-09-01T00:00:00.000Z');

const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'p1', scopeType: 'project', scopeId: 'proj-1', scopeKey: 'project:proj-1', projectId: 'proj-1',
  windowKind: 'calendar_month_utc', amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish',
  pausedAt: null, pausedWindowStart: null, createdById: 'u1', updatedById: 'u1', createdAt: SEP, updatedAt: SEP, ...over,
});

describe('budget rules (S1b §2.1-§2.3)', () => {
  it('starts a monthly window at the first instant of the UTC month, and lifetime at the epoch (D155)', () => {
    expect(windowStart('calendar_month_utc', NOW)).toEqual(OCT);
    expect(windowStart('lifetime', NOW)).toEqual(LIFETIME_WINDOW_START);
    expect(LIFETIME_WINDOW_START.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(spendSince('calendar_month_utc', NOW)).toEqual(OCT);
    expect(spendSince('lifetime', NOW)).toBeNull();
  });

  it('uses the UTC month whatever the local zone says', () => {
    // 2026-10-31T23:30 at UTC-8 is already 2026-11-01T07:30Z: the November window.
    const lateLocal = new Date('2026-10-31T23:30:00.000-08:00');
    expect(windowStart('calendar_month_utc', lateLocal)).toEqual(new Date('2026-11-01T00:00:00.000Z'));
    expect(windowStart('calendar_month_utc', new Date('2026-12-31T23:59:59.999Z'))).toEqual(new Date('2026-12-01T00:00:00.000Z'));
  });

  it('builds scope keys and the stop reason', () => {
    expect(scopeKeyOf('global', null)).toBe('global');
    expect(scopeKeyOf('repo', 'r1')).toBe('repo:r1');
    expect(budgetReason('p9')).toBe('budget:p9');
  });

  it('lists gate keys in precedence order, with the pinned runner only when pinned', () => {
    expect(jobGateKeys({ projectId: 'p', repoId: 'r', pinnedRunnerId: null })).toEqual(['global', 'project:p', 'repo:r']);
    expect(jobGateKeys({ projectId: 'p', repoId: 'r', pinnedRunnerId: 'x' })).toEqual(['global', 'project:p', 'repo:r', 'runner:x']);
    expect(jobSpendKeys({ projectId: 'p', repoId: 'r', runnerId: 'y' })).toEqual(['global', 'project:p', 'repo:r', 'runner:y']);
    expect(jobSpendKeys({ projectId: 'p', repoId: 'r', runnerId: null })).toEqual(['global', 'project:p', 'repo:r']);
  });

  it('enforces a monthly pause only in its own window; a lifetime pause always', () => {
    expect(isEffectivelyPaused(policy(), NOW)).toBe(false);
    expect(isEffectivelyPaused(policy({ pausedAt: OCT, pausedWindowStart: OCT }), NOW)).toBe(true);
    const stale = policy({ pausedAt: SEP, pausedWindowStart: SEP });
    expect(isEffectivelyPaused(stale, NOW)).toBe(false);
    expect(isStaleMonthlyPause(stale, NOW)).toBe(true);
    expect(isStaleMonthlyPause(policy({ pausedAt: OCT, pausedWindowStart: OCT }), NOW)).toBe(false);
    const lifetime = policy({ windowKind: 'lifetime', pausedAt: SEP, pausedWindowStart: LIFETIME_WINDOW_START });
    expect(isEffectivelyPaused(lifetime, NOW)).toBe(true);
    expect(isStaleMonthlyPause(lifetime, NOW)).toBe(false);
  });

  it('compares decimal thresholds exactly', () => {
    expect(hardReached('0.3', '0.3')).toBe(true);
    expect(hardReached('0.2999', '0.3')).toBe(false);
    expect(warnReached('8', '10', 80)).toBe(true);
    expect(warnReached('7.9999', '10', 80)).toBe(false);
    // 1/3 of 0.0001 does not terminate; the comparison must still be exact.
    expect(warnReached('0.0000', '0.0001', 33)).toBe(false);
    expect(warnReached('0.0001', '0.0003', 33)).toBe(true);
    expect(warnReached('100', '10', null)).toBe(false);
    expect(isAboveSpend('10.0001', '10')).toBe(true);
    expect(isAboveSpend('10', '10')).toBe(false);
  });

  it('matches paused policies by key order and finds paused runners (plan D158)', () => {
    const projectPause = policy({ pausedAt: OCT, pausedWindowStart: OCT });
    const repoPause = policy({ id: 'p2', scopeType: 'repo', scopeId: 'r', scopeKey: 'repo:r', pausedAt: OCT, pausedWindowStart: OCT });
    const runnerPause = policy({ id: 'p3', scopeType: 'runner', scopeId: 'x', scopeKey: 'runner:x', projectId: null, pausedAt: OCT, pausedWindowStart: OCT });
    const stale = policy({ id: 'p4', scopeKey: 'global', scopeType: 'global', scopeId: null, pausedAt: SEP, pausedWindowStart: SEP });
    const snap = PauseSnapshot.of([repoPause, projectPause, runnerPause, stale], NOW);
    expect(snap.match(['global', 'project:proj-1', 'repo:r'])?.id).toBe('p1');
    expect(snap.match(['global', 'repo:r'])?.id).toBe('p2');
    expect(snap.match(['global'])).toBeNull();
    expect(snap.runnerPaused('x')).toBe(true);
    expect(snap.runnerPaused('y')).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/budget-rules.spec.ts`
Expected: FAIL (`Cannot find module './budget-rules'`).

- [ ] **Step 4: Implement the rules**

Create `apps/api/src/fleet/budgets/budget-rules.ts`:

```ts
import { Prisma } from '@prisma/client';
import type { BudgetPolicyRecord, BudgetScopeType, BudgetWindowKind } from './domain/budget.domain';

/** Plan D155: the lifetime window's start, stored in incidents and in pausedWindowStart. */
export const LIFETIME_WINDOW_START = new Date(0);

/** S1b §2.1: the first instant of the current UTC month, or the epoch for lifetime. */
export function windowStart(kind: BudgetWindowKind, now: Date): Date {
  return kind === 'lifetime' ? LIFETIME_WINDOW_START : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The `firstStartedAt` lower bound of a window spend query; null = no bound (lifetime). */
export function spendSince(kind: BudgetWindowKind, now: Date): Date | null {
  return kind === 'lifetime' ? null : windowStart(kind, now);
}

export function scopeKeyOf(scopeType: BudgetScopeType, scopeId: string | null): string {
  return scopeType === 'global' ? 'global' : `${scopeType}:${scopeId}`;
}

/** The stateReason and cancelReason of a budget stop. */
export const budgetReason = (policyId: string): string => `budget:${policyId}`;

type PauseFields = Pick<BudgetPolicyRecord, 'windowKind' | 'pausedAt' | 'pausedWindowStart'>;

/** S1b §2.3: a stale monthly pause (an earlier window) is not enforced, even before the sweep clears it. */
export function isEffectivelyPaused(p: PauseFields, now: Date): boolean {
  if (!p.pausedAt) return false;
  if (p.windowKind === 'lifetime') return true;
  return p.pausedWindowStart !== null && p.pausedWindowStart.getTime() === windowStart(p.windowKind, now).getTime();
}

/** B8: a monthly pause from an earlier window; the sweep clears it. */
export function isStaleMonthlyPause(p: PauseFields, now: Date): boolean {
  return p.windowKind === 'calendar_month_utc' && p.pausedAt !== null && p.pausedWindowStart !== null &&
    p.pausedWindowStart.getTime() < windowStart(p.windowKind, now).getTime();
}

/** S1b §2.3: the scopes that gate a job, in precedence order (the pinned runner last). */
export function jobGateKeys(job: { projectId: string; repoId: string; pinnedRunnerId: string | null }): string[] {
  return ['global', `project:${job.projectId}`, `repo:${job.repoId}`, ...(job.pinnedRunnerId ? [`runner:${job.pinnedRunnerId}`] : [])];
}

/** S1b §2.2: the scopes whose window spend a job's cost change moves (its current runner, not the pin). */
export function jobSpendKeys(job: { projectId: string; repoId: string; runnerId: string | null }): string[] {
  return ['global', `project:${job.projectId}`, `repo:${job.repoId}`, ...(job.runnerId ? [`runner:${job.runnerId}`] : [])];
}

export function warnReached(spent: string, amount: string, warnPercent: number | null): boolean {
  if (warnPercent === null) return false;
  // spent >= amount * pct / 100, multiplied out so no division is ever rounded.
  return new Prisma.Decimal(spent).mul(100).gte(new Prisma.Decimal(amount).mul(warnPercent));
}

export function hardReached(spent: string, amount: string): boolean {
  return new Prisma.Decimal(spent).gte(amount);
}

export function isAboveSpend(amount: string, spent: string): boolean {
  return new Prisma.Decimal(amount).gt(spent);
}

/** Plan D158: the effectively paused policies, read once per placement or dispatch check. */
export class PauseSnapshot {
  private constructor(private readonly paused: readonly BudgetPolicyRecord[]) {}

  static of(policies: readonly BudgetPolicyRecord[], now: Date): PauseSnapshot {
    return new PauseSnapshot(policies.filter((p) => isEffectivelyPaused(p, now)));
  }

  /** The paused policy of the first key that has one, in the keys' order. */
  match(keys: readonly string[]): BudgetPolicyRecord | null {
    for (const key of keys) {
      const hit = this.paused.find((p) => p.scopeKey === key);
      if (hit) return hit;
    }
    return null;
  }

  runnerPaused(runnerId: string): boolean {
    return this.paused.some((p) => p.scopeKey === `runner:${runnerId}`);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/budget-rules.spec.ts`
Expected: PASS (7 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/budgets
git commit -m "feat(fleet): budget domain types and window, scope and threshold rules"
```

### Task 4: Budget repository, `BudgetGate` and `BudgetStoreModule`

**Files:**
- Modify: `apps/api/src/fleet/budgets/domain/budget.domain.ts` (repository contract)
- Create: `apps/api/src/fleet/budgets/prisma-budget.repository.ts`
- Create: `apps/api/src/fleet/budgets/budget.exceptions.ts`
- Create: `apps/api/src/fleet/budgets/budget-gate.ts`
- Create: `apps/api/src/fleet/budgets/budget-store.module.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts` (import `BudgetStoreModule`)
- Test: `apps/api/test/integration/fleet/fleet-budget-repository.integration.spec.ts`

**Interfaces:**
- Consumes: Task 3 types and rules.
- Produces: `BUDGET_REPOSITORY`; `NewBudgetPolicy`, `BudgetPolicyPatch`, `NewBudgetIncident`,
  `DuplicateBudgetPolicyError`, `IBudgetRepository` (methods below, including `findRepoProjectId`); `PrismaBudgetRepository`;
  `BudgetPausedException(policy)`; `BudgetGate.snapshot(now): Promise<PauseSnapshot>`,
  `BudgetGate.assertNotPaused(keys, now): Promise<void>`; `BudgetStoreModule` exporting `BUDGET_REPOSITORY` and
  `BudgetGate`.

- [ ] **Step 1: Add the repository contract**

Append to `apps/api/src/fleet/budgets/domain/budget.domain.ts`:

```ts
export const BUDGET_REPOSITORY = Symbol('BUDGET_REPOSITORY');

export interface NewBudgetPolicy {
  scopeType: BudgetScopeType;
  scopeId: string | null;
  scopeKey: string;
  projectId: string | null;
  windowKind: BudgetWindowKind;
  amountUsd: string;
  warnPercent: number | null;
  hardStop: boolean;
  runningJobs: BudgetRunningJobs;
  createdById: string;
}

export type BudgetPolicyPatch = Partial<Pick<BudgetPolicyRecord,
  'amountUsd' | 'warnPercent' | 'hardStop' | 'runningJobs' | 'pausedAt' | 'pausedWindowStart' | 'updatedById'>>;

export interface NewBudgetIncident {
  policyId: string;
  kind: BudgetIncidentKind;
  windowStart: Date;
  spentUsd: string;
  amountUsd: string;
  actorId: string | null;
}

/** create() hit the (scopeKey, windowKind) unique index. */
export class DuplicateBudgetPolicyError extends Error {
  constructor() {
    super('a budget policy already exists for this scope and window');
  }
}

export interface IBudgetRepository {
  findById(id: string): Promise<BudgetPolicyRecord | null>;
  /** SELECT ... FOR UPDATE (inside txManager.run); null when the policy is gone. */
  lockById(id: string): Promise<BudgetPolicyRecord | null>;
  /** Every policy, by scopeKey then windowKind. */
  findAll(): Promise<BudgetPolicyRecord[]>;
  findByScopeKeys(keys: readonly string[]): Promise<BudgetPolicyRecord[]>;
  /** S1b §2.4 member list: the global policies plus the project's project and repo policies. */
  findVisibleToProject(projectId: string): Promise<BudgetPolicyRecord[]>;
  /** Policies with pausedAt set, effective or stale; filter with isEffectivelyPaused. */
  findPaused(): Promise<BudgetPolicyRecord[]>;
  /** @throws DuplicateBudgetPolicyError */
  create(data: NewBudgetPolicy): Promise<BudgetPolicyRecord>;
  update(id: string, patch: BudgetPolicyPatch): Promise<BudgetPolicyRecord>;
  /** Incidents go with it (FK cascade). */
  delete(id: string): Promise<void>;
  /** Plan D166: global always; a project that is not soft-deleted; an existing repo or runner row. */
  scopeExists(scope: BudgetScope): Promise<boolean>;
  /** The fleet repo's project id, or null when there is no such repo (repo-scope create, S1b §2.4). */
  findRepoProjectId(repoId: string): Promise<string | null>;
  /** S1b §2.1 window spend as a decimal string; `since` null = lifetime. */
  windowSpend(scope: BudgetScope, since: Date | null): Promise<string>;
  /** INSERT ... ON CONFLICT DO NOTHING (a unique violation would abort the transaction); true when inserted. */
  insertIncident(incident: NewBudgetIncident): Promise<boolean>;
  /** QUEUED jobs in scope, oldest first; a runner scope means jobs pinned to it (S1b §2.2). */
  findQueuedJobIds(scope: BudgetScope): Promise<string[]>;
  /** ASSIGNED and RUNNING jobs in scope, oldest first; a runner scope means jobs it holds. */
  findHeldJobIds(scope: BudgetScope): Promise<string[]>;
}
```

- [ ] **Step 2: Write the failing repository test**

Create `apps/api/test/integration/fleet/fleet-budget-repository.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 2a — budget repository on PG: spend, incidents, scope rows, job sets.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-repository.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { BUDGET_REPOSITORY, DuplicateBudgetPolicyError, IBudgetRepository, NewBudgetPolicy } from '../../../src/fleet/budgets/domain/budget.domain';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('budget repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repo: IBudgetRepository;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  const OCT = new Date('2026-10-01T00:00:00.000Z');
  let n = 0;

  const insertJob = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `f${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, state: 'COMPLETED', ...over,
    },
  });
  const newPolicy = (over: Partial<NewBudgetPolicy> = {}): NewBudgetPolicy => ({
    scopeType: 'global', scopeId: null, scopeKey: 'global', projectId: null, windowKind: 'calendar_month_utc',
    amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish', createdById: base.adminId, ...over,
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    repo = app.get<IBudgetRepository>(BUDGET_REPOSITORY);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('sums spent plus carried for jobs first started in the window, per scope', async () => {
    const runner = await insertRunner(prisma);
    await insertJob({ costSpentUsd: 1.5, costCarriedUsd: 0.25, firstStartedAt: new Date('2026-10-02T00:00:00Z'), runnerId: runner.id });
    await insertJob({ costSpentUsd: 2, firstStartedAt: new Date('2026-09-30T23:59:59Z') }); // previous month
    await insertJob({ costSpentUsd: 0, costCarriedUsd: 0.5 }); // never started: lifetime only
    const global = { scopeType: 'global' as const, scopeId: null };
    expect(await repo.windowSpend(global, OCT)).toBe('1.75');
    expect(await repo.windowSpend(global, null)).toBe('4.25');
    expect(await repo.windowSpend({ scopeType: 'runner', scopeId: runner.id }, OCT)).toBe('1.75');
    expect(await repo.windowSpend({ scopeType: 'repo', scopeId: base.repoId }, OCT)).toBe('1.75');
    expect(await repo.windowSpend({ scopeType: 'project', scopeId: 'nope' }, null)).toBe('0');
  });

  it('inserts a warn incident once per (policy, window, amount) without aborting the transaction', async () => {
    const p = await repo.create(newPolicy());
    const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    const incident = { policyId: p.id, kind: 'warn' as const, windowStart: OCT, spentUsd: '8', amountUsd: '10', actorId: null };
    const results = await tx.run(async () => [
      await repo.insertIncident(incident),
      await repo.insertIncident(incident),
      await repo.insertIncident({ ...incident, amountUsd: '20' }),
      await repo.insertIncident({ ...incident, kind: 'resumed' }),
      await repo.insertIncident({ ...incident, kind: 'resumed' }),
    ]);
    expect(results).toEqual([true, false, true, true, true]);
    expect(await prisma.budgetIncident.count({ where: { policyId: p.id } })).toBe(4);
  });

  it('refuses a second policy for one scope and window', async () => {
    await repo.create(newPolicy());
    await expect(repo.create(newPolicy())).rejects.toBeInstanceOf(DuplicateBudgetPolicyError);
  });

  it('knows which scope rows exist, treating a soft-deleted project as gone (D166)', async () => {
    const runner = await insertRunner(prisma);
    expect(await repo.scopeExists({ scopeType: 'global', scopeId: null })).toBe(true);
    expect(await repo.scopeExists({ scopeType: 'project', scopeId: base.projectId })).toBe(true);
    expect(await repo.scopeExists({ scopeType: 'repo', scopeId: base.repoId })).toBe(true);
    expect(await repo.scopeExists({ scopeType: 'runner', scopeId: runner.id })).toBe(true);
    expect(await repo.scopeExists({ scopeType: 'runner', scopeId: 'gone' })).toBe(false);
    expect(await repo.findRepoProjectId(base.repoId)).toBe(base.projectId);
    expect(await repo.findRepoProjectId('gone')).toBeNull();
    const other = await seedFleetBase(prisma);
    await prisma.project.update({ where: { id: other.projectId }, data: { deletedAt: new Date() } });
    expect(await repo.scopeExists({ scopeType: 'project', scopeId: other.projectId })).toBe(false);
  });

  it('lists QUEUED jobs pinned to a runner scope and the ASSIGNED or RUNNING jobs it holds', async () => {
    const runner = await insertRunner(prisma);
    const pinned = await insertJob({ state: 'QUEUED', pinnedRunnerId: runner.id });
    await insertJob({ state: 'QUEUED' });
    const running = await insertJob({ state: 'RUNNING', runnerId: runner.id });
    const assigned = await insertJob({ state: 'ASSIGNED', runnerId: runner.id });
    await insertJob({ state: 'UPLOADING', runnerId: runner.id });
    const scope = { scopeType: 'runner' as const, scopeId: runner.id };
    expect(await repo.findQueuedJobIds(scope)).toEqual([pinned.id]);
    expect((await repo.findHeldJobIds(scope)).sort()).toEqual([running.id, assigned.id].sort());
    expect(await repo.findQueuedJobIds({ scopeType: 'global', scopeId: null })).toHaveLength(2);
  });

  it('shows a project its own policies and the global ones, not another project\'s', async () => {
    const other = await seedFleetBase(prisma);
    await repo.create(newPolicy());
    await repo.create(newPolicy({ scopeType: 'project', scopeId: base.projectId, scopeKey: `project:${base.projectId}`, projectId: base.projectId }));
    await repo.create(newPolicy({ scopeType: 'repo', scopeId: base.repoId, scopeKey: `repo:${base.repoId}`, projectId: base.projectId }));
    await repo.create(newPolicy({ scopeType: 'project', scopeId: other.projectId, scopeKey: `project:${other.projectId}`, projectId: other.projectId }));
    const runner = await insertRunner(prisma);
    await repo.create(newPolicy({ scopeType: 'runner', scopeId: runner.id, scopeKey: `runner:${runner.id}` }));
    expect((await repo.findVisibleToProject(base.projectId)).map((p) => p.scopeType).sort()).toEqual(['global', 'project', 'repo']);
    expect((await repo.findPaused())).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-repository.integration.spec.ts`
Expected: FAIL (`Nest could not find BUDGET_REPOSITORY element`, or a missing-module compile error).

- [ ] **Step 4: Implement the repository**

Create `apps/api/src/fleet/budgets/prisma-budget.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { BudgetPolicy as PolicyRow, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { randomUUID } from 'crypto';
import { FleetJobState } from '../../common/enums';
import {
  BudgetPolicyPatch, BudgetPolicyRecord, BudgetRunningJobs, BudgetScope, BudgetScopeType, BudgetWindowKind,
  DuplicateBudgetPolicyError, IBudgetRepository, NewBudgetIncident, NewBudgetPolicy,
} from './domain/budget.domain';

const toPolicy = (r: PolicyRow): BudgetPolicyRecord => ({
  ...r,
  scopeType: r.scopeType as BudgetScopeType,
  windowKind: r.windowKind as BudgetWindowKind,
  runningJobs: r.runningJobs as BudgetRunningJobs,
  amountUsd: r.amountUsd.toString(),
});

const ORDER: Prisma.BudgetPolicyOrderByWithRelationInput[] = [{ scopeKey: 'asc' }, { windowKind: 'asc' }];
const OLDEST_FIRST: Prisma.FleetJobOrderByWithRelationInput[] = [{ queuedAt: 'asc' }, { id: 'asc' }];

/** S1b §2.1 scope filter; `runnerField` picks the pin (QUEUED) or the holder (spend, held jobs). */
function jobScope(scope: BudgetScope, runnerField: 'runnerId' | 'pinnedRunnerId'): Prisma.FleetJobWhereInput {
  switch (scope.scopeType) {
    case 'global': return {};
    case 'project': return { projectId: scope.scopeId ?? '' };
    case 'repo': return { repoId: scope.scopeId ?? '' };
    case 'runner': return { [runnerField]: scope.scopeId ?? '' };
  }
}

@Injectable()
export class PrismaBudgetRepository implements IBudgetRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async findById(id: string): Promise<BudgetPolicyRecord | null> {
    const r = await this.db.budgetPolicy.findUnique({ where: { id } });
    return r ? toPolicy(r) : null;
  }

  async lockById(id: string): Promise<BudgetPolicyRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BudgetPolicy" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findAll(): Promise<BudgetPolicyRecord[]> {
    return (await this.db.budgetPolicy.findMany({ orderBy: ORDER })).map(toPolicy);
  }

  async findByScopeKeys(keys: readonly string[]): Promise<BudgetPolicyRecord[]> {
    if (keys.length === 0) return [];
    return (await this.db.budgetPolicy.findMany({ where: { scopeKey: { in: [...keys] } }, orderBy: ORDER })).map(toPolicy);
  }

  async findVisibleToProject(projectId: string): Promise<BudgetPolicyRecord[]> {
    const rows = await this.db.budgetPolicy.findMany({ where: { OR: [{ scopeType: 'global' }, { projectId }] }, orderBy: ORDER });
    return rows.map(toPolicy);
  }

  async findPaused(): Promise<BudgetPolicyRecord[]> {
    return (await this.db.budgetPolicy.findMany({ where: { pausedAt: { not: null } }, orderBy: ORDER })).map(toPolicy);
  }

  async create(data: NewBudgetPolicy): Promise<BudgetPolicyRecord> {
    try {
      return toPolicy(await this.db.budgetPolicy.create({
        data: { ...data, amountUsd: new Prisma.Decimal(data.amountUsd), updatedById: data.createdById },
      }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DuplicateBudgetPolicyError();
      throw error;
    }
  }

  async update(id: string, patch: BudgetPolicyPatch): Promise<BudgetPolicyRecord> {
    const { amountUsd, ...rest } = patch;
    const data: Prisma.BudgetPolicyUpdateInput = { ...rest, ...(amountUsd !== undefined ? { amountUsd: new Prisma.Decimal(amountUsd) } : {}) };
    return toPolicy(await this.db.budgetPolicy.update({ where: { id }, data }));
  }

  async delete(id: string): Promise<void> {
    await this.db.budgetPolicy.delete({ where: { id } });
  }

  async scopeExists(scope: BudgetScope): Promise<boolean> {
    if (scope.scopeType === 'global') return true;
    if (!scope.scopeId) return false;
    const id = scope.scopeId;
    switch (scope.scopeType) {
      case 'project': return (await this.db.project.count({ where: { id, deletedAt: null } })) > 0;
      case 'repo': return (await this.db.fleetRepo.count({ where: { id } })) > 0;
      case 'runner': return (await this.db.runner.count({ where: { id } })) > 0;
    }
  }

  async findRepoProjectId(repoId: string): Promise<string | null> {
    return (await this.db.fleetRepo.findUnique({ where: { id: repoId }, select: { projectId: true } }))?.projectId ?? null;
  }

  async windowSpend(scope: BudgetScope, since: Date | null): Promise<string> {
    const agg = await this.db.fleetJob.aggregate({
      where: { ...jobScope(scope, 'runnerId'), ...(since ? { firstStartedAt: { gte: since } } : {}) },
      _sum: { costSpentUsd: true, costCarriedUsd: true },
    });
    return new Prisma.Decimal(agg._sum.costSpentUsd ?? 0).add(agg._sum.costCarriedUsd ?? 0).toString();
  }

  async insertIncident(i: NewBudgetIncident): Promise<boolean> {
    // Bind timestamps as ISO text cast to timestamp(3) (UTC), as casAssign does.
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "BudgetIncident" ("id", "policyId", "kind", "windowStart", "spentUsd", "amountUsd", "actorId")
      VALUES (${randomUUID()}, ${i.policyId}, ${i.kind}, CAST(${i.windowStart.toISOString()} AS timestamp(3)),
              CAST(${i.spentUsd} AS DECIMAL(12,4)), CAST(${i.amountUsd} AS DECIMAL(12,4)), ${i.actorId})
      ON CONFLICT DO NOTHING
      RETURNING "id"`;
    return rows.length > 0;
  }

  async findQueuedJobIds(scope: BudgetScope): Promise<string[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { ...jobScope(scope, 'pinnedRunnerId'), state: FleetJobState.QUEUED }, orderBy: OLDEST_FIRST, select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async findHeldJobIds(scope: BudgetScope): Promise<string[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { ...jobScope(scope, 'runnerId'), state: { in: [FleetJobState.ASSIGNED, FleetJobState.RUNNING] } },
      orderBy: OLDEST_FIRST, select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
```

- [ ] **Step 5: Implement the exception, the gate and the store module**

Create `apps/api/src/fleet/budgets/budget.exceptions.ts`:

```ts
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { BudgetPolicyRecord } from './domain/budget.domain';

/** S1b §2.3: 409 fleet.budgetPaused. The args reach the client through the message (plan D154). */
export class BudgetPausedException extends ConflictAppException {
  constructor(policy: Pick<BudgetPolicyRecord, 'id' | 'scopeType' | 'scopeId' | 'scopeKey'>) {
    super({ policyId: policy.id, scopeType: policy.scopeType, scopeId: policy.scopeId ?? '', scope: policy.scopeKey }, 'fleet.budgetPaused');
  }
}
```

Create `apps/api/src/fleet/budgets/budget-gate.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PauseSnapshot } from './budget-rules';
import { BudgetPausedException } from './budget.exceptions';
import { BUDGET_REPOSITORY, IBudgetRepository } from './domain/budget.domain';

/** S1b §2.3 enforcement reads, shared by dispatch, requeue and placement. */
@Injectable()
export class BudgetGate {
  constructor(@Inject(BUDGET_REPOSITORY) private readonly repo: Pick<IBudgetRepository, 'findPaused'>) {}

  async snapshot(now: Date): Promise<PauseSnapshot> {
    return PauseSnapshot.of(await this.repo.findPaused(), now);
  }

  /** 409 fleet.budgetPaused when an effectively paused policy covers any of the keys. */
  async assertNotPaused(keys: readonly string[], now: Date): Promise<void> {
    const paused = (await this.snapshot(now)).match(keys);
    if (paused) throw new BudgetPausedException(paused);
  }
}
```

A policy whose scope row is gone never blocks here: a job always references an existing project and repo, and a
deleted runner nulls the job's pin (`onDelete: SetNull`), so an orphaned policy's key never appears in a job's gate
keys.

Create `apps/api/src/fleet/budgets/budget-store.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { BudgetGate } from './budget-gate';
import { BUDGET_REPOSITORY } from './domain/budget.domain';
import { PrismaBudgetRepository } from './prisma-budget.repository';

/** Plan D160: budget storage and the pause gate, importable by the jobs module without a cycle. */
@Module({
  imports: [PrismaModule],
  providers: [PrismaBudgetRepository, { provide: BUDGET_REPOSITORY, useExisting: PrismaBudgetRepository }, BudgetGate],
  exports: [BUDGET_REPOSITORY, BudgetGate],
})
export class BudgetStoreModule {}
```

In `apps/api/src/fleet/jobs/fleet-jobs.module.ts` add `BudgetStoreModule` to `imports`
(`import { BudgetStoreModule } from '../budgets/budget-store.module';`).

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-repository.integration.spec.ts src/fleet/jobs/fleet-jobs.module.spec.ts`
Expected: PASS (6 + 1 cases).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-budget-repository.integration.spec.ts
git commit -m "feat(fleet): budget repository, pause gate and store module"
```

### Task 5: Dispatch and requeue refuse a paused scope; budget i18n

**Files:**
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts` (constructor, `dispatch`, `requeue`)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.controller.ts` (409 descriptions)
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`
- Test: `apps/api/test/unit/i18n/fleet-budget-translation-keys.spec.ts`,
  `apps/api/test/integration/fleet/fleet-budget-enforcement.integration.spec.ts`

**Interfaces:**
- Consumes: `BudgetGate.assertNotPaused` (Task 4), `jobGateKeys` (Task 3).
- Produces: every budget i18n key used in this slice (`fleet.budgets`, `fleet.budgetInput`, `fleet.budgetPaused`,
  `fleet.budgetAmountNotAboveSpend`, `fleet.budgetNotPaused`).

- [ ] **Step 1: Write the failing i18n test**

Create `apps/api/test/unit/i18n/fleet-budget-translation-keys.spec.ts`:

```ts
/**
 * S1b slice 2a — budget error messages exist in en and zh with the same placeholders.
 * The key is `<prefix>.<code>`: ConflictAppException uses 409, ValidationAppException -2, NotFoundAppException 404.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

type Tree = Record<string, Record<string, string>>;
const load = (lang: string): Tree => JSON.parse(readFileSync(join(__dirname, '../../../src/i18n', lang, 'fleet.json'), 'utf8')) as Tree;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const KEYS: Array<[string, string, string[]]> = [
  ['budgets', '404', []],
  ['budgets', '409', []],
  ['budgetInput', '-2', ['reason']],
  ['budgetPaused', '409', ['policyId', 'scope']],
  ['budgetAmountNotAboveSpend', '-2', ['amountUsd', 'spentUsd']],
  ['budgetNotPaused', '409', []],
];

describe('fleet budget translation keys', () => {
  const en = load('en');
  const zh = load('zh');

  it.each(KEYS)('fleet.%s.%s exists in en and zh with the same placeholders', (group, code, expected) => {
    const enText = en[group]?.[code];
    const zhText = zh[group]?.[code];
    expect(typeof enText).toBe('string');
    expect(typeof zhText).toBe('string');
    expect(placeholders(enText)).toEqual(expected);
    expect(placeholders(zhText)).toEqual(expected);
  });
});
```

Run: `cd apps/api && bun run test:scoped test/unit/i18n/fleet-budget-translation-keys.spec.ts`
Expected: FAIL (6 cases, `undefined`).

- [ ] **Step 2: Add the messages**

In `apps/api/src/i18n/en/fleet.json`, before the closing `}` (add a comma after the `"fence"` line):

```json
  "budgets": { "404": "Budget policy not found", "409": "A budget policy already exists for this scope and window" },
  "budgetInput": { "-2": "Invalid budget policy: {reason}" },
  "budgetPaused": { "409": "The fleet budget for {scope} is paused (policy {policyId})" },
  "budgetAmountNotAboveSpend": { "-2": "The amount {amountUsd} must be above this window's spend of {spentUsd}" },
  "budgetNotPaused": { "409": "This budget policy is not paused" }
```

In `apps/api/src/i18n/zh/fleet.json`, likewise:

```json
  "budgets": { "404": "未找到预算策略", "409": "该范围和周期已有预算策略" },
  "budgetInput": { "-2": "无效的预算策略：{reason}" },
  "budgetPaused": { "409": "{scope} 的舰队预算已暂停（策略 {policyId}）" },
  "budgetAmountNotAboveSpend": { "-2": "金额 {amountUsd} 必须高于本周期已花费的 {spentUsd}" },
  "budgetNotPaused": { "409": "该预算策略未处于暂停状态" }
```

Run: `cd apps/api && bun run test:scoped test/unit/i18n/fleet-budget-translation-keys.spec.ts`
Expected: PASS (6 cases).

- [ ] **Step 3: Write the failing enforcement test**

Create `apps/api/test/integration/fleet/fleet-budget-enforcement.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 2a — dispatch and requeue refuse a paused scope with 409 fleet.budgetPaused (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-enforcement.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const monthStart = (d: Date, back = 0): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));

describeIntegration('fleet budget enforcement at dispatch and requeue (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const auth = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const dispatch = (feature: string, over: Record<string, unknown> = {}) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth()).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature, ...over });

  /** A policy paused in the current month (or `back` months ago: a stale pause). */
  const pausedPolicy = (scopeType: string, scopeId: string | null, over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}, back = 0) =>
    prisma.budgetPolicy.create({
      data: {
        scopeType, scopeId, scopeKey: scopeId ? `${scopeType}:${scopeId}` : 'global',
        projectId: scopeType === 'project' || scopeType === 'repo' ? world.projectId : null,
        windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(1), createdById: world.ids.root, updatedById: world.ids.root,
        pausedAt: new Date(), pausedWindowStart: monthStart(new Date(), back), ...over,
      },
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
  });

  it('refuses a dispatch in a paused project with 409 naming the policy (D154)', async () => {
    const policy = await pausedPolicy('project', world.projectId);
    const res = await dispatch('e-project').expect(409);
    expect(res.body.message).toContain(policy.id);
    expect(res.body.message).toContain(`project:${world.projectId}`);
    expect(await prisma.fleetJob.count({ where: { feature: 'e-project' } })).toBe(0);
  });

  it('refuses under a paused global or repo policy and a lifetime pause', async () => {
    const global = await pausedPolicy('global', null);
    expect((await dispatch('e-global').expect(409)).body.message).toContain(global.id);
    await prisma.budgetPolicy.deleteMany();
    await pausedPolicy('repo', world.repoId);
    await dispatch('e-repo').expect(409);
    await prisma.budgetPolicy.deleteMany();
    await pausedPolicy('project', world.projectId, { windowKind: 'lifetime', pausedWindowStart: new Date(0) });
    await dispatch('e-lifetime').expect(409);
  });

  it('ignores a stale monthly pause and another repo\'s pause', async () => {
    await pausedPolicy('project', world.projectId, {}, 1);
    await pausedPolicy('repo', world.foreignRepoId, { projectId: world.opsProjectId });
    await dispatch('e-stale').expect(201);
  });

  it('refuses a dispatch pinned to a paused runner', async () => {
    const runner = await insertRunner(prisma);
    const policy = await pausedPolicy('runner', runner.id);
    expect((await dispatch('e-pinned', { pinnedRunnerId: runner.id }).expect(409)).body.message).toContain(policy.id);
  });

  it('refuses a requeue in a paused scope and leaves the job as it was', async () => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: 'e-requeue', profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'FAILED', finishedAt: new Date(),
      },
    });
    await pausedPolicy('project', world.projectId);
    await request(server).post(`/api/projects/web/fleet/jobs/${job.id}/requeue`).set(auth()).expect(409);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(expect.objectContaining({ state: 'FAILED', leaseEpoch: 0 }));
  });
});
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-enforcement.integration.spec.ts`
Expected: FAIL (dispatches answer 201; the stale case already passes).

- [ ] **Step 4: Gate dispatch and requeue**

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts`:

Imports:

```ts
import { BudgetGate } from '../budgets/budget-gate';
import { jobGateKeys } from '../budgets/budget-rules';
```

Constructor: add `private readonly budgets: BudgetGate,` after `private readonly notifier: RunnerNotifier,`.

In `dispatch`, directly after the `if (input.pinnedRunnerId) { ... }` block:

```ts
    // S1b §2.3: no new job in a paused scope, the pinned runner's included.
    await this.budgets.assertNotPaused(jobGateKeys({ projectId, repoId: repo.id, pinnedRunnerId: input.pinnedRunnerId }), new Date());
```

In `requeue`, inside the transaction, directly after the `canTransition` check line:

```ts
        await this.budgets.assertNotPaused(jobGateKeys(current), now);
```

(The thrown `BudgetPausedException` rolls the transaction back and is not a `DuplicateActiveJobError`, so it reaches
the client unchanged.)

In `apps/api/src/fleet/jobs/fleet-jobs.controller.ts`, change the dispatch 409 description to
`'An active job already runs this (repo, feature), or a budget covering the job is paused (fleet.budgetPaused)'`
and the requeue 409 description to
`'Job not requeueable, an active duplicate exists, or a budget covering the job is paused'`.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-enforcement.integration.spec.ts test/integration/fleet/fleet-jobs.integration.spec.ts test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/jobs apps/api/src/i18n apps/api/test/unit/i18n/fleet-budget-translation-keys.spec.ts \
  apps/api/test/integration/fleet/fleet-budget-enforcement.integration.spec.ts
git commit -m "feat(fleet): refuse dispatch and requeue in a paused budget scope"
```

### Task 6: Placement — the shared pre-assign check and the `budget_paused` misfit

**Files:**
- Modify: `apps/api/src/fleet/jobs/placement-rules.ts` (`MisfitReason`, `PlacementRunner`, `firstMisfit`)
- Modify: `apps/api/src/fleet/jobs/placement.service.ts` (`evaluatePinned`, `placeJob`, `fillRunner`, new private
  `cancelForPause`)
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts` (`PlacementMisfitDto.reason` enum)
- Modify: `apps/web/lib/fleet-types.ts`, `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/zh.json`,
  `apps/web/tests/i18n/fleet-locale-parity.spec.ts`
- Test: `apps/api/src/fleet/jobs/placement-rules.spec.ts`,
  `apps/api/test/integration/fleet/fleet-budget-placement.integration.spec.ts`

**Interfaces:**
- Consumes: `BudgetGate.snapshot`, `PauseSnapshot.match/runnerPaused`, `jobGateKeys`, `budgetReason`.
- Produces: `MisfitReason` gains `'budget_paused'` (not in `PERMANENT_MISFITS`);
  `PlacementRunner.budgetPaused?: boolean`; placement cancels a QUEUED job in a paused scope with
  `stateReason = cancelReason = 'budget:<policyId>'`; `fillRunner` still returns the number of jobs **assigned**.

- [ ] **Step 1: Write the failing rule test**

In `apps/api/src/fleet/jobs/placement-rules.spec.ts`, add inside the top `describe`:

```ts
  it('reports budget_paused after offline and before labels, and never as permanent (S1b §2.3)', () => {
    expect(misfit(job(), runner({ budgetPaused: true }))).toBe('budget_paused');
    expect(misfit(job(), runner({ budgetPaused: true, lastSeenAt: new Date(NOW.getTime() - 91_000) }))).toBe('offline');
    expect(misfit(job({ selectorLabels: ['mac'] }), runner({ budgetPaused: true }))).toBe('budget_paused');
    expect(misfit(job(), runner({ budgetPaused: false }))).toBeNull();
    expect(PERMANENT_MISFITS.has('budget_paused')).toBe(false);
  });
```

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/placement-rules.spec.ts`
Expected: FAIL (type error on `budgetPaused`, or `null` instead of `budget_paused`).

- [ ] **Step 2: Extend the rules**

In `apps/api/src/fleet/jobs/placement-rules.ts`:

```ts
export type MisfitReason =
  | 'disabled' | 'offline' | 'budget_paused' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity';
```

Above `PERMANENT_MISFITS` add the comment line
`// budget_paused is not permanent either: it clears on resume or month rollover (S1b §2.3).`

In `PlacementRunner`, after `capabilities: RunnerCapabilities;`:

```ts
  /** S1b §2.3, plan D159: the runner's own budget scope is effectively paused. Set by PlacementService; absent = no. */
  budgetPaused?: boolean;
```

In `firstMisfit`, after the `offline` line:

```ts
  if (runner.budgetPaused) return 'budget_paused';
```

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`, `PlacementMisfitDto.reason`'s enum becomes
`['disabled', 'offline', 'budget_paused', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_unavailable', 'sandbox', 'tools', 'busy_repo', 'capacity']`.

Run: `cd apps/api && bun run test:scoped src/fleet/jobs/placement-rules.spec.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing placement test**

Create `apps/api/test/integration/fleet/fleet-budget-placement.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 2a — both placement entry points honour budget pauses (spec §2.3) (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-placement.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const monthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

describeIntegration('fleet budget placement (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let placement: PlacementService;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let other: Awaited<ReturnType<typeof seedFleetBase>>;
  let n = 0;

  const queue = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `bp${++n}`, profiles: ['fast'],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, ...over,
    },
  });
  const pause = (scopeType: string, scopeId: string, projectId: string | null = null) => prisma.budgetPolicy.create({
    data: {
      scopeType, scopeId, scopeKey: `${scopeType}:${scopeId}`, projectId, windowKind: 'calendar_month_utc',
      amountUsd: new Prisma.Decimal(1), createdById: base.adminId, updatedById: base.adminId,
      pausedAt: new Date(), pausedWindowStart: monthStart(new Date()),
    },
  });
  const reload = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    placement = app.get(PlacementService);
    base = await seedFleetBase(prisma);
    other = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.runner.deleteMany();
  });

  it('placeJob cancels a QUEUED job whose project paused after it was queued', async () => {
    await insertRunner(prisma);
    const job = await queue();
    const policy = await pause('project', base.projectId, base.projectId);
    const outcome = await placement.placeJob(job.id);
    expect(outcome.assigned).toBe(false);
    expect(await reload(job.id)).toEqual(expect.objectContaining({
      state: 'CANCELLED', stateReason: `budget:${policy.id}`, cancelReason: `budget:${policy.id}`,
    }));
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
  });

  it('fillRunner cancels a job in a paused repo and still assigns an unaffected one', async () => {
    const runner = await insertRunner(prisma, { capacity: 2 });
    const blocked = await queue();
    const free = await queue({ projectId: other.projectId, repoId: other.repoId });
    const policy = await pause('repo', base.repoId, base.projectId);
    expect(await placement.fillRunner(runner.id, 2)).toBe(1);
    expect(await reload(blocked.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: `budget:${policy.id}` }));
    expect(await reload(free.id)).toEqual(expect.objectContaining({ state: 'ASSIGNED', runnerId: runner.id }));
  });

  it('skips a paused runner with budget_paused and assigns to another', async () => {
    const paused = await insertRunner(prisma);
    const open = await insertRunner(prisma);
    await pause('runner', paused.id);
    const job = await queue();
    const outcome = await placement.placeJob(job.id);
    expect(outcome).toEqual(expect.objectContaining({ assigned: true, runnerId: open.id }));
    expect(outcome.misfits).toEqual([expect.objectContaining({ runnerId: paused.id, reason: 'budget_paused' })]);
  });

  it('leaves an unpinned job queued when the only runner is paused, and cancels a job pinned to it', async () => {
    const runner = await insertRunner(prisma);
    const policy = await pause('runner', runner.id);
    const unpinned = await queue();
    const pinned = await queue({ pinnedRunnerId: runner.id });
    expect((await placement.placeJob(unpinned.id)).misfits).toEqual([expect.objectContaining({ reason: 'budget_paused' })]);
    expect(await placement.fillRunner(runner.id, 1)).toBe(0);
    expect((await reload(unpinned.id)).state).toBe('QUEUED');
    expect(await reload(pinned.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: `budget:${policy.id}` }));
  });
});
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-placement.integration.spec.ts`
Expected: FAIL (jobs are assigned instead of cancelled; no `budget_paused` misfit).

- [ ] **Step 4: Add the pre-assign check to `PlacementService`**

In `apps/api/src/fleet/jobs/placement.service.ts`:

Imports (add):

```ts
import { BudgetGate } from '../budgets/budget-gate';
import { budgetReason, jobGateKeys } from '../budgets/budget-rules';
```

Constructor: add `private readonly budgets: BudgetGate,` after `private readonly notifier: RunnerNotifier,`.

`evaluatePinned` — replace its last line with:

```ts
    const budgetPaused = (await this.budgets.snapshot(now)).runnerPaused(runner.id);
    return firstMisfit(job, { ...runner, budgetPaused }, loads.get(runner.id) ?? EMPTY_LOAD, now, this.fleetConfig.runnerOfflineSec);
```

`placeJob` — inside the transaction, directly after the `if (!repo) throw ...` line, add:

```ts
      const pauses = await this.budgets.snapshot(now);
      // S1b §2.3 shared pre-assign check: a job whose scope paused after it was queued is cancelled, never assigned.
      const paused = pauses.match(jobGateKeys(job));
      if (paused) {
        return { outcome: { assigned: false, runnerId: null, leaseEpoch: null, misfits: [] } as PlacementOutcome, live: [await this.cancelForPause(job, paused.id, now)] };
      }
```

and replace the `evaluated` mapping with:

```ts
      const evaluated = runners.map((row) => {
        const runner = { ...row, budgetPaused: pauses.runnerPaused(row.id) };
        const load = loads.get(runner.id) ?? EMPTY_LOAD;
        return { runner, load, reason: firstMisfit(placementJob, runner, load, now, this.fleetConfig.runnerOfflineSec) };
      });
```

Replace the whole `fillRunner` method with:

```ts
  /** Assigns up to min(freeSlots, capacity - active) QUEUED jobs to one runner; returns how many were assigned. */
  async fillRunner(runnerId: string, freeSlots: number, now = new Date()): Promise<number> {
    if (freeSlots <= 0) return 0;
    const { live, assigned } = await this.txManager.run(async () => {
      const locked = await this.repo.lockRunners([runnerId]);
      const [row] = await this.repo.findPlacementRunners(locked);
      if (!row || !row.enabled) return { live: [] as LiveFleetJobEvent[], assigned: 0 };
      const pauses = await this.budgets.snapshot(now);
      const runner = { ...row, budgetPaused: pauses.runnerPaused(row.id) };
      let load = toLoads(await this.repo.findActiveLoads([runner.id])).get(runner.id) ?? EMPTY_LOAD;
      let slots = Math.min(freeSlots, runner.capacity - load.active);
      const events: LiveFleetJobEvent[] = [];
      let count = 0;
      for (const id of slots > 0 ? await this.repo.findQueuedIds(QUEUED_SCAN_LIMIT) : []) {
        if (slots <= 0) break;
        const job = await this.repo.lockById(id, { skipLocked: true });
        if (!job || job.state !== FleetJobState.QUEUED) continue;
        if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) continue;
        // S1b §2.3: the same pre-assign check as placeJob.
        const paused = pauses.match(jobGateKeys(job));
        if (paused) {
          events.push(await this.cancelForPause(job, paused.id, now));
          continue;
        }
        const repo = await this.repo.findRepo(job.repoId);
        if (!repo || firstMisfit(toPlacementJob(job, repo), runner, load, now, this.fleetConfig.runnerOfflineSec) !== null) continue;
        const done = await this.assign(job, repo, runner, now);
        if (!done) continue;
        events.push(done.live);
        count += 1;
        slots -= 1;
        load = { active: load.active + 1, repoIds: new Set([...load.repoIds, job.repoId]) };
      }
      return { live: events, assigned: count };
    });
    this.live.publish(live);
    if (assigned > 0) this.notifier.notify(runnerId);
    return assigned;
  }
```

Add the private helper above `assign`:

```ts
  /** S1b §2.3: cancel a QUEUED job in a paused scope. The transition's activity row names the policy (plan D170). */
  private async cancelForPause(job: FleetJobRecord, policyId: string, now: Date): Promise<LiveFleetJobEvent> {
    const reason = budgetReason(policyId);
    const r = await this.transitions.apply({ job, to: FleetJobState.CANCELLED, by: 'server', now, actor: SYSTEM_ACTOR, reason, extra: { cancelReason: reason } });
    return r.live;
  }
```

- [ ] **Step 5: Run the API tests**

Run: `cd apps/api && bun run type-check && bun run test:scoped src/fleet/jobs/placement-rules.spec.ts test/integration/fleet/fleet-budget-placement.integration.spec.ts test/integration/fleet/placement.integration.spec.ts test/integration/fleet/runner-sync.integration.spec.ts`
Expected: PASS.

- [ ] **Step 6: The web label (plan D171)**

In `apps/web/lib/fleet-types.ts`, `MisfitReason` becomes:

```ts
export type MisfitReason =
  | 'disabled' | 'offline' | 'budget_paused' | 'labels' | 'executor' | 'protocol' | 'provider_missing'
  | 'provider_unavailable' | 'sandbox' | 'tools' | 'busy_repo' | 'capacity'
```

In `apps/web/i18n/locales/en.json` under `fleet.misfit`, after `"offline"`:
`"budget_paused": "Runner's fleet budget is paused",`
In `apps/web/i18n/locales/zh.json` under `fleet.misfit`, after `"offline"`:
`"budget_paused": "执行机的舰队预算已暂停",`

In `apps/web/tests/i18n/fleet-locale-parity.spec.ts`, add `'budget_paused'` to the `'fleet.misfit'` list after
`'offline'`.

Run: `cd apps/web && bun run test -- tests/i18n/fleet-locale-parity.spec.ts && bun run type-check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/jobs apps/api/test/integration/fleet/fleet-budget-placement.integration.spec.ts \
  apps/web/lib/fleet-types.ts apps/web/i18n/locales apps/web/tests/i18n/fleet-locale-parity.spec.ts
git commit -m "feat(fleet): placement cancels jobs in a paused scope and skips paused runners"
```

### Task 7: `FleetJobsService.cancelForBudget`

**Files:**
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts` (new method and exported result type)
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts` (export `FleetJobsService`)
- Test: `apps/api/test/integration/fleet/fleet-budget-cancel.integration.spec.ts`

**Interfaces:**
- Consumes: `budgetReason` (Task 3); `FleetJobRecord.cancelReason` (Task 1).
- Produces: `BudgetCancelResult { cancelled: string[]; requested: string[]; live: LiveFleetJobEvent[]; wake: string[] }`;
  `FleetJobsService.cancelForBudget(jobIds: readonly string[], policy: { id: string; responsibleUserId: string }, now?: Date): Promise<BudgetCancelResult>`
  — call inside `txManager.run`; the caller publishes `live` and notifies `wake` after commit (plan D157).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/fleet/fleet-budget-cancel.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 2a — cancelForBudget: QUEUED and never-acked ASSIGNED end on the server, held jobs get one CANCEL (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-cancel.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('cancelForBudget (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let jobs: FleetJobsService;
  let tx: ITransactionManager;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let runnerId: string;
  let n = 0;
  const POLICY = { id: 'pol-1', responsibleUserId: '' };

  const insertJob = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `bc${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, ...over,
    },
  });
  const held = (state: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    insertJob({ state, runnerId, leaseEpoch: 1, ...over });
  const assignCommand = (jobId: string, acked: boolean) => prisma.fleetCommand.create({
    data: { runnerId, jobId, type: 'ASSIGN', leaseEpoch: 1, payload: {}, ...(acked ? { ackedAt: new Date(), ackResult: 'ok' } : {}) },
  });
  const reload = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });
  const cancel = (ids: string[]) => tx.run(() => jobs.cancelForBudget(ids, { ...POLICY, responsibleUserId: base.adminId }));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    jobs = app.get(FleetJobsService);
    tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    base = await seedFleetBase(prisma);
    runnerId = (await insertRunner(prisma, { capacity: 10 })).id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('cancels a QUEUED job on the server with the budget reason', async () => {
    const job = await insertJob();
    const result = await cancel([job.id]);
    expect(result).toEqual(expect.objectContaining({ cancelled: [job.id], requested: [], wake: [] }));
    expect(result.live).toHaveLength(1);
    expect(await reload(job.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: 'budget:pol-1', cancelReason: 'budget:pol-1' }));
  });

  it('cancels a never-acked ASSIGNED job on the server, bumping the epoch and withdrawing the ASSIGN', async () => {
    const job = await held('ASSIGNED');
    const assign = await assignCommand(job.id, false);
    expect((await cancel([job.id])).cancelled).toEqual([job.id]);
    expect(await reload(job.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', leaseEpoch: 2, stateReason: 'budget:pol-1' }));
    expect(await prisma.fleetCommand.findUniqueOrThrow({ where: { id: assign.id } })).toEqual(expect.objectContaining({ ackResult: 'withdrawn' }));
  });

  it('asks the runner to cancel acked ASSIGNED and RUNNING jobs once, with the reason recorded', async () => {
    const assigned = await held('ASSIGNED');
    await assignCommand(assigned.id, true);
    const running = await held('RUNNING');
    const result = await cancel([assigned.id, running.id]);
    expect(result.requested).toEqual([assigned.id, running.id]);
    expect(result.wake).toEqual([runnerId, runnerId]);
    for (const id of [assigned.id, running.id]) {
      const row = await reload(id);
      expect(row.cancelRequestedAt).not.toBeNull();
      expect(row.cancelReason).toBe('budget:pol-1');
      expect(await prisma.fleetCommand.count({ where: { jobId: id, type: 'CANCEL', ackedAt: null } })).toBe(1);
    }
    expect((await reload(running.id)).state).toBe('RUNNING');
    const activity = await prisma.fleetActivity.findFirstOrThrow({ where: { jobId: running.id, action: 'job.cancel_requested' } });
    expect(activity).toEqual(expect.objectContaining({ actorType: 'SYSTEM', responsibleUserId: base.adminId }));
    // A second stop does not queue a second CANCEL.
    expect((await cancel([running.id])).requested).toEqual([]);
    expect(await prisma.fleetCommand.count({ where: { jobId: running.id, type: 'CANCEL' } })).toBe(1);
  });

  it('leaves UPLOADING, finished, user-cancel-pending and unknown jobs alone', async () => {
    const uploading = await held('UPLOADING');
    const done = await insertJob({ state: 'COMPLETED' });
    const pending = await held('RUNNING', { cancelRequestedAt: new Date() });
    const result = await cancel([uploading.id, done.id, pending.id, 'missing']);
    expect(result).toEqual({ cancelled: [], requested: [], live: [], wake: [] });
    expect((await reload(pending.id)).cancelReason).toBeNull();
  });
});
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-cancel.integration.spec.ts`
Expected: FAIL (`jobs.cancelForBudget is not a function`, or Nest cannot resolve `FleetJobsService` from the app
root until it is exported).

- [ ] **Step 2: Implement `cancelForBudget`**

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts`:

Imports: change the transitions import to
`import { JobTransitionsService, SYSTEM_ACTOR } from './job-transitions.service';` and extend the budget-rules import
to `import { budgetReason, jobGateKeys } from '../budgets/budget-rules';`.

Above the class:

```ts
/** What a budget stop did to its jobs (plan D157). Publish `live` and notify `wake` after the transaction commits. */
export interface BudgetCancelResult {
  /** Ended on the server: QUEUED, or ASSIGNED whose ASSIGN was never acked. */
  cancelled: string[];
  /** cancelRequestedAt + one CANCEL; the runner reports CANCELLED and keeps the budget reason (plan D156). */
  requested: string[];
  live: LiveFleetJobEvent[];
  wake: string[];
}
```

Inside the class, after `cancel(...)`:

```ts
  /**
   * S1b §2.2 hard stop: the scope's QUEUED jobs, and (runningJobs = cancel) its ASSIGNED and RUNNING jobs.
   * A system action: the activity actor is SYSTEM, the responsible user the policy's last editor.
   * Call inside txManager.run (the evaluator holds the policy lock); jobs are re-checked under their own row lock.
   */
  async cancelForBudget(jobIds: readonly string[], policy: { id: string; responsibleUserId: string }, now = new Date()): Promise<BudgetCancelResult> {
    const reason = budgetReason(policy.id);
    const result: BudgetCancelResult = { cancelled: [], requested: [], live: [], wake: [] };
    for (const id of jobIds) {
      const job = await this.repo.lockById(id);
      if (!job || job.cancelRequestedAt) continue;
      const unacked = job.state === FleetJobState.ASSIGNED &&
        (await this.repo.findPendingCommand({ jobId: id, type: FleetCommandType.ASSIGN, leaseEpoch: job.leaseEpoch })) !== null;
      if (job.state === FleetJobState.QUEUED || unacked) {
        const r = await this.transitions.apply({ job, to: FleetJobState.CANCELLED, by: 'server', now, actor: SYSTEM_ACTOR, reason, extra: { cancelReason: reason } });
        result.cancelled.push(id);
        result.live.push(r.live);
        continue;
      }
      if ((job.state !== FleetJobState.ASSIGNED && job.state !== FleetJobState.RUNNING) || !job.runnerId) continue;
      const updated = await this.repo.update(id, { cancelRequestedAt: now, cancelReason: reason });
      await this.repo.createCommand({ runnerId: job.runnerId, jobId: id, type: FleetCommandType.CANCEL, leaseEpoch: job.leaseEpoch, payload: {} });
      await this.repo.appendEvent(id, { leaseEpoch: job.leaseEpoch, runnerSeq: null, type: 'lifecycle', payload: { level: 'info', message: `cancel requested (${reason})` } });
      await this.activity.record({
        actorType: 'SYSTEM', actorId: SYSTEM_ACTOR.id, action: 'job.cancel_requested', entityType: 'job', entityId: id, jobId: id,
        projectId: job.projectId, responsibleUserId: policy.responsibleUserId, payload: { state: job.state, reason },
      });
      result.requested.push(id);
      result.live.push(this.live.event(updated));
      result.wake.push(job.runnerId);
    }
    return result;
  }
```

In `apps/api/src/fleet/jobs/fleet-jobs.module.ts`, add `FleetJobsService` to `exports`.

- [ ] **Step 3: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-cancel.integration.spec.ts test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts src/fleet/jobs/fleet-jobs.module.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/fleet/jobs apps/api/test/integration/fleet/fleet-budget-cancel.integration.spec.ts
git commit -m "feat(fleet): cancelForBudget for budget hard stops"
```

### Task 8: `BudgetEvaluator`, `BudgetsModule` and the post-sync signal

**Files:**
- Create: `apps/api/src/fleet/budgets/budget-payloads.ts`
- Create: `apps/api/src/fleet/budgets/budget-evaluator.ts`
- Create: `apps/api/src/fleet/budgets/budgets.module.ts`
- Modify: `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts` (`FleetEntityType` gains `'budget'`)
- Modify: `apps/api/src/fleet/activity/dto/list-fleet-activity.query.ts` (`'budget'` in the enum and `@IsIn`)
- Modify: `apps/api/src/fleet/sync/job-report.processor.ts` (full replacement below)
- Modify: `apps/api/src/fleet/sync/sync.module.ts`, `apps/api/src/fleet/fleet.module.ts` (import `BudgetsModule`)
- Test: `apps/api/src/fleet/budgets/budget-evaluator.spec.ts`, `apps/api/src/fleet/budgets/budgets.module.spec.ts`,
  `apps/api/test/integration/fleet/fleet-budget-evaluator.integration.spec.ts`

**Interfaces:**
- Consumes: `IBudgetRepository` (Task 4), rules (Task 3), `FleetJobsService.cancelForBudget` (Task 7),
  `WebhookDispatcherService.dispatch`, `FleetJobLivePublisher`, `RunnerNotifier`.
- Produces: `BudgetEvaluator.signal(scopeKeys: readonly string[]): void` (debounced 1 s per key, never throws);
  `BudgetEvaluator.evaluateScope(scopeKey, now?): Promise<void>`;
  `BudgetEvaluator.evaluate(policyId, now?): Promise<{ warned: boolean; stopped: boolean }>`;
  `budgetActivityPayload(policy, extra?)`, `budgetWebhookPayload(policy, spentUsd, windowStart)`;
  `BudgetsModule` exporting `BudgetEvaluator`.

- [ ] **Step 1: Write the failing debounce and module tests**

Create `apps/api/src/fleet/budgets/budget-evaluator.spec.ts`:

```ts
import { BudgetEvaluator } from './budget-evaluator';

describe('BudgetEvaluator.signal (S1b §2.2, B7)', () => {
  let evaluator: BudgetEvaluator;
  let evaluateScope: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    evaluator = new BudgetEvaluator({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    evaluateScope = jest.spyOn(evaluator, 'evaluateScope').mockResolvedValue(undefined);
  });
  afterEach(() => {
    evaluator.onModuleDestroy();
    jest.useRealTimers();
  });

  it('coalesces signals per scope key inside the 1 s window', () => {
    evaluator.signal(['global', 'project:p']);
    evaluator.signal(['global', 'repo:r', 'repo:r']);
    jest.advanceTimersByTime(999);
    expect(evaluateScope).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(evaluateScope.mock.calls.map(([key]) => key).sort()).toEqual(['global', 'project:p', 'repo:r']);
    evaluator.signal(['global']);
    jest.advanceTimersByTime(1_000);
    expect(evaluateScope).toHaveBeenCalledTimes(4);
  });

  it('drops pending evaluations on shutdown', () => {
    evaluator.signal(['global']);
    evaluator.onModuleDestroy();
    jest.advanceTimersByTime(5_000);
    expect(evaluateScope).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed evaluation', async () => {
    evaluateScope.mockRejectedValueOnce(new Error('db down'));
    evaluator.signal(['global']);
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(evaluateScope).toHaveBeenCalledTimes(1);
  });
});
```

Create `apps/api/src/fleet/budgets/budgets.module.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { BudgetEvaluator } from './budget-evaluator';
import { BudgetsModule } from './budgets.module';

/** DI guard, as fleet-jobs.module.spec.ts: a missing provider or an import cycle fails `bun run test`. */
describe('BudgetsModule', () => {
  it('compiles and resolves the evaluator', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, BudgetsModule] }).compile();
    try {
      expect(moduleRef.get(BudgetEvaluator)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
```

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/budget-evaluator.spec.ts src/fleet/budgets/budgets.module.spec.ts`
Expected: FAIL (`Cannot find module './budget-evaluator'`).

- [ ] **Step 2: Payload helpers and the activity entity type**

Create `apps/api/src/fleet/budgets/budget-payloads.ts`:

```ts
import type { BudgetPolicyRecord } from './domain/budget.domain';

/**
 * FleetActivity payload of a budget row. Never a `*Key` field: FleetActivityService rejects key-like names
 * (`/token|secret|key|password|credential/i`), so the scope is scopeType + scopeId.
 */
export function budgetActivityPayload(p: BudgetPolicyRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scopeType: p.scopeType, scopeId: p.scopeId, windowKind: p.windowKind, amountUsd: p.amountUsd, ...extra };
}

/** Body of the fleet.budget.warn and fleet.budget.hard_stop webhooks (S1b §4). */
export function budgetWebhookPayload(p: BudgetPolicyRecord, spentUsd: string, windowStart: Date): Record<string, unknown> {
  return {
    policyId: p.id, scopeType: p.scopeType, scopeId: p.scopeId, projectId: p.projectId, windowKind: p.windowKind,
    windowStart: windowStart.toISOString(), amountUsd: p.amountUsd, warnPercent: p.warnPercent, spentUsd,
  };
}
```

In `apps/api/src/fleet/activity/domain/fleet-activity.domain.ts`:
`export type FleetEntityType = 'runner' | 'enrollment' | 'repo' | 'job' | 'budget';`

In `apps/api/src/fleet/activity/dto/list-fleet-activity.query.ts`, both the `enum` and the `@IsIn` list become
`['runner', 'enrollment', 'repo', 'job', 'budget']`.

- [ ] **Step 3: Implement the evaluator and the module**

Create `apps/api/src/fleet/budgets/budget-evaluator.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { budgetActivityPayload, budgetWebhookPayload } from './budget-payloads';
import { hardReached, isEffectivelyPaused, spendSince, warnReached, windowStart } from './budget-rules';
import { BUDGET_REPOSITORY, BudgetPolicyRecord, IBudgetRepository } from './domain/budget.domain';

const DEBOUNCE_MS = 1_000;

export interface EvaluationResult {
  /** A warn incident was inserted by this evaluation. */
  warned: boolean;
  /** This evaluation paused the policy. */
  stopped: boolean;
}

const NOTHING = Object.freeze({ result: { warned: false, stopped: false }, live: [] as LiveFleetJobEvent[], wake: [] as string[] });

/**
 * S1b §2.2 (B7). Signalled by JobReportProcessor after a sync changed a job's cost, debounced per scope key;
 * the BudgetSweeper calls `evaluate` every 60 s as the backstop. In process: the API is single-instance.
 */
@Injectable()
export class BudgetEvaluator implements OnModuleDestroy {
  private readonly logger = new Logger(BudgetEvaluator.name);
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly repo: IBudgetRepository,
    private readonly jobs: FleetJobsService,
    private readonly activity: FleetActivityService,
    private readonly webhooks: WebhookDispatcherService,
    private readonly live: FleetJobLivePublisher,
    private readonly notifier: RunnerNotifier,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Never throws; a failed evaluation is logged and the sweep retries it. */
  signal(scopeKeys: readonly string[]): void {
    for (const key of new Set(scopeKeys)) {
      if (this.pending.has(key)) continue;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this.evaluateScope(key).catch((error: unknown) =>
          this.logger.error(`Budget evaluation for ${key} failed: ${error instanceof Error ? error.message : String(error)}`));
      }, DEBOUNCE_MS);
      timer.unref();
      this.pending.set(key, timer);
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  async evaluateScope(scopeKey: string, now = new Date()): Promise<void> {
    for (const policy of await this.repo.findByScopeKeys([scopeKey])) await this.evaluate(policy.id, now);
  }

  /** One policy under its row lock: a debounced signal and the sweep can run at once. */
  async evaluate(policyId: string, now = new Date()): Promise<EvaluationResult> {
    const { result, live, wake } = await this.txManager.run(async () => {
      const policy = await this.repo.lockById(policyId);
      // A policy whose scope row is gone is ignored; the sweep deletes it (S1b §2.1).
      if (!policy || !(await this.repo.scopeExists(policy))) return NOTHING;
      const start = windowStart(policy.windowKind, now);
      const spent = await this.repo.windowSpend(policy, spendSince(policy.windowKind, now));
      const warned = warnReached(spent, policy.amountUsd, policy.warnPercent) ? await this.warn(policy, start, spent) : false;
      if (!policy.hardStop || isEffectivelyPaused(policy, now) || !hardReached(spent, policy.amountUsd)) {
        return { result: { warned, stopped: false }, live: [] as LiveFleetJobEvent[], wake: [] as string[] };
      }
      const stop = await this.hardStop(policy, start, spent, now);
      return { result: { warned, stopped: true }, ...stop };
    });
    this.live.publish(live);
    for (const runnerId of new Set(wake)) this.notifier.notify(runnerId);
    return result;
  }

  private async warn(policy: BudgetPolicyRecord, start: Date, spent: string): Promise<boolean> {
    const inserted = await this.repo.insertIncident({ policyId: policy.id, kind: 'warn', windowStart: start, spentUsd: spent, amountUsd: policy.amountUsd, actorId: null });
    if (!inserted) return false;
    await this.record('budget.warn', policy, { spentUsd: spent });
    if (policy.projectId) await this.webhooks.dispatch(policy.projectId, 'fleet.budget.warn', budgetWebhookPayload(policy, spent, start));
    return true;
  }

  private async hardStop(policy: BudgetPolicyRecord, start: Date, spent: string, now: Date): Promise<{ live: LiveFleetJobEvent[]; wake: string[] }> {
    await this.repo.update(policy.id, { pausedAt: now, pausedWindowStart: start });
    const inserted = await this.repo.insertIncident({ policyId: policy.id, kind: 'hard_stop', windowStart: start, spentUsd: spent, amountUsd: policy.amountUsd, actorId: null });
    const queued = await this.repo.findQueuedJobIds(policy);
    const held = policy.runningJobs === 'cancel' ? await this.repo.findHeldJobIds(policy) : [];
    const cancel = await this.jobs.cancelForBudget([...queued, ...held], { id: policy.id, responsibleUserId: policy.updatedById }, now);
    await this.record('budget.hard_stop', policy, { spentUsd: spent, cancelledJobIds: cancel.cancelled, cancelRequestedJobIds: cancel.requested });
    if (inserted && policy.projectId) await this.webhooks.dispatch(policy.projectId, 'fleet.budget.hard_stop', budgetWebhookPayload(policy, spent, start));
    return { live: cancel.live, wake: cancel.wake };
  }

  private record(action: string, policy: BudgetPolicyRecord, extra: Record<string, unknown>): Promise<void> {
    return this.activity.record({
      actorType: 'SYSTEM', actorId: SYSTEM_ACTOR.id, action, entityType: 'budget', entityId: policy.id,
      projectId: policy.projectId, responsibleUserId: policy.updatedById, payload: budgetActivityPayload(policy, extra),
    });
  }
}
```

Create `apps/api/src/fleet/budgets/budgets.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { BudgetEvaluator } from './budget-evaluator';
import { BudgetStoreModule } from './budget-store.module';

/** S1b §2 C1 budgets (plan D160): evaluator, sweeper, management. */
@Module({
  imports: [PrismaModule, BudgetStoreModule, FleetJobsModule, FleetActivityModule, WebhookModule],
  providers: [BudgetEvaluator],
  exports: [BudgetEvaluator],
})
export class BudgetsModule {}
```

Add `BudgetsModule` to the `imports` of `apps/api/src/fleet/sync/sync.module.ts` and
`apps/api/src/fleet/fleet.module.ts` (`import { BudgetsModule } from '../budgets/budgets.module';` and
`'./budgets/budgets.module'` respectively).

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/budget-evaluator.spec.ts src/fleet/budgets/budgets.module.spec.ts src/fleet/fleet.module.spec.ts`
Expected: PASS.

- [ ] **Step 4: Signal after the sync transaction**

Replace `apps/api/src/fleet/sync/job-report.processor.ts` with (only `process` is restructured; `applyOne` keeps the
Task 2 reason rule):

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Prisma } from '@prisma/client';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { BudgetEvaluator } from '../budgets/budget-evaluator';
import { jobSpendKeys } from '../budgets/budget-rules';
import type { JobAck, JobReport } from '../common/protocol';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { canTransition } from '../jobs/job-state';
import { JobTransitionsService } from '../jobs/job-transitions.service';
import { FLEET_JOB_REPOSITORY, FleetJobEventRecord, FleetJobRecord, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { interpretEvent } from './event-payloads';
import { FenceService } from './fence.service';
import { stableStringify } from './stable-json';

export interface ReportOutcome {
  ack: JobAck | null;
  unknown: boolean;
  live: LiveFleetJobEvent[];
}

/** The outcome plus the job after the report when its costSpentUsd changed (S1b §2.2 signal). */
interface Processed {
  outcome: ReportOutcome;
  spent: FleetJobRecord | null;
}

const NONE: ReportOutcome = Object.freeze({ ack: null, unknown: false, live: [] });

/** Plan D156: a server-requested cancel keeps its reason (e.g. `budget:<policyId>`) over the runner's. */
function cancelReasonFor(job: FleetJobRecord, to: string, reported: string | null): string | null {
  return to === 'CANCELLED' && job.cancelReason ? job.cancelReason : reported;
}

const costChanged = (before: FleetJobRecord, after: FleetJobRecord): boolean =>
  !new Prisma.Decimal(before.costSpentUsd).eq(after.costSpentUsd);

/**
 * One job's events from one sync, in one transaction (spec §3.2, plan D2/D5/D6): fence,
 * dedup on (epoch, runnerSeq), store, then apply only the contiguous prefix above the
 * cumulative ack. A resent seq with a different payload rejects the whole report.
 * A cost change signals the budget evaluator after the transaction (S1b §2.2).
 */
@Injectable()
export class JobReportProcessor {
  private readonly logger = new Logger(JobReportProcessor.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly transitions: JobTransitionsService,
    private readonly live: FleetJobLivePublisher,
    private readonly fence: FenceService,
    private readonly activity: FleetActivityService,
    private readonly budgets: BudgetEvaluator,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async process(runnerId: string, report: JobReport, now: Date): Promise<ReportOutcome> {
    const { outcome, spent } = await this.txManager.run(() => this.processLocked(runnerId, report, now));
    // S1b §2.2: no budget query inside the sync transaction; the evaluator runs after it commits.
    if (spent) this.budgets.signal(jobSpendKeys(spent));
    return outcome;
  }

  private async processLocked(runnerId: string, report: JobReport, now: Date): Promise<Processed> {
    const job = await this.repo.lockById(report.jobId);
    if (!job) return { outcome: { ...NONE, unknown: true }, spent: null };
    if (!this.fence.holds(job, runnerId, report.leaseEpoch)) {
      await this.fence.abandon(runnerId, job, report.leaseEpoch);
      return { outcome: NONE, spent: null };
    }
    const events = [...report.events].sort((a, b) => a.seq - b.seq);
    const stored = new Map((await this.repo.findRunnerEvents(job.id, job.leaseEpoch, events.map((e) => e.seq))).map((e) => [e.runnerSeq, e]));
    const conflict = events.find((e) => {
      const prior = stored.get(e.seq);
      return prior !== undefined && (prior.type !== e.type || stableStringify(prior.payload) !== stableStringify(e.payload));
    });
    if (conflict) {
      this.logger.warn(`Protocol error: job ${job.id} epoch ${job.leaseEpoch} seq ${conflict.seq} resent with a different payload`);
      return { outcome: { ...NONE, ack: { jobId: job.id, ackedSeq: job.ackedRunnerSeq } }, spent: null };
    }
    for (const e of events) {
      if (!stored.has(e.seq)) await this.repo.appendEvent(job.id, { leaseEpoch: job.leaseEpoch, runnerSeq: e.seq, type: e.type, payload: e.payload });
    }
    return this.applyContiguous(job, runnerId, now);
  }

  private async applyContiguous(job: FleetJobRecord, runnerId: string, now: Date): Promise<Processed> {
    let current = job;
    let next = job.ackedRunnerSeq + 1;
    let mirrored = false;
    const live: LiveFleetJobEvent[] = [];
    for (const event of await this.repo.findRunnerEventsAfter(job.id, job.leaseEpoch, job.ackedRunnerSeq)) {
      if (event.runnerSeq !== next) break;
      const applied = await this.applyOne(current, event, runnerId, now);
      current = applied.job;
      if (applied.live) live.push(applied.live);
      mirrored = mirrored || applied.mirrored;
      next += 1;
    }
    const ackedSeq = next - 1;
    if (ackedSeq !== job.ackedRunnerSeq) current = await this.repo.update(job.id, { ackedRunnerSeq: ackedSeq });
    if (mirrored && live.length === 0) live.push(this.live.event(current));
    return { outcome: { ack: { jobId: job.id, ackedSeq }, unknown: false, live }, spent: costChanged(job, current) ? current : null };
  }

  private async applyOne(job: FleetJobRecord, event: FleetJobEventRecord, runnerId: string, now: Date): Promise<{ job: FleetJobRecord; live?: LiveFleetJobEvent; mirrored: boolean }> {
    const effect = interpretEvent(event.type, event.payload);
    if (effect.kind === 'none') return { job, mirrored: false };
    if (effect.kind === 'mirror') return { job: await this.repo.update(job.id, effect.patch), mirrored: true };
    if (effect.kind === 'transition' && canTransition(job.state, effect.to, 'runner')) {
      const r = await this.transitions.apply({
        job, to: effect.to, by: 'runner', now, actor: { type: 'RUNNER', id: runnerId }, reason: cancelReasonFor(job, effect.to, effect.reason),
        extra: effect.exitCode === null ? {} : { exitCode: effect.exitCode },
      });
      return { job: r.job, live: r.live, mirrored: false };
    }
    const reason = effect.kind === 'invalid' ? effect.reason : `transition ${job.state} -> ${effect.to}`;
    this.logger.warn(`Rejected runner event on job ${job.id} (runnerSeq ${event.runnerSeq}): ${reason}`);
    await this.activity.record({
      actorType: 'RUNNER', actorId: runnerId, action: 'job.event_rejected', entityType: 'job', entityId: job.id, jobId: job.id,
      projectId: job.projectId, responsibleUserId: job.requestedById, payload: { runnerSeq: event.runnerSeq, type: event.type, reason },
    });
    return { job, mirrored: false };
  }
}
```

Before replacing, diff the current file against this text: apart from the Task 2 `cancelReasonFor` lines it must
match the pre-slice file except for `process`/`processLocked`/`Processed`/`costChanged`/the `budgets` constructor
parameter. If the current file has changed in another way since this plan was written, keep that change.

- [ ] **Step 5: Write the failing evaluator integration test**

Create `apps/api/test/integration/fleet/fleet-budget-evaluator.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 2a — BudgetEvaluator on PG: warn once, hard stop, cancel set, webhooks, concurrency, the sync signal.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-evaluator.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { JobReportProcessor } from '../../../src/fleet/sync/job-report.processor';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('budget evaluator (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let evaluator: BudgetEvaluator;
  let reports: JobReportProcessor;
  let n = 0;
  const now = () => new Date();
  const monthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

  const projectPolicy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: 50,
      createdById: world.ids.root, updatedById: world.ids.dev, ...over,
    },
  });
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `ev${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });
  const incidents = (policyId: string, kind: string) => prisma.budgetIncident.count({ where: { policyId, kind } });
  const hooks = (event: string) => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: `"event":"${event}"` } } });
  const reload = (id: string) => prisma.fleetJob.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    evaluator = app.get(BudgetEvaluator);
    reports = app.get(JobReportProcessor);
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.budget.warn', 'fleet.budget.hard_stop']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('warns once per window and amount, with one webhook and one activity row', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 6 });
    expect(await evaluator.evaluate(policy.id)).toEqual({ warned: true, stopped: false });
    expect(await evaluator.evaluate(policy.id)).toEqual({ warned: false, stopped: false });
    expect(await incidents(policy.id, 'warn')).toBe(1);
    expect(await hooks('fleet.budget.warn')).toBe(1);
    expect(await prisma.fleetActivity.count({ where: { entityType: 'budget', entityId: policy.id, action: 'budget.warn' } })).toBe(1);
  });

  it('hard stop under finish: pauses, cancels QUEUED in scope, leaves RUNNING alone', async () => {
    const policy = await projectPolicy();
    const runner = await insertRunner(prisma);
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1 });
    expect(await evaluator.evaluate(policy.id)).toEqual({ warned: true, stopped: true });
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after.pausedAt).not.toBeNull();
    expect(after.pausedWindowStart).toEqual(monthStart(now()));
    expect(await reload(queued.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: `budget:${policy.id}` }));
    expect(await reload(running.id)).toEqual(expect.objectContaining({ state: 'RUNNING', cancelRequestedAt: null }));
    expect(await prisma.fleetCommand.count({ where: { jobId: running.id, type: 'CANCEL' } })).toBe(0);
    expect(await incidents(policy.id, 'hard_stop')).toBe(1);
    expect(await hooks('fleet.budget.hard_stop')).toBe(1);
    const row = await prisma.fleetActivity.findFirstOrThrow({ where: { entityId: policy.id, action: 'budget.hard_stop' } });
    expect(row).toEqual(expect.objectContaining({ actorType: 'SYSTEM', projectId: world.projectId, responsibleUserId: world.ids.dev }));
    expect(row.payload).toEqual(expect.objectContaining({ cancelledJobIds: [queued.id], cancelRequestedJobIds: [] }));
    // Already paused: no second stop.
    expect(await evaluator.evaluate(policy.id)).toEqual({ warned: false, stopped: false });
  });

  it('hard stop under cancel: the runner\'s CANCELLED report ends the job with the budget reason', async () => {
    const policy = await projectPolicy({ runningJobs: 'cancel' });
    const runner = await insertRunner(prisma);
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1, costSpentUsd: 11 });
    await evaluator.evaluate(policy.id);
    expect(await prisma.fleetCommand.count({ where: { jobId: running.id, type: 'CANCEL', ackedAt: null } })).toBe(1);
    await reports.process(runner.id, { jobId: running.id, leaseEpoch: 1, events: [{ seq: 1, type: 'state', payload: { to: 'CANCELLED', reason: null } }] }, new Date());
    expect(await reload(running.id)).toEqual(expect.objectContaining({ state: 'CANCELLED', stateReason: `budget:${policy.id}` }));
  });

  it('stops again in the same month after the amount was raised (incident per amount)', async () => {
    const policy = await projectPolicy({ warnPercent: null });
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { amountUsd: new Prisma.Decimal(15), pausedAt: null, pausedWindowStart: null } });
    await job({ costSpentUsd: 5 });
    expect((await evaluator.evaluate(policy.id)).stopped).toBe(true);
    expect(await incidents(policy.id, 'hard_stop')).toBe(2);
    expect(await hooks('fleet.budget.hard_stop')).toBe(2);
  });

  it('sends no webhook for a global policy, and ignores a policy whose runner is gone', async () => {
    const global = await prisma.budgetPolicy.create({
      data: { scopeType: 'global', scopeKey: 'global', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(1), createdById: world.ids.root, updatedById: world.ids.root },
    });
    await job({ costSpentUsd: 2 });
    expect((await evaluator.evaluate(global.id)).stopped).toBe(true);
    expect(await hooks('fleet.budget.hard_stop')).toBe(0);
    const orphan = await prisma.budgetPolicy.create({
      data: { scopeType: 'runner', scopeId: 'gone', scopeKey: 'runner:gone', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(0.0001), createdById: world.ids.root, updatedById: world.ids.root },
    });
    expect(await evaluator.evaluate(orphan.id)).toEqual({ warned: false, stopped: false });
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: orphan.id } })).pausedAt).toBeNull();
  });

  it('two concurrent evaluations stop once (review focus 3)', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    const results = await Promise.all([evaluator.evaluate(policy.id), evaluator.evaluate(policy.id)]);
    expect(results.filter((r) => r.stopped)).toHaveLength(1);
    expect(await incidents(policy.id, 'hard_stop')).toBe(1);
    expect(await hooks('fleet.budget.hard_stop')).toBe(1);
    expect(await prisma.fleetActivity.count({ where: { jobId: queued.id, action: 'job.cancelled' } })).toBe(1);
  });

  it('signals the job\'s scope keys after a sync that changed its cost, and only then', async () => {
    const runner = await insertRunner(prisma);
    const running = await job({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1 });
    const signal = jest.spyOn(evaluator, 'signal').mockImplementation(() => undefined);
    try {
      const snapshot = (seq: number, costSpentUsd: string) =>
        reports.process(runner.id, { jobId: running.id, leaseEpoch: 1, events: [{ seq, type: 'snapshot', payload: { costSpentUsd } }] }, new Date());
      await snapshot(1, '0.5');
      expect(signal).toHaveBeenCalledWith(['global', `project:${world.projectId}`, `repo:${world.repoId}`, `runner:${runner.id}`]);
      signal.mockClear();
      await snapshot(2, '0.5');
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
    }
  });
});
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-evaluator.integration.spec.ts`
Expected: PASS for every case once Steps 3-4 are in. If you wrote this test before Step 4, the last case FAILS
(`signal` never called). The direct `reports.process` calls pass the fence because `FenceService.holds` compares only
`runnerId` and `leaseEpoch`, which the inserted jobs set.

- [ ] **Step 6: Run the touched suites**

Run: `cd apps/api && bun run type-check && bun run test:scoped test/integration/fleet/fleet-budget-evaluator.integration.spec.ts test/integration/fleet/runner-sync.integration.spec.ts test/integration/fleet/runner-sync-lifecycle.integration.spec.ts test/integration/fleet/fleet-budget-lifecycle.integration.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-budget-evaluator.integration.spec.ts
git commit -m "feat(fleet): budget evaluator with warn, hard stop and the post-sync signal"
```

### Task 9: `BudgetSweeper` — backstop, monthly rollover, orphans

**Files:**
- Create: `apps/api/src/fleet/budgets/budget-sweeper.ts`
- Modify: `apps/api/src/fleet/budgets/budgets.module.ts` (provider)
- Test: `apps/api/src/fleet/budgets/budget-sweeper.spec.ts`,
  `apps/api/test/integration/fleet/fleet-budget-sweeper.integration.spec.ts`

**Interfaces:**
- Consumes: `BudgetEvaluator.evaluate` (Task 8), `isStaleMonthlyPause`, `windowStart`, `budgetActivityPayload`.
- Produces: `BudgetSweeper.tick(now?): Promise<BudgetSweepResult>` with
  `BudgetSweepResult { deleted: number; reset: number; evaluated: number; failed: number }`; a 60 s timer gated by
  `fleetConfig.sweepEnabled`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/fleet/budgets/budget-sweeper.spec.ts`:

```ts
import { BudgetSweeper } from './budget-sweeper';
import type { BudgetPolicyRecord } from './domain/budget.domain';

const NOW = new Date('2026-10-15T00:00:00.000Z');
const policy = (id: string): BudgetPolicyRecord => ({
  id, scopeType: 'global', scopeId: null, scopeKey: 'global', projectId: null, windowKind: 'lifetime', amountUsd: '1',
  warnPercent: null, hardStop: true, runningJobs: 'finish', pausedAt: null, pausedWindowStart: null,
  createdById: 'u', updatedById: 'u', createdAt: NOW, updatedAt: NOW,
});

describe('BudgetSweeper', () => {
  it('keeps sweeping after one policy fails', async () => {
    const repo = { findAll: jest.fn(async () => [policy('a'), policy('b')]), scopeExists: jest.fn(async () => true) };
    const evaluator = { evaluate: jest.fn(async (id: string) => { if (id === 'a') throw new Error('boom'); return { warned: false, stopped: false }; }) };
    const sweeper = new BudgetSweeper(repo as never, evaluator as never, {} as never, {} as never, { sweepEnabled: false });
    expect(await sweeper.tick(NOW)).toEqual({ deleted: 0, reset: 0, evaluated: 1, failed: 1 });
    expect(evaluator.evaluate).toHaveBeenCalledWith('b', NOW);
  });

  it('starts no timer when the sweep is disabled', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const sweeper = new BudgetSweeper({} as never, {} as never, {} as never, {} as never, { sweepEnabled: false });
    sweeper.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/budget-sweeper.spec.ts`
Expected: FAIL (`Cannot find module './budget-sweeper'`).

- [ ] **Step 2: Implement the sweeper**

Create `apps/api/src/fleet/budgets/budget-sweeper.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { BudgetEvaluator } from './budget-evaluator';
import { budgetActivityPayload } from './budget-payloads';
import { isStaleMonthlyPause, windowStart } from './budget-rules';
import { BUDGET_REPOSITORY, BudgetPolicyRecord, IBudgetRepository } from './domain/budget.domain';

const SWEEP_INTERVAL_MS = 60_000;

export interface BudgetSweepResult {
  deleted: number;
  reset: number;
  evaluated: number;
  failed: number;
}

/**
 * S1b §2.2 sweep, on the FleetSweeper pattern: every 60 s it deletes policies whose scope row is gone,
 * clears monthly pauses from an earlier window (B8), and evaluates every policy (the B7 backstop).
 */
@Injectable()
export class BudgetSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BudgetSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly repo: IBudgetRepository,
    private readonly evaluator: BudgetEvaluator,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled'>,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.logger.error(`Budget sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One failing policy is logged and skipped; the rest still run. */
  async tick(now = new Date()): Promise<BudgetSweepResult> {
    const result: BudgetSweepResult = { deleted: 0, reset: 0, evaluated: 0, failed: 0 };
    for (const policy of await this.repo.findAll()) {
      try {
        if (!(await this.repo.scopeExists(policy))) {
          if (await this.deleteOrphan(policy.id)) result.deleted += 1;
          continue;
        }
        if (isStaleMonthlyPause(policy, now) && (await this.resetWindow(policy.id, now))) result.reset += 1;
        await this.evaluator.evaluate(policy.id, now);
        result.evaluated += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(`Budget sweep: policy ${policy.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /** S1b §2.1: a policy whose scope row is gone is deleted with its incidents. Re-checked under the lock. */
  private deleteOrphan(id: string): Promise<boolean> {
    return this.txManager.run(async () => {
      const policy = await this.repo.lockById(id);
      if (!policy || (await this.repo.scopeExists(policy))) return false;
      await this.repo.delete(id);
      await this.record('budget.deleted', policy, { reason: 'scope_gone' });
      return true;
    });
  }

  /** B8: clear a monthly pause from an earlier window and record the rollover. */
  private resetWindow(id: string, now: Date): Promise<boolean> {
    return this.txManager.run(async () => {
      const policy = await this.repo.lockById(id);
      if (!policy || !isStaleMonthlyPause(policy, now)) return false;
      const start = windowStart(policy.windowKind, now);
      const spent = await this.repo.windowSpend(policy, start);
      await this.repo.update(id, { pausedAt: null, pausedWindowStart: null });
      await this.repo.insertIncident({ policyId: id, kind: 'window_reset', windowStart: start, spentUsd: spent, amountUsd: policy.amountUsd, actorId: null });
      await this.record('budget.window_reset', policy, { spentUsd: spent, windowStart: start.toISOString() });
      return true;
    });
  }

  private record(action: string, policy: BudgetPolicyRecord, extra: Record<string, unknown>): Promise<void> {
    return this.activity.record({
      actorType: 'SYSTEM', actorId: SYSTEM_ACTOR.id, action, entityType: 'budget', entityId: policy.id,
      projectId: policy.projectId, responsibleUserId: policy.updatedById, payload: budgetActivityPayload(policy, extra),
    });
  }
}
```

In `apps/api/src/fleet/budgets/budgets.module.ts`, `providers: [BudgetEvaluator, BudgetSweeper]`
(`import { BudgetSweeper } from './budget-sweeper';`).

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/budget-sweeper.spec.ts src/fleet/budgets/budgets.module.spec.ts`
Expected: PASS.

- [ ] **Step 3: Write the integration test**

Create `apps/api/test/integration/fleet/fleet-budget-sweeper.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 2a — BudgetSweeper on PG: rollover (B8), orphans, backstop evaluation.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-sweeper.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { BudgetSweeper } from '../../../src/fleet/budgets/budget-sweeper';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('budget sweeper (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let sweeper: BudgetSweeper;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  const NOV = new Date('2026-11-03T00:00:00.000Z');
  const OCT_START = new Date('2026-10-01T00:00:00.000Z');
  const NOV_START = new Date('2026-11-01T00:00:00.000Z');
  let n = 0;

  const policy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: base.projectId, scopeKey: `project:${base.projectId}`, projectId: base.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), createdById: base.adminId, updatedById: base.adminId, ...over,
    },
  });
  const spend = (usd: number, firstStartedAt: Date) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `sw${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, state: 'COMPLETED', costSpentUsd: usd, firstStartedAt,
    },
  });
  const reload = (id: string) => prisma.budgetPolicy.findUnique({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    sweeper = app.get(BudgetSweeper);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('clears a monthly pause when the month rolls over, and keeps a lifetime pause (B8)', async () => {
    await spend(12, new Date('2026-10-20T00:00:00.000Z'));
    const monthly = await policy({ pausedAt: new Date('2026-10-20T00:00:00.000Z'), pausedWindowStart: OCT_START });
    const lifetime = await policy({ scopeKey: `project:${base.projectId}`, windowKind: 'lifetime', amountUsd: new Prisma.Decimal(100), pausedAt: OCT_START, pausedWindowStart: new Date(0) });
    const result = await sweeper.tick(NOV);
    expect(result).toEqual(expect.objectContaining({ reset: 1, deleted: 0, failed: 0 }));
    expect(await reload(monthly.id)).toEqual(expect.objectContaining({ pausedAt: null, pausedWindowStart: null }));
    expect((await reload(lifetime.id))?.pausedAt).not.toBeNull();
    const reset = await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: monthly.id, kind: 'window_reset' } });
    expect(reset.windowStart).toEqual(NOV_START);
    expect(reset.spentUsd.toString()).toBe('0');
    expect(await prisma.fleetActivity.count({ where: { entityId: monthly.id, action: 'budget.window_reset' } })).toBe(1);
  });

  it('pauses again in the same tick when the new month is already over budget', async () => {
    await spend(11, new Date('2026-11-02T00:00:00.000Z'));
    const monthly = await policy({ pausedAt: OCT_START, pausedWindowStart: OCT_START });
    await sweeper.tick(NOV);
    expect(await reload(monthly.id)).toEqual(expect.objectContaining({ pausedWindowStart: NOV_START }));
    expect(await prisma.budgetIncident.count({ where: { policyId: monthly.id, kind: 'hard_stop' } })).toBe(1);
  });

  it('evaluates every policy as the backstop', async () => {
    await spend(10, new Date());
    const p = await policy({ windowKind: 'lifetime' });
    expect((await sweeper.tick()).evaluated).toBe(1);
    expect((await reload(p.id))?.pausedAt).not.toBeNull();
  });

  it('deletes the policy of a gone runner with its incidents; the leftover never blocks a dispatch (review focus 5)', async () => {
    const runner = await insertRunner(prisma);
    const orphan = await policy({
      scopeType: 'runner', scopeId: runner.id, scopeKey: `runner:${runner.id}`, projectId: null, windowKind: 'lifetime',
      pausedAt: new Date(), pausedWindowStart: new Date(0),
    });
    await prisma.budgetIncident.create({ data: { policyId: orphan.id, kind: 'hard_stop', windowStart: new Date(0), spentUsd: new Prisma.Decimal(1), amountUsd: new Prisma.Decimal(1) } });
    await prisma.runner.delete({ where: { id: runner.id } });
    const dispatched = await app.get(FleetJobsService).dispatch(base.adminId, base.projectId, { repoId: base.repoId, command: 'RUN', feature: 'after-orphan', maxCostUsd: 5 });
    expect(dispatched.job.state).toBe('QUEUED');
    expect((await sweeper.tick()).deleted).toBe(1);
    expect(await reload(orphan.id)).toBeNull();
    expect(await prisma.budgetIncident.count({ where: { policyId: orphan.id } })).toBe(0);
    expect(await prisma.fleetActivity.count({ where: { entityId: orphan.id, action: 'budget.deleted' } })).toBe(1);
  });
});
```

Note on the lifetime policy above: it reuses the project scope key with the other window kind; the unique index is
`(scopeKey, windowKind)`, so both rows are allowed.

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-sweeper.integration.spec.ts`
Expected: PASS (4 cases).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/fleet/budgets apps/api/test/integration/fleet/fleet-budget-sweeper.integration.spec.ts
git commit -m "feat(fleet): budget sweeper for rollover, orphans and the evaluation backstop"
```

### Task 10: Management — DTOs, `BudgetsService`, both route prefixes

**Files:**
- Create: `apps/api/src/fleet/budgets/dto/create-budget-policy.dto.ts`
- Create: `apps/api/src/fleet/budgets/dto/update-budget-policy.dto.ts`
- Create: `apps/api/src/fleet/budgets/dto/resume-budget-policy.dto.ts`
- Create: `apps/api/src/fleet/budgets/dto/budget-policy.dto.ts`
- Create: `apps/api/src/fleet/budgets/budgets.service.ts`
- Create: `apps/api/src/fleet/budgets/fleet-budgets.controller.ts`
- Create: `apps/api/src/fleet/budgets/project-fleet-budgets.controller.ts`
- Modify: `apps/api/src/fleet/budgets/budgets.module.ts` (controllers, service, `ProjectAccessModule`)
- Test: `apps/api/src/fleet/budgets/dto/budget-dtos.spec.ts`,
  `apps/api/test/integration/fleet/fleet-budgets-api.integration.spec.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 8.
- Produces: routes `GET|POST /fleet/budgets`, `PATCH|DELETE /fleet/budgets/:id`, `POST /fleet/budgets/:id/resume`
  (global ADMIN) and the same five under `/projects/:slug/fleet/budgets` (list: member; the rest: project ADMIN or
  global ADMIN); `BudgetsService.resume(actorId, route, id, amountUsd?)` — the method C8 will call (B1);
  `BudgetPolicyDto` (with `spentUsd`, `windowStart`, `paused`, `warnReached`); `DEFAULT_WARN_PERCENT = 80`.

- [ ] **Step 1: Write the failing DTO test**

Create `apps/api/src/fleet/budgets/dto/budget-dtos.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBudgetPolicyDto } from './create-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './resume-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './update-budget-policy.dto';

const errors = (cls: new () => object, body: object): string[] =>
  validateSync(plainToInstance(cls, body)).map((e) => e.property);

describe('budget DTOs (S1b §2.1, §2.4)', () => {
  const create = { scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 50 };

  it('accepts a minimal create, an explicit null warnPercent, and the full option set', () => {
    expect(errors(CreateBudgetPolicyDto, create)).toEqual([]);
    expect(errors(CreateBudgetPolicyDto, { ...create, warnPercent: null })).toEqual([]);
    expect(errors(CreateBudgetPolicyDto, { ...create, scopeType: 'runner', scopeId: 'r1', warnPercent: 90, hardStop: false, runningJobs: 'cancel' })).toEqual([]);
  });

  it.each([
    ['scopeType', { scopeType: 'team' }],
    ['windowKind', { windowKind: 'week' }],
    ['amountUsd', { amountUsd: 0 }],
    ['amountUsd', { amountUsd: 1.00001 }],
    ['amountUsd', { amountUsd: 1_000_001 }],
    ['warnPercent', { warnPercent: 0 }],
    ['warnPercent', { warnPercent: 100 }],
    ['warnPercent', { warnPercent: 50.5 }],
    ['runningJobs', { runningJobs: 'kill' }],
  ])('rejects a bad %s on create', (property, over) => {
    expect(errors(CreateBudgetPolicyDto, { ...create, ...over })).toContain(property);
  });

  it('treats an omitted update field as unchanged and rejects an explicit null amount', () => {
    expect(errors(UpdateBudgetPolicyDto, {})).toEqual([]);
    expect(errors(UpdateBudgetPolicyDto, { warnPercent: null })).toEqual([]);
    expect(errors(UpdateBudgetPolicyDto, { amountUsd: null })).toContain('amountUsd');
    expect(errors(ResumeBudgetPolicyDto, {})).toEqual([]);
    expect(errors(ResumeBudgetPolicyDto, { amountUsd: -1 })).toContain('amountUsd');
  });
});
```

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/dto/budget-dtos.spec.ts`
Expected: FAIL (`Cannot find module './create-budget-policy.dto'`).

- [ ] **Step 2: Implement the DTOs**

Create `apps/api/src/fleet/budgets/dto/create-budget-policy.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min, ValidateIf } from 'class-validator';
import {
  BUDGET_RUNNING_JOBS, BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS, BudgetRunningJobs, BudgetScopeType, BudgetWindowKind,
} from '../domain/budget.domain';

export const MAX_BUDGET_USD = 1_000_000;
/** Validators run only for a value that is present and not null: null means "no warn". */
export const whenSet = (_o: unknown, v: unknown): boolean => v !== undefined && v !== null;
/** Validators run for any present value, so an explicit null fails (`@IsOptional` would let it through). */
export const whenProvided = (_o: unknown, v: unknown): boolean => v !== undefined;

export class CreateBudgetPolicyDto {
  @ApiProperty({ enum: BUDGET_SCOPE_TYPES, description: 'global and runner on /fleet/budgets; project and repo on /projects/:slug/fleet/budgets' })
  @IsIn([...BUDGET_SCOPE_TYPES]) declare scopeType: BudgetScopeType;

  @ApiPropertyOptional({ description: 'Runner id (runner) or fleet repo id (repo); omitted for global and project' })
  @IsOptional() @IsString() @Length(1, 64) scopeId?: string;

  @ApiProperty({ enum: BUDGET_WINDOW_KINDS }) @IsIn([...BUDGET_WINDOW_KINDS]) declare windowKind: BudgetWindowKind;

  @ApiProperty({ description: 'USD, > 0, at most 4 decimals' })
  @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(MAX_BUDGET_USD) declare amountUsd: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '1-99; omitted = 80; null = no warn' })
  @ValidateIf(whenSet) @IsInt() @Min(1) @Max(99) warnPercent?: number | null;

  @ApiPropertyOptional({ description: 'Pause the scope at the amount; default true' }) @IsOptional() @IsBoolean() hardStop?: boolean;

  @ApiPropertyOptional({ enum: BUDGET_RUNNING_JOBS, description: 'What a hard stop does to running jobs; default finish' })
  @IsOptional() @IsIn([...BUDGET_RUNNING_JOBS]) runningJobs?: BudgetRunningJobs;
}
```

Create `apps/api/src/fleet/budgets/dto/update-budget-policy.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, Max, Min, ValidateIf } from 'class-validator';
import { BUDGET_RUNNING_JOBS, BudgetRunningJobs } from '../domain/budget.domain';
import { MAX_BUDGET_USD, whenProvided, whenSet } from './create-budget-policy.dto';

/** Plan D161: scope and window are fixed. An omitted field is unchanged. */
export class UpdateBudgetPolicyDto {
  @ApiPropertyOptional({ description: 'USD, > 0, at most 4 decimals' })
  @ValidateIf(whenProvided) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(MAX_BUDGET_USD)
  amountUsd?: number;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '1-99; null = no warn; omitted = unchanged' })
  @ValidateIf(whenSet) @IsInt() @Min(1) @Max(99) warnPercent?: number | null;

  @ApiPropertyOptional() @ValidateIf(whenProvided) @IsBoolean() hardStop?: boolean;

  @ApiPropertyOptional({ enum: BUDGET_RUNNING_JOBS }) @ValidateIf(whenProvided) @IsIn([...BUDGET_RUNNING_JOBS]) runningJobs?: BudgetRunningJobs;
}
```

Create `apps/api/src/fleet/budgets/dto/resume-budget-policy.dto.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, Max, Min, ValidateIf } from 'class-validator';
import { MAX_BUDGET_USD, whenProvided } from './create-budget-policy.dto';

export class ResumeBudgetPolicyDto {
  @ApiPropertyOptional({ description: 'New amount; must be above the current window spend. Omitted = keep the amount.' })
  @ValidateIf(whenProvided) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(MAX_BUDGET_USD)
  amountUsd?: number;
}
```

Create `apps/api/src/fleet/budgets/dto/budget-policy.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BUDGET_RUNNING_JOBS, BUDGET_SCOPE_TYPES, BUDGET_WINDOW_KINDS, BudgetPolicyRecord, BudgetRunningJobs, BudgetScopeType, BudgetWindowKind,
} from '../domain/budget.domain';

/** One policy with its live window state (S1b §2.4 list rows). */
export class BudgetPolicyDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: BUDGET_SCOPE_TYPES }) declare scopeType: BudgetScopeType;
  @ApiPropertyOptional({ type: String, nullable: true }) declare scopeId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Owning project (project and repo scopes)' }) declare projectId: string | null;
  @ApiProperty({ enum: BUDGET_WINDOW_KINDS }) declare windowKind: BudgetWindowKind;
  @ApiProperty({ type: String, description: 'Decimal as string' }) declare amountUsd: string;
  @ApiPropertyOptional({ type: Number, nullable: true, description: '1-99; null = no warn' }) declare warnPercent: number | null;
  @ApiProperty() declare hardStop: boolean;
  @ApiProperty({ enum: BUDGET_RUNNING_JOBS }) declare runningJobs: BudgetRunningJobs;
  @ApiProperty({ description: 'Effectively paused now (S1b §2.3)' }) declare paused: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) declare pausedAt: string | null;
  @ApiProperty({ description: 'Start of the current window; the epoch for lifetime' }) declare windowStart: string;
  @ApiProperty({ type: String, description: 'Current window spend, decimal as string' }) declare spentUsd: string;
  @ApiProperty({ description: 'Spend is at or past the warn threshold' }) declare warnReached: boolean;
  @ApiProperty() declare updatedById: string;
  @ApiProperty() declare createdAt: string;
  @ApiProperty() declare updatedAt: string;

  static from(p: BudgetPolicyRecord, state: { spentUsd: string; windowStart: Date; paused: boolean; warnReached: boolean }): BudgetPolicyDto {
    return Object.assign(new BudgetPolicyDto(), {
      id: p.id, scopeType: p.scopeType, scopeId: p.scopeId, projectId: p.projectId, windowKind: p.windowKind,
      amountUsd: p.amountUsd, warnPercent: p.warnPercent, hardStop: p.hardStop, runningJobs: p.runningJobs,
      paused: state.paused, pausedAt: p.pausedAt ? p.pausedAt.toISOString() : null, windowStart: state.windowStart.toISOString(),
      spentUsd: state.spentUsd, warnReached: state.warnReached, updatedById: p.updatedById,
      createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
    });
  }
}
```

Run: `cd apps/api && bun run test:scoped src/fleet/budgets/dto/budget-dtos.spec.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing API test**

Create `apps/api/test/integration/fleet/fleet-budgets-api.integration.spec.ts`:

```ts
/**
 * Fleet S1b slice 2a — budget management over HTTP: both prefixes, B3 permissions, resume (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budgets-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

interface Row { id: string; scopeType: string; scopeId: string | null; paused: boolean; spentUsd: string; warnPercent: number | null; amountUsd: string; windowStart: string; hardStop: boolean; runningJobs: string; warnReached: boolean }

describeIntegration('fleet budgets API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let padmin: string;
  let padminId: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  const ADMIN = '/api/fleet/budgets';
  const PROJECT = '/api/projects/web/fleet/budgets';
  const month = { windowKind: 'calendar_month_utc' };

  const spend = (usd: number) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `api${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', costSpentUsd: usd, firstStartedAt: new Date(),
    },
  });
  const waitPaused = async (id: string): Promise<boolean> => {
    for (let i = 0; i < 40; i += 1) {
      if ((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id } })).pausedAt) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // A project ADMIN of web who is not a global admin (fourth login: within the 5/min throttle).
    await request(server).post('/api/admin/users').set(tok('root')).send({ email: 'padmin@koda.test', name: 'padmin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root')).send({ email: 'padmin@koda.test', role: 'ADMIN' }).expect(201);
    padmin = await loginToken(server, 'padmin@koda.test');
    padminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'padmin@koda.test' } })).id;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('admin creates a global policy with the defaults; a duplicate is 409; null warnPercent means no warn', async () => {
    const row = data<Row>(await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 50 }).expect(201));
    expect(row).toEqual(expect.objectContaining({ scopeType: 'global', scopeId: null, warnPercent: 80, hardStop: true, runningJobs: 'finish', paused: false, spentUsd: '0', amountUsd: '50' }));
    expect(new Date(row.windowStart).getUTCDate()).toBe(1);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 60 }).expect(409);
    const lifetime = data<Row>(await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', windowKind: 'lifetime', amountUsd: 500, warnPercent: null }).expect(201));
    expect(lifetime.warnPercent).toBeNull();
    const activity = await prisma.fleetActivity.findFirstOrThrow({ where: { entityType: 'budget', entityId: row.id, action: 'budget.created' } });
    expect(activity).toEqual(expect.objectContaining({ actorType: 'USER', actorId: world.ids.root, projectId: null }));
  });

  it('validates scopes per route: runner must exist, project scopes are not on the admin route', async () => {
    const runner = await insertRunner(prisma);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'runner', scopeId: runner.id, ...month, amountUsd: 5 }).expect(201);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'runner', scopeId: 'nope', ...month, amountUsd: 5 }).expect(404);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'project', ...month, amountUsd: 5 }).expect(400);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', scopeId: 'x', windowKind: 'lifetime', amountUsd: 5 }).expect(400);
    await request(server).post(ADMIN).set(tok('dev')).send({ scopeType: 'global', ...month, amountUsd: 5 }).expect(403);
  });

  it('project ADMIN and global ADMIN manage project and repo policies; developers and viewers cannot (B3)', async () => {
    const project = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201));
    expect(project).toEqual(expect.objectContaining({ scopeType: 'project', scopeId: world.projectId }));
    await request(server).post(PROJECT).set(tok('root')).send({ scopeType: 'repo', scopeId: world.repoId, ...month, amountUsd: 5 }).expect(201);
    await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'repo', scopeId: world.foreignRepoId, windowKind: 'lifetime', amountUsd: 5 }).expect(404);
    await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'global', windowKind: 'lifetime', amountUsd: 5 }).expect(400);
    await request(server).post(PROJECT).set(tok('dev')).send({ scopeType: 'project', windowKind: 'lifetime', amountUsd: 5 }).expect(403);
    await request(server).post(PROJECT).set(tok('viewer')).send({ scopeType: 'project', windowKind: 'lifetime', amountUsd: 5 }).expect(403);
    const activity = await prisma.fleetActivity.findFirstOrThrow({ where: { entityId: project.id, action: 'budget.created' } });
    expect(activity.projectId).toBe(world.projectId);
  });

  it('members list their project\'s policies plus the global ones; admins list everything', async () => {
    const runner = await insertRunner(prisma);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 50 }).expect(201);
    await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'runner', scopeId: runner.id, ...month, amountUsd: 5 }).expect(201);
    await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201);
    await request(server).post('/api/projects/ops/fleet/budgets').set(tok('root')).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201);
    await spend(3);
    const member = data<Row[]>(await request(server).get(PROJECT).set(tok('viewer')).expect(200));
    expect(member.map((r) => r.scopeType).sort()).toEqual(['global', 'project']);
    expect(member.find((r) => r.scopeType === 'project')?.spentUsd).toBe('3');
    await request(server).get(PROJECT).set(tok('outsider')).expect(403);
    expect(data<Row[]>(await request(server).get(ADMIN).set(tok('root')).expect(200))).toHaveLength(4);
    await request(server).get(ADMIN).set(tok('dev')).expect(403);
  });

  it('acts only on policies the route owns (D162) and keeps omitted fields on update', async () => {
    const global = data<Row>(await request(server).post(ADMIN).set(tok('root')).send({ scopeType: 'global', ...month, amountUsd: 50 }).expect(201));
    const project = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20, warnPercent: 70 }).expect(201));
    await request(server).patch(`${ADMIN}/${project.id}`).set(tok('root')).send({ amountUsd: 30 }).expect(404);
    await request(server).patch(`${PROJECT}/${global.id}`).set(as(padmin)).send({ amountUsd: 30 }).expect(404);
    await request(server).delete(`${PROJECT}/${global.id}`).set(tok('root')).expect(404);
    const updated = data<Row>(await request(server).patch(`${PROJECT}/${project.id}`).set(as(padmin)).send({ hardStop: false }).expect(200));
    expect(updated).toEqual(expect.objectContaining({ hardStop: false, warnPercent: 70, amountUsd: '20' }));
    const noWarn = data<Row>(await request(server).patch(`${PROJECT}/${project.id}`).set(as(padmin)).send({ warnPercent: null }).expect(200));
    expect(noWarn.warnPercent).toBeNull();
    await request(server).patch(`${PROJECT}/${project.id}`).set(tok('dev')).send({ amountUsd: 1 }).expect(403);
  });

  it('a lowered amount pauses within a second; resume needs an amount above spend, then stops again later (review focus 4)', async () => {
    await spend(5);
    const policy = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', ...month, amountUsd: 20 }).expect(201));
    await request(server).patch(`${PROJECT}/${policy.id}`).set(as(padmin)).send({ amountUsd: 4 }).expect(200);
    expect(await waitPaused(policy.id)).toBe(true);
    const listed = data<Row[]>(await request(server).get(PROJECT).set(tok('dev')).expect(200)).find((r) => r.id === policy.id);
    expect(listed?.paused).toBe(true);
    const refused = await request(server).post(`${PROJECT}/${policy.id}/resume`).set(as(padmin)).send({}).expect(400);
    expect(refused.body.message).toContain('5');
    await request(server).post(`${PROJECT}/${policy.id}/resume`).set(as(padmin)).send({ amountUsd: 5 }).expect(400);
    const resumed = data<Row>(await request(server).post(`${PROJECT}/${policy.id}/resume`).set(as(padmin)).send({ amountUsd: 8 }).expect(200));
    expect(resumed).toEqual(expect.objectContaining({ paused: false, amountUsd: '8' }));
    const incident = await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } });
    expect(incident.actorId).toBe(padminId);
    expect(await prisma.fleetActivity.count({ where: { entityId: policy.id, action: 'budget.resumed' } })).toBe(1);
    await request(server).post(`${PROJECT}/${policy.id}/resume`).set(as(padmin)).send({}).expect(409);
    await spend(4);
    expect((await app.get(BudgetEvaluator).evaluate(policy.id)).stopped).toBe(true);
    expect(await prisma.budgetIncident.count({ where: { policyId: policy.id, kind: 'hard_stop' } })).toBe(2);
  });

  it('deleting a paused policy lifts the pause', async () => {
    const policy = data<Row>(await request(server).post(PROJECT).set(as(padmin)).send({ scopeType: 'project', windowKind: 'lifetime', amountUsd: 1 }).expect(201));
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: new Date(), pausedWindowStart: new Date(0) } });
    await request(server).post('/api/projects/web/fleet/jobs').set(tok('dev')).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature: 'blocked' }).expect(409);
    await request(server).delete(`${PROJECT}/${policy.id}`).set(as(padmin)).expect(204);
    await request(server).post('/api/projects/web/fleet/jobs').set(tok('dev')).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature: 'unblocked' }).expect(201);
    expect(await prisma.fleetActivity.count({ where: { entityId: policy.id, action: 'budget.deleted' } })).toBe(1);
  });
});
```

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-budgets-api.integration.spec.ts`
Expected: FAIL (404 on every budget route).

- [ ] **Step 4: Implement the service**

Create `apps/api/src/fleet/budgets/budgets.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { BudgetEvaluator } from './budget-evaluator';
import { budgetActivityPayload } from './budget-payloads';
import { isAboveSpend, isEffectivelyPaused, scopeKeyOf, spendSince, warnReached, windowStart } from './budget-rules';
import {
  BUDGET_REPOSITORY, BudgetPolicyPatch, BudgetPolicyRecord, BudgetScopeType, DuplicateBudgetPolicyError, IBudgetRepository,
} from './domain/budget.domain';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import type { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import type { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';

export const DEFAULT_WARN_PERCENT = 80;

/** Which prefix a request came through (plan D162). */
export type BudgetRoute = { kind: 'admin' } | { kind: 'project'; projectId: string };

const ADMIN_SCOPES: readonly BudgetScopeType[] = ['global', 'runner'];
const PROJECT_SCOPES: readonly BudgetScopeType[] = ['project', 'repo'];

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.budgetInput');
}

/** Plan D162: admin routes own global and runner policies; a project route owns its project's project and repo policies. */
function owns(route: BudgetRoute, p: BudgetPolicyRecord): boolean {
  return route.kind === 'admin' ? ADMIN_SCOPES.includes(p.scopeType) : PROJECT_SCOPES.includes(p.scopeType) && p.projectId === route.projectId;
}

/** S1b §2.4: policy management. Permission (B3) is the controllers' job; ownership by route is checked here. */
@Injectable()
export class BudgetsService {
  constructor(
    @Inject(BUDGET_REPOSITORY) private readonly repo: IBudgetRepository,
    private readonly evaluator: BudgetEvaluator,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Admin: every policy. Project: the global ones plus the project's project and repo policies. */
  async list(route: BudgetRoute, now = new Date()): Promise<BudgetPolicyDto[]> {
    const policies = route.kind === 'admin' ? await this.repo.findAll() : await this.repo.findVisibleToProject(route.projectId);
    const rows: BudgetPolicyDto[] = [];
    for (const p of policies) rows.push(await this.toDto(p, now));
    return rows;
  }

  async create(actorId: string, route: BudgetRoute, dto: CreateBudgetPolicyDto, now = new Date()): Promise<BudgetPolicyDto> {
    const scope = await this.resolveScope(route, dto);
    let created: BudgetPolicyRecord;
    try {
      created = await this.txManager.run(async () => {
        const policy = await this.repo.create({
          ...scope, scopeKey: scopeKeyOf(scope.scopeType, scope.scopeId), windowKind: dto.windowKind, amountUsd: String(dto.amountUsd),
          warnPercent: dto.warnPercent === undefined ? DEFAULT_WARN_PERCENT : dto.warnPercent,
          hardStop: dto.hardStop ?? true, runningJobs: dto.runningJobs ?? 'finish', createdById: actorId,
        });
        await this.record(actorId, 'budget.created', policy);
        return policy;
      });
    } catch (error) {
      if (error instanceof DuplicateBudgetPolicyError) throw new ConflictAppException({}, 'fleet.budgets');
      throw error;
    }
    this.evaluator.signal([created.scopeKey]); // plan D165
    return this.toDto(created, now);
  }

  async update(actorId: string, route: BudgetRoute, id: string, dto: UpdateBudgetPolicyDto, now = new Date()): Promise<BudgetPolicyDto> {
    const updated = await this.txManager.run(async () => {
      const before = await this.lockOwned(route, id);
      const patch: BudgetPolicyPatch = {
        ...(dto.amountUsd !== undefined ? { amountUsd: String(dto.amountUsd) } : {}),
        ...(dto.warnPercent !== undefined ? { warnPercent: dto.warnPercent } : {}),
        ...(dto.hardStop !== undefined ? { hardStop: dto.hardStop } : {}),
        ...(dto.runningJobs !== undefined ? { runningJobs: dto.runningJobs } : {}),
        updatedById: actorId,
      };
      const after = await this.repo.update(id, patch);
      await this.record(actorId, 'budget.updated', after, {
        before: { amountUsd: before.amountUsd, warnPercent: before.warnPercent, hardStop: before.hardStop, runningJobs: before.runningJobs },
      });
      return after;
    });
    this.evaluator.signal([updated.scopeKey]); // plan D165
    return this.toDto(updated, now);
  }

  /** Deleting a paused policy lifts its pause (the row is gone). */
  async remove(actorId: string, route: BudgetRoute, id: string): Promise<void> {
    await this.txManager.run(async () => {
      const policy = await this.lockOwned(route, id);
      await this.repo.delete(id);
      await this.record(actorId, 'budget.deleted', policy, { wasPaused: policy.pausedAt !== null });
    });
  }

  /**
   * S1b §2.4, B1: optionally raise the amount, clear the pause, record a `resumed` incident.
   * C8's `raise_budget_and_resume` decision will call this method.
   */
  async resume(actorId: string, route: BudgetRoute, id: string, amountUsd: number | undefined, now = new Date()): Promise<BudgetPolicyDto> {
    const resumed = await this.txManager.run(async () => {
      const policy = await this.lockOwned(route, id);
      if (!policy.pausedAt) throw new ConflictAppException({}, 'fleet.budgetNotPaused'); // plan D164
      const spent = await this.repo.windowSpend(policy, spendSince(policy.windowKind, now));
      const amount = amountUsd === undefined ? policy.amountUsd : String(amountUsd);
      if (!isAboveSpend(amount, spent)) throw new ValidationAppException({ amountUsd: amount, spentUsd: spent }, 'fleet.budgetAmountNotAboveSpend');
      const after = await this.repo.update(id, { amountUsd: amount, pausedAt: null, pausedWindowStart: null, updatedById: actorId });
      await this.repo.insertIncident({ policyId: id, kind: 'resumed', windowStart: windowStart(policy.windowKind, now), spentUsd: spent, amountUsd: amount, actorId });
      await this.record(actorId, 'budget.resumed', after, { spentUsd: spent, previousAmountUsd: policy.amountUsd });
      return after;
    });
    return this.toDto(resumed, now);
  }

  private async resolveScope(route: BudgetRoute, dto: Pick<CreateBudgetPolicyDto, 'scopeType' | 'scopeId'>): Promise<{ scopeType: BudgetScopeType; scopeId: string | null; projectId: string | null }> {
    const allowed = route.kind === 'admin' ? ADMIN_SCOPES : PROJECT_SCOPES;
    if (!allowed.includes(dto.scopeType)) fail(`scopeType ${dto.scopeType} is managed on the other route`);
    const projectId = route.kind === 'project' ? route.projectId : null;
    switch (dto.scopeType) {
      case 'global':
        if (dto.scopeId !== undefined) fail('a global policy takes no scopeId');
        return { scopeType: 'global', scopeId: null, projectId: null };
      case 'runner':
        if (!dto.scopeId) fail('scopeId (the runner id) is required');
        if (!(await this.repo.scopeExists({ scopeType: 'runner', scopeId: dto.scopeId }))) throw new NotFoundAppException({}, 'fleet.runners');
        return { scopeType: 'runner', scopeId: dto.scopeId, projectId: null };
      case 'project':
        if (dto.scopeId !== undefined && dto.scopeId !== projectId) fail('a project policy names its own project');
        return { scopeType: 'project', scopeId: projectId, projectId };
      case 'repo':
        if (!dto.scopeId) fail('scopeId (the fleet repo id) is required');
        if ((await this.repo.findRepoProjectId(dto.scopeId)) !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
        return { scopeType: 'repo', scopeId: dto.scopeId, projectId };
    }
  }

  private async lockOwned(route: BudgetRoute, id: string): Promise<BudgetPolicyRecord> {
    const policy = await this.repo.lockById(id);
    if (!policy || !owns(route, policy)) throw new NotFoundAppException({}, 'fleet.budgets');
    return policy;
  }

  private async toDto(policy: BudgetPolicyRecord, now: Date): Promise<BudgetPolicyDto> {
    const spentUsd = await this.repo.windowSpend(policy, spendSince(policy.windowKind, now));
    return BudgetPolicyDto.from(policy, {
      spentUsd, windowStart: windowStart(policy.windowKind, now), paused: isEffectivelyPaused(policy, now),
      warnReached: warnReached(spentUsd, policy.amountUsd, policy.warnPercent),
    });
  }

  private record(actorId: string, action: string, policy: BudgetPolicyRecord, extra: Record<string, unknown> = {}): Promise<void> {
    return this.activity.record({
      actorType: 'USER', actorId, action, entityType: 'budget', entityId: policy.id, projectId: policy.projectId,
      responsibleUserId: actorId, payload: budgetActivityPayload(policy, extra),
    });
  }
}
```

- [ ] **Step 5: Implement the controllers and wire the module**

Create `apps/api/src/fleet/budgets/fleet-budgets.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { BudgetRoute, BudgetsService } from './budgets.service';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './dto/resume-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';

const ADMIN: BudgetRoute = { kind: 'admin' };

/** S1b §2.4 global-admin routes: global and runner policies, and the list of every policy. */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/budgets')
export class FleetBudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Every budget policy with its current window spend (global admin)' })
  @ApiResponse({ status: 200, type: [BudgetPolicyDto] })
  async list() {
    return JsonResponse.Ok(await this.budgets.list(ADMIN));
  }

  @Post()
  @HttpCode(201)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Create a global or runner budget policy (global admin)' })
  @ApiResponse({ status: 201, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetInput: wrong scope for this route' })
  @ApiResponse({ status: 404, description: 'Runner not found' })
  @ApiResponse({ status: 409, description: 'A policy already exists for this scope and window' })
  async create(@Body() dto: CreateBudgetPolicyDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.create(principal.id, ADMIN, dto));
  }

  @Patch(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Change the amount, warn, hard stop or running-jobs rule of a global or runner policy (global admin)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  async update(@Param('id') id: string, @Body() dto: UpdateBudgetPolicyDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.update(principal.id, ADMIN, id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Delete a global or runner policy; lifts its pause (global admin)' })
  async remove(@Param('id') id: string, @Principal() principal: KodaPrincipal): Promise<void> {
    await this.budgets.remove(principal.id, ADMIN, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Resume a paused global or runner policy, optionally raising the amount (global admin)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 409, description: 'fleet.budgetNotPaused' })
  async resume(@Param('id') id: string, @Body() dto: ResumeBudgetPolicyDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.budgets.resume(principal.id, ADMIN, id, dto.amountUsd));
  }
}
```

Create `apps/api/src/fleet/budgets/project-fleet-budgets.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { BudgetRoute, BudgetsService } from './budgets.service';
import { BudgetPolicyDto } from './dto/budget-policy.dto';
import { CreateBudgetPolicyDto } from './dto/create-budget-policy.dto';
import { ResumeBudgetPolicyDto } from './dto/resume-budget-policy.dto';
import { UpdateBudgetPolicyDto } from './dto/update-budget-policy.dto';

const route = (ctx: ProjectContext): BudgetRoute => ({ kind: 'project', projectId: ctx.project.id });

/** B3: project ADMIN of this project, or a global ADMIN (whose project role resolves to ADMIN). */
function requireProjectAdmin(ctx: ProjectContext, principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal) || ctx.role !== 'ADMIN') throw new ForbiddenAppException({}, 'projects');
}

/** S1b §2.4 project routes: members read; project ADMIN manages project and repo policies. */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/budgets')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetBudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @ApiOperation({ summary: "The project's project and repo policies plus the global ones, read-only (project member)" })
  @ApiResponse({ status: 200, type: [BudgetPolicyDto] })
  async list(@CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.budgets.list(route(ctx)));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a project or repo budget policy (project ADMIN)' })
  @ApiResponse({ status: 201, type: BudgetPolicyDto })
  @ApiResponse({ status: 404, description: 'Repo not in this project' })
  @ApiResponse({ status: 409, description: 'A policy already exists for this scope and window' })
  async create(@Body() dto: CreateBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireProjectAdmin(ctx, principal);
    return JsonResponse.Ok(await this.budgets.create(principal.id, route(ctx), dto));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a project or repo policy (project ADMIN)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  async update(@Param('id') id: string, @Body() dto: UpdateBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireProjectAdmin(ctx, principal);
    return JsonResponse.Ok(await this.budgets.update(principal.id, route(ctx), id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a project or repo policy; lifts its pause (project ADMIN)' })
  async remove(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal): Promise<void> {
    requireProjectAdmin(ctx, principal);
    await this.budgets.remove(principal.id, route(ctx), id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resume a paused project or repo policy, optionally raising the amount (project ADMIN)' })
  @ApiResponse({ status: 200, type: BudgetPolicyDto })
  @ApiResponse({ status: 400, description: 'fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 409, description: 'fleet.budgetNotPaused' })
  async resume(@Param('id') id: string, @Body() dto: ResumeBudgetPolicyDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireProjectAdmin(ctx, principal);
    return JsonResponse.Ok(await this.budgets.resume(principal.id, route(ctx), id, dto.amountUsd));
  }
}
```

Replace `apps/api/src/fleet/budgets/budgets.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { BudgetEvaluator } from './budget-evaluator';
import { BudgetStoreModule } from './budget-store.module';
import { BudgetSweeper } from './budget-sweeper';
import { BudgetsService } from './budgets.service';
import { FleetBudgetsController } from './fleet-budgets.controller';
import { ProjectFleetBudgetsController } from './project-fleet-budgets.controller';

/** S1b §2 C1 budgets (plan D160): evaluator, sweeper, management routes. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, BudgetStoreModule, FleetJobsModule, FleetActivityModule, WebhookModule],
  controllers: [FleetBudgetsController, ProjectFleetBudgetsController],
  providers: [BudgetEvaluator, BudgetSweeper, BudgetsService],
  exports: [BudgetEvaluator],
})
export class BudgetsModule {}
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && bun run type-check && bun run lint && bun run test:scoped src/fleet/budgets test/integration/fleet/fleet-budgets-api.integration.spec.ts test/integration/fleet/fleet-admin-guards.integration.spec.ts`
Expected: PASS. (`fleet-admin-guards` covers `fleet/activity` scoping, which now also returns `budget` rows: a
member sees the rows of their project's policies, an admin sees global and runner ones too.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/budgets apps/api/test/integration/fleet/fleet-budgets-api.integration.spec.ts
git commit -m "feat(fleet): budget policy management routes with resume"
```

### Task 11: OpenAPI contract and `koda fleet budget`

**Files:**
- Regenerate: `openapi.json` (repo root; `apps/cli/src/generated` is gitignored)
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`
- Modify: `apps/cli/src/utils/parse-usd.ts`, `apps/cli/src/utils/parse-usd.spec.ts`
- Create: `apps/cli/src/commands/fleet-budget.ts`
- Modify: `apps/cli/src/commands/fleet.ts`, `apps/cli/src/commands/fleet.spec.ts`
- Test: `apps/cli/src/commands/fleet-budget.spec.ts`

**Interfaces:**
- Consumes: the ten budget operations; generated names follow the existing `<controller>Controller<Method>`
  pattern: `fleetBudgetsControllerList|Create|Update|Remove|Resume` and
  `projectFleetBudgetsControllerList|Create|Update|Remove|Resume`; types `BudgetPolicyDto`,
  `CreateBudgetPolicyDto`, `UpdateBudgetPolicyDto`, `ResumeBudgetPolicyDto`.
- Produces: `parseBudgetUsd(value: string): number`; `koda fleet budget list | set | rm | resume` (plan D169).

- [ ] **Step 1: Regenerate the contract and pin it**

From the repo root: `bun run generate` (needs `apps/api/.env`).
Then confirm the generated names: `grep -n "export const .*BudgetsController" apps/cli/src/generated/sdk.gen.ts`
Expected: the ten functions listed above. If a name differs, use the generated name everywhere below.

In `apps/api/src/fleet/fleet-openapi.contract.spec.ts`, add inside the `describe`:

```ts
  it('exposes the budget routes on both prefixes and the budget_paused misfit (S1b §2.3, §2.4)', () => {
    for (const base of ['/api/fleet/budgets', '/api/projects/{slug}/fleet/budgets']) {
      expect(spec.paths[base]?.['get']).toBeDefined();
      expect(spec.paths[base]?.['post']).toBeDefined();
      expect(spec.paths[`${base}/{id}`]?.['patch']).toBeDefined();
      expect(spec.paths[`${base}/{id}`]?.['delete']).toBeDefined();
      expect(spec.paths[`${base}/{id}/resume`]?.['post']).toBeDefined();
    }
    expect(Object.keys(spec.components.schemas['BudgetPolicyDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['scopeType', 'windowKind', 'amountUsd', 'spentUsd', 'windowStart', 'paused', 'warnReached']));
    expect(JSON.stringify(spec.components.schemas['PlacementMisfitDto'])).toContain('budget_paused');
  });
```

Run: `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts`
Expected: PASS (the existing D120 case also covers the new project-scoped paths' `slug` param).

- [ ] **Step 2: Write the failing CLI tests**

In `apps/cli/src/utils/parse-usd.spec.ts`, add:

```ts
import { parseBudgetUsd } from './parse-usd';

describe('parseBudgetUsd', () => {
  it.each([['5', 5], ['250000', 250000], ['1000000', 1000000], ['0.0001', 0.0001]])('accepts %s', (raw, value) => {
    expect(parseBudgetUsd(raw)).toBe(value);
  });

  it.each(['0', '1000000.01', '1e6', 'abc'])('rejects %p', (raw) => {
    expect(() => parseBudgetUsd(raw)).toThrow(InvalidArgumentError);
  });
});
```

(merge the import with the existing `import { parseUsd } from './parse-usd';` line).

In `apps/cli/src/commands/fleet.spec.ts`, the expected list becomes `['budget', 'dispatch', 'job', 'repo', 'runner']`
and the test title `'registers the fleet group with runner, repo, dispatch, job and budget'`.

Create `apps/cli/src/commands/fleet-budget.spec.ts`:

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetBudgetsControllerList: jest.fn(),
  fleetBudgetsControllerCreate: jest.fn(),
  fleetBudgetsControllerUpdate: jest.fn(),
  fleetBudgetsControllerRemove: jest.fn(),
  fleetBudgetsControllerResume: jest.fn(),
  projectFleetBudgetsControllerList: jest.fn(),
  projectFleetBudgetsControllerCreate: jest.fn(),
  projectFleetBudgetsControllerUpdate: jest.fn(),
  projectFleetBudgetsControllerRemove: jest.fn(),
  projectFleetBudgetsControllerResume: jest.fn(),
  projectFleetReposControllerList: jest.fn(),
  projectFleetRunnersControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { budgetState, parseScope, parseWarn } from './fleet-budget';
import {
  fleetBudgetsControllerCreate,
  fleetBudgetsControllerList,
  fleetBudgetsControllerRemove,
  fleetBudgetsControllerUpdate,
  projectFleetBudgetsControllerCreate,
  projectFleetBudgetsControllerList,
  projectFleetBudgetsControllerResume,
  projectFleetReposControllerList,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'b1', scopeType: 'global', scopeId: null, projectId: null, windowKind: 'calendar_month_utc', amountUsd: '50', warnPercent: 80,
  hardStop: true, runningJobs: 'finish', paused: false, pausedAt: null, windowStart: '2026-10-01T00:00:00.000Z', spentUsd: '12.5',
  warnReached: false, updatedById: 'u', createdAt: '', updatedAt: '', ...over,
});
const ok = (data: unknown) => ({ ret: 0, data });

describe('koda fleet budget', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'budget', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('parses scopes and warn values', () => {
    expect(parseScope('global')).toEqual({ scopeType: 'global' });
    expect(parseScope('repo:acme/app')).toEqual({ scopeType: 'repo', ref: 'acme/app' });
    expect(() => parseScope('runner:')).toThrow();
    expect(() => parseScope('team')).toThrow();
    expect(parseWarn('none')).toBeNull();
    expect(parseWarn('75')).toBe(75);
    expect(() => parseWarn('0')).toThrow();
    expect(() => parseWarn('100')).toThrow();
    expect(budgetState(row({ paused: true, warnReached: true }) as never)).toBe('PAUSED');
    expect(budgetState(row({ warnReached: true }) as never)).toBe('WARN');
  });

  it('list uses the admin route without --project and the project route with it', async () => {
    (fleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([row({ paused: true })]));
    (projectFleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([]));
    await run('list');
    expect(fleetBudgetsControllerList).toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('PAUSED');
    await run('list', '--project', 'web');
    expect(projectFleetBudgetsControllerList).toHaveBeenCalledWith({ path: { slug: 'web' } });
    expect(exitSpy).toHaveBeenLastCalledWith(0);
  });

  it('set creates a global policy on the admin route, sending only what was given', async () => {
    (fleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([]));
    (fleetBudgetsControllerCreate as jest.Mock).mockResolvedValue(ok(row()));
    await run('set', '--scope', 'global', '--window', 'month', '--amount', '50');
    expect(fleetBudgetsControllerCreate).toHaveBeenCalledWith({ body: { scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 50 } });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('set updates the existing policy for the same scope and window', async () => {
    (fleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([row({ id: 'r1', scopeType: 'runner', scopeId: 'run-1' }), row({ id: 'g1' })]));
    (fleetBudgetsControllerUpdate as jest.Mock).mockResolvedValue(ok(row({ id: 'r1' })));
    await run('set', '--scope', 'runner:run-1', '--window', 'month', '--amount', '20', '--warn', 'none', '--hard-stop', 'off', '--running', 'cancel');
    expect(fleetBudgetsControllerUpdate).toHaveBeenCalledWith({
      path: { id: 'r1' }, body: { amountUsd: 20, warnPercent: null, hardStop: false, runningJobs: 'cancel' },
    });
  });

  it('set resolves a repo by owner/name on the project route', async () => {
    (projectFleetReposControllerList as jest.Mock).mockResolvedValue(ok({
      total: 1, current: 1, size: 100, hasNext: false, records: [{ id: 'fr1', projectId: 'p', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main' }],
    }));
    (projectFleetBudgetsControllerList as jest.Mock).mockResolvedValue(ok([]));
    (projectFleetBudgetsControllerCreate as jest.Mock).mockResolvedValue(ok(row({ scopeType: 'repo', scopeId: 'fr1' })));
    await run('set', '--scope', 'repo:acme/app', '--window', 'lifetime', '--amount', '5', '--project', 'web');
    expect(projectFleetBudgetsControllerCreate).toHaveBeenCalledWith({
      path: { slug: 'web' }, body: { scopeType: 'repo', scopeId: 'fr1', windowKind: 'lifetime', amountUsd: 5 },
    });
  });

  it('set refuses a bad scope before any request', async () => {
    await expect(run('set', '--scope', 'team', '--window', 'month', '--amount', '5')).rejects.toThrow();
    expect(fleetBudgetsControllerList).not.toHaveBeenCalled();
  });

  it('rm needs --force; resume sends the new amount on the project route', async () => {
    await run('rm', 'b1');
    expect(fleetBudgetsControllerRemove).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    (fleetBudgetsControllerRemove as jest.Mock).mockResolvedValue(undefined);
    await run('rm', 'b1', '--force');
    expect(fleetBudgetsControllerRemove).toHaveBeenCalledWith({ path: { id: 'b1' } });
    (projectFleetBudgetsControllerResume as jest.Mock).mockResolvedValue(ok(row({ amountUsd: '80' })));
    await run('resume', 'b2', '--project', 'web', '--amount', '80');
    expect(projectFleetBudgetsControllerResume).toHaveBeenCalledWith({ path: { slug: 'web', id: 'b2' }, body: { amountUsd: 80 } });
  });

  it('surfaces a refused resume (400) as an API error, exit 1', async () => {
    (projectFleetBudgetsControllerResume as jest.Mock).mockRejectedValue({ ret: -2, status: 400, message: 'The amount 5 must be above this window\'s spend of 9' });
    await run('resume', 'b2', '--project', 'web');
    expect(projectFleetBudgetsControllerResume).toHaveBeenCalledWith({ path: { slug: 'web', id: 'b2' }, body: {} });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
```

Run: `cd apps/cli && bun run test -- src/utils/parse-usd.spec.ts src/commands/fleet.spec.ts src/commands/fleet-budget.spec.ts`
Expected: FAIL (`parseBudgetUsd` not exported; `./fleet-budget` missing).

- [ ] **Step 3: Add `parseBudgetUsd`**

Replace the body of `apps/cli/src/utils/parse-usd.ts` with:

```ts
import { InvalidArgumentError } from 'commander';

function parseUsdUpTo(value: string, max: number): number {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) {
    throw new InvalidArgumentError('must be a USD amount with at most 4 decimals, for example 5 or 0.25');
  }
  const parsed = Number(trimmed);
  if (parsed <= 0 || parsed > max) throw new InvalidArgumentError(`must be more than 0 and at most ${max}`);
  return parsed;
}

/**
 * Commander parser for a USD budget: > 0, at most 10000, at most 4 decimals (DispatchFleetJobDto.maxCostUsd).
 * Plain decimal notation only: no exponent, sign or hex, so what the user typed is what is sent.
 */
export function parseUsd(value: string): number {
  return parseUsdUpTo(value, 10_000);
}

/** Same format as parseUsd, up to 1,000,000: a budget policy amount (plan D169). */
export function parseBudgetUsd(value: string): number {
  return parseUsdUpTo(value, 1_000_000);
}
```

(Commander passes the previous value as a second argument to a parser, so the cap is never a parameter of the
exported parsers.)

- [ ] **Step 4: Implement `koda fleet budget`**

Create `apps/cli/src/commands/fleet-budget.ts`:

```ts
import { Command, InvalidArgumentError } from 'commander';
import {
  fleetBudgetsControllerCreate,
  fleetBudgetsControllerList,
  fleetBudgetsControllerRemove,
  fleetBudgetsControllerResume,
  fleetBudgetsControllerUpdate,
  projectFleetBudgetsControllerCreate,
  projectFleetBudgetsControllerList,
  projectFleetBudgetsControllerRemove,
  projectFleetBudgetsControllerResume,
  projectFleetBudgetsControllerUpdate,
  type BudgetPolicyDto,
  type CreateBudgetPolicyDto,
  type ResumeBudgetPolicyDto,
  type UpdateBudgetPolicyDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { requireForce } from '../utils/force';
import { table } from '../utils/output';
import { parseBudgetUsd } from '../utils/parse-usd';
import { ADMIN_TOKEN_HINT, handleFleetValidation, resolveRepo } from './fleet-shared';

type WindowKind = 'calendar_month_utc' | 'lifetime';
type Scope =
  | { scopeType: 'global' }
  | { scopeType: 'project' }
  | { scopeType: 'runner'; ref: string }
  | { scopeType: 'repo'; ref: string };

/** `global`, `project`, `runner:<id>` or `repo:<id or owner/name>` (S1b §2.1 scopes). */
export function parseScope(value: string): Scope {
  if (value === 'global' || value === 'project') return { scopeType: value };
  const cut = value.indexOf(':');
  const kind = cut > 0 ? value.slice(0, cut) : '';
  const ref = cut > 0 ? value.slice(cut + 1) : '';
  if ((kind === 'runner' || kind === 'repo') && ref !== '') return { scopeType: kind, ref };
  throw new InvalidArgumentError('expected global, project, runner:<id> or repo:<id or owner/name>');
}

export function parseWindow(value: string): WindowKind {
  if (value === 'month') return 'calendar_month_utc';
  if (value === 'lifetime') return 'lifetime';
  throw new InvalidArgumentError('expected month or lifetime');
}

/** 1-99, or `none` for no warn. */
export function parseWarn(value: string): number | null {
  if (value === 'none') return null;
  if (!/^\d{1,2}$/.test(value) || Number(value) < 1) throw new InvalidArgumentError('expected 1-99 or none');
  return Number(value);
}

export function parseOnOff(value: string): boolean {
  if (value === 'on' || value === 'off') return value === 'on';
  throw new InvalidArgumentError('expected on or off');
}

export function parseRunning(value: string): 'finish' | 'cancel' {
  if (value === 'finish' || value === 'cancel') return value;
  throw new InvalidArgumentError('expected finish or cancel');
}

export function budgetState(p: BudgetPolicyDto): string {
  if (p.paused) return 'PAUSED';
  return p.warnReached ? 'WARN' : 'ok';
}

const scopeLabel = (p: BudgetPolicyDto): string => (p.scopeId ? `${p.scopeType}:${p.scopeId}` : p.scopeType);
const windowLabel = (p: BudgetPolicyDto): string => (p.windowKind === 'lifetime' ? 'lifetime' : 'month');
const adminHint = (project: string | undefined) => (project === undefined ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);

/** The ten budget operations behind one shape: the global-admin routes or one project's routes. */
interface BudgetApi {
  list(): Promise<unknown>;
  create(body: CreateBudgetPolicyDto): Promise<unknown>;
  update(id: string, body: UpdateBudgetPolicyDto): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  resume(id: string, body: ResumeBudgetPolicyDto): Promise<unknown>;
}

const ADMIN_API: BudgetApi = {
  list: () => fleetBudgetsControllerList(),
  create: (body) => fleetBudgetsControllerCreate({ body }),
  update: (id, body) => fleetBudgetsControllerUpdate({ path: { id }, body }),
  remove: (id) => fleetBudgetsControllerRemove({ path: { id } }),
  resume: (id, body) => fleetBudgetsControllerResume({ path: { id }, body }),
};

const projectApi = (slug: string): BudgetApi => ({
  list: () => projectFleetBudgetsControllerList({ path: { slug } }),
  create: (body) => projectFleetBudgetsControllerCreate({ path: { slug }, body }),
  update: (id, body) => projectFleetBudgetsControllerUpdate({ path: { slug, id }, body }),
  remove: (id) => projectFleetBudgetsControllerRemove({ path: { slug, id } }),
  resume: (id, body) => projectFleetBudgetsControllerResume({ path: { slug, id }, body }),
});

/** `--project` selects the project routes; without it, the global-admin routes. */
async function routeFor(project: string | undefined): Promise<BudgetApi> {
  if (project !== undefined) return projectApi((await withContext({ projectSlug: project })).projectSlug);
  await withContext({}, { requireProject: false });
  return ADMIN_API;
}

function printRow(verb: string, p: BudgetPolicyDto): void {
  console.log(`${verb} budget ${p.id}: ${scopeLabel(p)} ${windowLabel(p)}, spent $${p.spentUsd} of $${p.amountUsd} (${budgetState(p)})`);
}

function registerList(budget: Command): void {
  budget
    .command('list')
    .description("Budget policies with this window's spend (--project: the project's and the global ones; otherwise all, global admin)")
    .option('--project <slug>', 'Use the project routes')
    .option('--json', 'Output as JSON')
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        const rows = unwrap<BudgetPolicyDto[]>(await (await routeFor(options.project)).list());
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          table(['ID', 'Scope', 'Window', 'Spent / Amount', 'Warn', 'Hard stop', 'State'], rows.map((p) => [
            p.id, scopeLabel(p), windowLabel(p), `$${p.spentUsd} / $${p.amountUsd}`,
            p.warnPercent === null ? '-' : `${p.warnPercent}%`, p.hardStop ? p.runningJobs : 'off', budgetState(p),
          ]));
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, adminHint(options.project));
      }
    });
}

interface SetOptions {
  scope: Scope;
  window: WindowKind;
  amount: number;
  warn?: number | null;
  hardStop?: boolean;
  running?: 'finish' | 'cancel';
  project?: string;
  json?: boolean;
}

function registerSet(budget: Command): void {
  budget
    .command('set')
    .description('Create or update the policy of a scope and window (global, runner: global admin; project, repo: project admin)')
    .requiredOption('--scope <scope>', 'global, project, runner:<id> or repo:<id or owner/name>', parseScope)
    .requiredOption('--window <window>', 'month (calendar month, UTC) or lifetime', parseWindow)
    .requiredOption('--amount <usd>', 'Amount in USD, at most 4 decimals', parseBudgetUsd)
    .option('--warn <percent>', 'Warn at this percent (1-99) or none; 80 when a new policy omits it', parseWarn)
    .option('--hard-stop <on|off>', 'Pause the scope when spend reaches the amount; on when a new policy omits it', parseOnOff)
    .option('--running <finish|cancel>', 'At a hard stop, let running jobs finish or cancel them; finish when omitted', parseRunning)
    .option('--project <slug>', 'Project slug for project and repo scopes (uses config if not provided)')
    .option('--json', 'Output as JSON')
    .action(async (options: SetOptions) => {
      const { scope } = options;
      const projectScoped = scope.scopeType === 'project' || scope.scopeType === 'repo';
      try {
        let api: BudgetApi;
        let scopeId: string | undefined;
        if (projectScoped) {
          const ctx = await withContext({ projectSlug: options.project });
          api = projectApi(ctx.projectSlug);
          if (scope.scopeType === 'repo') {
            const repo = await resolveRepo(ctx.projectSlug, scope.ref);
            if (!repo) return handleFleetValidation(`No fleet repo "${scope.ref}" in project ${ctx.projectSlug}`);
            scopeId = repo.id;
          }
        } else {
          await withContext({}, { requireProject: false });
          api = ADMIN_API;
          if (scope.scopeType === 'runner') scopeId = scope.ref;
        }
        const fields: UpdateBudgetPolicyDto = {
          amountUsd: options.amount,
          ...(options.warn !== undefined ? { warnPercent: options.warn } : {}),
          ...(options.hardStop !== undefined ? { hardStop: options.hardStop } : {}),
          ...(options.running !== undefined ? { runningJobs: options.running } : {}),
        };
        const existing = unwrap<BudgetPolicyDto[]>(await api.list()).find((p) =>
          p.scopeType === scope.scopeType && p.windowKind === options.window && (scope.scopeType === 'project' || (p.scopeId ?? undefined) === scopeId));
        const saved = existing
          ? unwrap<BudgetPolicyDto>(await api.update(existing.id, fields))
          : unwrap<BudgetPolicyDto>(await api.create({ scopeType: scope.scopeType, ...(scopeId ? { scopeId } : {}), windowKind: options.window, ...fields, amountUsd: options.amount }));
        if (options.json) console.log(JSON.stringify(saved, null, 2));
        else printRow(existing ? 'Updated' : 'Created', saved);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, projectScoped ? undefined : { forbiddenHint: ADMIN_TOKEN_HINT });
      }
    });
}

function registerRemove(budget: Command): void {
  budget
    .command('rm <policyId>')
    .description('Delete a budget policy; lifts its pause')
    .option('--project <slug>', 'Use the project routes (project and repo policies)')
    .option('--force', 'Confirm the deletion')
    .action(async (policyId: string, options: { project?: string; force?: boolean }) => {
      if (!requireForce(options.force)) return;
      try {
        await (await routeFor(options.project)).remove(policyId);
        console.log(`Removed budget ${policyId}`);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...adminHint(options.project), notFoundMessage: `Budget policy not found: ${policyId}` });
      }
    });
}

function registerResume(budget: Command): void {
  budget
    .command('resume <policyId>')
    .description("Resume a paused policy, optionally raising the amount above this window's spend")
    .option('--amount <usd>', 'New amount in USD', parseBudgetUsd)
    .option('--project <slug>', 'Use the project routes (project and repo policies)')
    .option('--json', 'Output as JSON')
    .action(async (policyId: string, options: { amount?: number; project?: string; json?: boolean }) => {
      try {
        const api = await routeFor(options.project);
        const resumed = unwrap<BudgetPolicyDto>(await api.resume(policyId, options.amount === undefined ? {} : { amountUsd: options.amount }));
        if (options.json) console.log(JSON.stringify(resumed, null, 2));
        else printRow('Resumed', resumed);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...adminHint(options.project), notFoundMessage: `Budget policy not found: ${policyId}` });
      }
    });
}

/** `koda fleet budget …`: C1 spend caps per scope (S1b §2.4, plan D169). */
export function registerFleetBudget(fleet: Command): void {
  const budget = fleet.command('budget');
  budget.description('Fleet budget policies: spend caps per global, project, repo or runner scope');
  registerList(budget);
  registerSet(budget);
  registerRemove(budget);
  registerResume(budget);
}
```

In `apps/cli/src/commands/fleet.ts`, import `registerFleetBudget` from `./fleet-budget`, call
`registerFleetBudget(fleet);` after `registerFleetJob(fleet);`, and change the doc comment to
`/** \`koda fleet …\`: runners, repos, dispatch, jobs (fleet S1 spec §11) and budgets (S1b §2.4). */`.

- [ ] **Step 5: Run the CLI checks**

Run: `cd apps/cli && bun run test -- src/utils/parse-usd.spec.ts src/commands/fleet.spec.ts src/commands/fleet-budget.spec.ts && bun run type-check && bun run lint`
Expected: PASS. If `type-check` reports that a generated body type differs (for example `warnPercent` typed
`number` without `null`), fix the API DTO's `@ApiPropertyOptional` (it must say `nullable: true`) and regenerate;
do not cast in the CLI.

- [ ] **Step 6: Commit**

```bash
git add openapi.json apps/api/src/fleet/fleet-openapi.contract.spec.ts apps/cli/src
git commit -m "feat(cli): koda fleet budget list, set, rm and resume"
```

### Task 12: Whole-slice verification and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md` (§2.2, §2.4 notes)
- Modify: `.nax/mono/apps/api/context.md` (Fleet section), then regenerate the agent files

- [ ] **Step 1: Spec notes**

In the spec §2.2, at the end of the "if `runningJobs = cancel`" bullet (the one ending "uses `cancelReason` as
`stateReason`."), append: ` A set \`cancelReason\` wins over any reason the runner sends (2a plan D156).`

In §2.4, after the "Routes" bullet list, add:

```markdown
- Each prefix acts only on its own policies (2a plan D162): `/fleet/budgets` on global and runner policies,
  `/projects/:slug/fleet/budgets` on that project's project and repo policies; another id answers 404. Resume of a
  policy that is not paused answers 409 `fleet.budgetNotPaused` (D164).
```

- [ ] **Step 2: API agent context**

In `.nax/mono/apps/api/context.md`, Fleet section, after the "Publish `fleet_job` live events..." line, add:

```markdown
- Budgets (`src/fleet/budgets/`, S1b spec §2): window math, scope keys and the effective-pause rule live in `budget-rules.ts`; money is compared with `Prisma.Decimal`, never floats. Dispatch, requeue and both placement entry points read pauses through `BudgetGate`; the evaluator runs only after the sync transaction commits (`BudgetEvaluator.signal`). Budget activity payloads must not carry a `*Key` field (`FleetActivityService` rejects key-like names).
```

From the repo root regenerate the agent files: `nax generate && nax generate --all-packages` (local, not a billed
run). Include every regenerated file in the commit. Never edit generated `AGENTS.md` / `CLAUDE.md` by hand.

- [ ] **Step 3: Repo-wide checks**

From the repo root:

Run: `bun run type-check && bun run lint && bun run test`
Expected: all workspaces pass.

Run: `bun run generate && git status --short openapi.json`
Expected: no changes (Task 11 committed the contract).

Run every integration suite this slice added or touched:

```bash
cd apps/api && bun run test:scoped \
  test/integration/fleet/fleet-budgets-schema.integration.spec.ts \
  test/integration/fleet/fleet-budget-lifecycle.integration.spec.ts \
  test/integration/fleet/fleet-budget-repository.integration.spec.ts \
  test/integration/fleet/fleet-budget-enforcement.integration.spec.ts \
  test/integration/fleet/fleet-budget-placement.integration.spec.ts \
  test/integration/fleet/fleet-budget-cancel.integration.spec.ts \
  test/integration/fleet/fleet-budget-evaluator.integration.spec.ts \
  test/integration/fleet/fleet-budget-sweeper.integration.spec.ts \
  test/integration/fleet/fleet-budgets-api.integration.spec.ts \
  test/integration/fleet/fleet-job-cancel-requeue.integration.spec.ts \
  test/integration/fleet/placement.integration.spec.ts \
  test/integration/fleet/runner-sync.integration.spec.ts \
  test/integration/fleet/runner-sync-lifecycle.integration.spec.ts \
  test/integration/fleet/fleet-jobs.integration.spec.ts \
  test/integration/fleet/fleet-admin-guards.integration.spec.ts
```

Expected: PASS. Then the whole fleet integration directory once: `bun run test:scoped test/integration/fleet`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-fleet-s1b-budgets-schedules-design.md .nax/mono/apps/api/context.md
git add -u   # the agent files nax generate rewrote
git commit -m "docs(fleet): S1b spec notes and api context for budgets"
```

- [ ] **Step 5: PR notes to carry**

The PR body must state: the spec narrowings D156 (cancel reason precedence), D157 (UPLOADING untouched by a budget
cancel), D162 (route ownership), D164 (`fleet.budgetNotPaused`), D171 (web gets only the misfit label; pages are 2b);
the known limits D167 (`firstStartedAt` backfilled from `startedAt`) and D172 (runner-scope spend follows the current
runner); and that slice 2b (web) and 3a (schedules) build on it.
