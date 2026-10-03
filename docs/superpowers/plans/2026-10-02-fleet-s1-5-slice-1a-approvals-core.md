# Fleet S1.5 Slice 1a — Approvals Core and Budget Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A budget hard stop raises a `budget_override_required` approval. An authorised human lists it, sees the
jobs the pause cancelled before they started, and decides "keep paused" or "raise budget and resume" (re-queueing the
selected jobs). Manual resume, month rollover and policy delete close the approval. API and CLI only; the web is
slice 1b, bash asks are slice 2a.

**Architecture:** One new table `FleetApproval` (bash columns created now, used in 2a). An `ApprovalStoreModule`
(repository, `ApprovalCloser`, `ApprovalLivePublisher`) is imported by `BudgetsModule`, so the evaluator, the budgets
service and the sweeper open and close approvals inside their own transactions. An `ApprovalsModule` (service and
three controllers) imports `BudgetsModule` and `FleetJobsModule` to decide. Every budget-approval path locks the
`BudgetPolicy` row before the approval row. Deciding "raise and resume" is one transaction (resume + approval), then
one transaction per re-queue; results are stored on the approval.

**Tech Stack:** NestJS + Prisma 6 (PostgreSQL) + Jest (API), commander 12 + Jest (CLI).

**Spec:** `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md` §1.1-§1.5, §1.7, §2.1-§2.3 (budget
parts), §2.5, §6 (budget rows), §7 (1a tests), §8 slice 1a. Rulings A2, A4, A6, A8, A9.

## Global Constraints

- Approval types: `budget_override_required` | `nax_bash_escalate`. Statuses: `pending` | `approved` | `rejected` |
  `expired` | `cancelled`. Decisions: `allow` | `allow_for_job` | `deny` | `raise_budget_and_resume` | `keep_paused`.
  `resolvedBy`: `user` | `timeout` | `job_ended` | `superseded` | `manual_resume` | `window_reset` | `policy_deleted`.
- One pending approval per policy: partial unique index
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetApproval_pending_policy_key" ON "FleetApproval" ("policyId") WHERE "status" = 'pending'`
  shipped verbatim in the migration and in `PARTIAL_UNIQUE_INDEXES`.
- **Lock order:** `BudgetPolicy` row first, then the `FleetApproval` row. Never lock an approval and then a policy.
- Re-queue candidates (spec §1.5): `state = 'CANCELLED'`, `cancelReason = budgetReason(policyId)`,
  `startedAt IS NULL`, `finishedAt >= approval.requestedAt`, oldest first (`queuedAt`, `id`), at most 200; the
  response says when more exist.
- Money stays a decimal **string** in records, payloads and DTOs; `amountUsd` in request bodies is a number validated
  like `ResumeBudgetPolicyDto` (`maxDecimalPlaces: 4`, `0.0001..MAX_BUDGET_USD`).
- Error codes (i18n prefixes, both `apps/api/src/i18n/en/fleet.json` and `.../zh/fleet.json`): `fleet.approvals`
  (404), `fleet.approvalNotPending` (409), `fleet.approvalDecisionInvalid` (400, code `-2`, `{reason}`),
  `fleet.approvalInput` (400, code `-2`, `{reason}`).
- Webhooks `fleet.approval.requested` and `fleet.approval.resolved` go through `WebhookDispatcherService.dispatch`
  inside the triggering transaction, only for approvals with a `projectId`. Payload
  `{ approvalId, type, status, decision, resolvedBy, projectId, jobId, policyId, expiresAt, path }`, `path` =
  `/<slug>/fleet/approvals?id=<id>`. Never command text.
- Activity rows: `entityType: 'approval'`, actions `approval.requested`, `approval.decided`, `approval.cancelled`.
  Payload keys must not match `/token|secret|key|password|credential/i` (`FleetActivityService.record` throws).
- Live: `{ type: 'fleet_approval', id, projectId, approvalId, status, at }`, built in the transaction, published after
  commit, only when `projectId` is set.
- API tests: `cd apps/api && bun run test:scoped <paths>` (paths relative to `apps/api`; integration specs need
  `bun run test:db:up`). Never `bun run test:unit -- <path>` and never bare `bun test` at the repo root. CLI:
  `cd apps/cli && bun run test -- <path>`.
- `bun run generate` (repo root) needs `apps/api/.env`; in a fresh worktree copy it from the main checkout.
  `apps/cli/src/generated` is gitignored; commit only `openapi.json`.
- Integration files log in over HTTP in `beforeAll` (login throttle 5/min). A whole file failing in under a millisecond
  with only a `loginToken` frame is the local throttle cascade: wait a minute and rerun that file alone.
- No emojis in source; no `console.log` in API source.

## Decisions

Numbered from D226 (S1b slice 3b ended at D225).

| # | Decision | Why |
|:--|:--|:--|
| D226 | Two modules: `ApprovalStoreModule` (repository, `ApprovalCloser`, `ApprovalLivePublisher`; imports Prisma, `FleetActivityModule`, `WebhookModule`, `LiveModule`) and `ApprovalsModule` (service, controllers; imports the store, `BudgetStoreModule`, `BudgetsModule`, `FleetJobsModule`, `FleetActivityModule`, `ProjectAccessModule`). `BudgetsModule` imports the store and now exports `BudgetsService`. | Spec §2.1; the budgets code must close approvals and deciding needs budgets and jobs, so one module would be a cycle. |
| D227 | The hard stop opens the approval **before** inserting the `hard_stop` incident and passes `approvalId` into `insertIncident`. | No second write to stamp the id, and the id is present even when the webhook is skipped. |
| D228 | `fleet.approval.requested` is sent whenever the approval is created, even when the `hard_stop` incident insert conflicted (spec §1.4). | The approval is new even when the incident is not. |
| D229 | The budget route passed to `BudgetsService.resume` is derived from the policy's scope (`project`/`repo` -> `{ kind: 'project', projectId }`, `global`/`runner` -> `{ kind: 'admin' }`), not from the request prefix. | `owns()` would 404 an admin-prefix decide on a project policy (spec review M1). |
| D230 | The project inbox lists only approvals whose `projectId` is that project; approvals of global and runner policies appear only on the admin routes. | Spec §1.7; their `projectId` is null. |
| D231 | An omitted `requeueJobIds` re-queues nothing. The web ticks every candidate by default (1b); the API stays explicit. | A CLI or script call must not re-queue jobs it never listed. |
| D232 | Re-queues run as the decider (`FleetJobsService.requeue(actorId, job.projectId, jobId)`), which has no permission check of its own; the decider already passed the budget permission, which is stronger than DEVELOPER. | Candidates of a global policy span projects (spec §1.5). |
| D233 | A re-queue failure is stored as `{ jobId, ok: false, error }` where `error` is the exception's message key or message; nothing is thrown. | A9. |
| D234 | Manual resume closes the pending approval as `approved` / `manual_resume`, `decision: raise_budget_and_resume`, `decidedById` = the actor, `outcome: { resumedAmountUsd, requeueResults: [] }`. | Spec §1.4. |
| D235 | `GET /fleet/approval-counts` refuses non-user principals (403 `projects`), returns `{ total, unscoped, projects: [{ projectId, slug, pending }] }`; `projects` lists only projects with `pending > 0`; `unscoped` is 0 unless the caller is a global ADMIN. | Spec §2.3; a separate path avoids the `/fleet/approvals/:id` collision. |
| D236 | A decide on a `nax_bash_escalate` approval in this slice answers 400 `fleet.approvalDecisionInvalid` ("bash approvals are not decidable yet"). | None exist before 2a; the guard keeps the endpoint honest. |
| D237 | `FleetApprovalDto.payload` and `outcome` are typed in OpenAPI as free objects (`type: 'object', additionalProperties: true`). | Per-type shapes; 1b reads them through mappers. |
| D238 | CLI: `koda fleet approval list [--project <slug>] [--status <s>] [--type <t>] [--json]`, `show <id>`, `decide <id> --decision keep_paused|raise_budget_and_resume [--amount <usd>] [--requeue all|<id,...>] [--comment <text>]`. Without `--project`, the admin routes. `--requeue all` sends every candidate id from a fresh `show`. | Mirrors `koda fleet budget` route selection (D169). |

## Review Focus

1. A debounced evaluation and a decide on the same policy at once: no deadlock, and the decide either sees the
   approval pending or answers 409. (Task 6 "concurrent evaluate and decide".)
2. A raise-and-resume whose re-queue hits an active duplicate (same repo and feature already QUEUED): the resume
   stands, the approval is `approved`, and `outcome.requeueResults` holds one failure. (Task 6 "partial re-queue".)
3. A policy deleted while its approval is pending: the approval is `cancelled` / `policy_deleted`, and a later decide
   is 409, not 500. (Task 4 "policy delete closes".)
4. A job cancelled by placement during the pause (not by the hard stop) is a re-queue candidate; a job that was running
   when cancelled is not. (Task 2 "candidates".)
5. A global ADMIN decides a project policy's approval through the admin prefix: the resume succeeds (route derived
   from the policy, D229). (Task 6 "admin prefix on a project policy".)

---

### Task 1: Schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (new `FleetApproval`; `BudgetIncident.approvalId` comment; `FleetActivity`
  `entityType` comment)
- Create: `apps/api/prisma/migrations/20261003090000_fleet_approvals/migration.sql`
- Modify: `apps/api/test/helpers/partial-indexes.ts`
- Test: `apps/api/test/integration/fleet/fleet-approvals-schema.integration.spec.ts`

**Interfaces:**
- Produces: Prisma model `fleetApproval` with the fields below; partial index `FleetApproval_pending_policy_key`.

- [ ] **Step 1: Write the failing schema test**

```ts
/**
 * Fleet S1.5 slice 1a — FleetApproval table and the one-pending-per-policy index (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-schema.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('FleetApproval schema (PG)', () => {
  const prisma = new PrismaClient();
  const base = { type: 'budget_override_required', payload: {}, requestedAt: new Date() };

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores an approval with defaults and nullable bash columns', async () => {
    const row = await prisma.fleetApproval.create({ data: { ...base, policyId: 'p0' } });
    expect(row).toEqual(expect.objectContaining({
      status: 'pending', projectId: null, jobId: null, leaseEpoch: null, naxAskId: null, outcome: null,
      expiresAt: null, decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null,
    }));
  });

  it('allows one pending approval per policy, any number of closed ones', async () => {
    await prisma.fleetApproval.create({ data: { ...base, policyId: 'p1' } });
    await expect(prisma.fleetApproval.create({ data: { ...base, policyId: 'p1' } })).rejects.toThrow();
    await prisma.fleetApproval.create({ data: { ...base, policyId: 'p1', status: 'cancelled' } });
    await prisma.fleetApproval.create({ data: { ...base, policyId: 'p1', status: 'approved' } });
    expect(await prisma.fleetApproval.count({ where: { policyId: 'p1' } })).toBe(3);
  });

  it('dedups a re-reported bash ask on (jobId, leaseEpoch, naxAskId)', async () => {
    const ask = { ...base, type: 'nax_bash_escalate', jobId: 'j1', leaseEpoch: 1, naxAskId: 'ask-00000001' };
    await prisma.fleetApproval.create({ data: ask });
    await expect(prisma.fleetApproval.create({ data: ask })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-approvals-schema.integration.spec.ts`
Expected: FAIL, TypeScript error `Property 'fleetApproval' does not exist on type 'PrismaClient'`.

- [ ] **Step 3: Add the model**

In `apps/api/prisma/schema.prisma`, change the `BudgetIncident.approvalId` comment to
`// FleetApproval id (S1.5); no FK`, extend the `FleetActivity.entityType` comment with `| approval`, and add after
`BudgetIncident`:

```prisma
/// S1.5 C8 typed approval (spec 2026-10-02 §1.1). Partial unique (policyId) WHERE status = 'pending' is raw SQL.
/// policyId has no FK: a deleted policy closes its approval (policy_deleted) and the row stays as history.
model FleetApproval {
  id          String    @id @default(cuid())
  type        String // budget_override_required | nax_bash_escalate
  status      String    @default("pending") // pending | approved | rejected | expired | cancelled
  projectId   String?
  jobId       String?
  leaseEpoch  Int?
  naxAskId    String?
  policyId    String?
  payload     Json
  outcome     Json?
  requestedAt DateTime
  expiresAt   DateTime?
  decision    String?
  decidedById String?
  decidedAt   DateTime?
  resolvedBy  String? // user | timeout | job_ended | superseded | manual_resume | window_reset | policy_deleted
  comment     String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([jobId, leaseEpoch, naxAskId])
  @@index([projectId, status, requestedAt])
  @@index([status, expiresAt])
  @@index([jobId, status])
  @@index([policyId])
}
```

- [ ] **Step 4: Write the migration**

Create `apps/api/prisma/migrations/20261003090000_fleet_approvals/migration.sql`:

```sql
-- S1.5 slice 1a: typed approvals (C8). Bash columns are used from slice 2a.
-- CreateTable
CREATE TABLE "FleetApproval" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "projectId" TEXT,
    "jobId" TEXT,
    "leaseEpoch" INTEGER,
    "naxAskId" TEXT,
    "policyId" TEXT,
    "payload" JSONB NOT NULL,
    "outcome" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "decision" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FleetApproval_jobId_leaseEpoch_naxAskId_key" ON "FleetApproval"("jobId", "leaseEpoch", "naxAskId");

-- CreateIndex
CREATE INDEX "FleetApproval_projectId_status_requestedAt_idx" ON "FleetApproval"("projectId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "FleetApproval_status_expiresAt_idx" ON "FleetApproval"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "FleetApproval_jobId_status_idx" ON "FleetApproval"("jobId", "status");

-- CreateIndex
CREATE INDEX "FleetApproval_policyId_idx" ON "FleetApproval"("policyId");

-- S1.5 §1.1: one pending override per policy; prisma db push cannot express this.
CREATE UNIQUE INDEX IF NOT EXISTS "FleetApproval_pending_policy_key" ON "FleetApproval" ("policyId") WHERE "status" = 'pending';
```

Check the generated SQL matches Prisma's own output: `cd apps/api && bunx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$TEST_DATABASE_URL" --script`
must print only an empty migration (the partial index is extra raw SQL and is not in the datamodel). If it prints
statements, fix the migration until it does not.

- [ ] **Step 5: Register the partial index for tests**

Append to `PARTIAL_UNIQUE_INDEXES` in `apps/api/test/helpers/partial-indexes.ts`:

```ts
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetApproval_pending_policy_key" ON "FleetApproval" ("policyId") WHERE "status" = 'pending'`,
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && bunx prisma generate && bun run test:scoped test/integration/fleet/fleet-approvals-schema.integration.spec.ts test/unit/fleet/partial-indexes.spec.ts`
Expected: PASS (3 + 4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/test/helpers/partial-indexes.ts apps/api/test/integration/fleet/fleet-approvals-schema.integration.spec.ts
git commit -m "feat(fleet): S1.5 1a FleetApproval table and pending-per-policy index"
```

---

### Task 2: Domain types and repository

**Files:**
- Create: `apps/api/src/fleet/approvals/domain/approval.domain.ts`
- Create: `apps/api/src/fleet/approvals/prisma-approval.repository.ts`
- Test: `apps/api/test/integration/fleet/fleet-approval-repository.integration.spec.ts`

**Interfaces:**
- Consumes: `budgetReason(policyId)` from `apps/api/src/fleet/budgets/budget-rules.ts`.
- Produces (used by Tasks 3-7):

```ts
export const APPROVAL_TYPES = ['budget_override_required', 'nax_bash_escalate'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_DECISIONS = ['allow', 'allow_for_job', 'deny', 'raise_budget_and_resume', 'keep_paused'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export const APPROVAL_RESOLVED_BY = ['user', 'timeout', 'job_ended', 'superseded', 'manual_resume', 'window_reset', 'policy_deleted'] as const;
export type ApprovalResolvedBy = (typeof APPROVAL_RESOLVED_BY)[number];
export const MAX_REQUEUE_CANDIDATES = 200;

export interface FleetApprovalRecord { id; type; status; projectId: string | null; jobId: string | null; leaseEpoch: number | null;
  naxAskId: string | null; policyId: string | null; payload: Record<string, unknown>; outcome: Record<string, unknown> | null;
  requestedAt: Date; expiresAt: Date | null; decision: ApprovalDecision | null; decidedById: string | null; decidedAt: Date | null;
  resolvedBy: ApprovalResolvedBy | null; comment: string | null; createdAt: Date; updatedAt: Date }
export interface NewFleetApproval { type; projectId; policyId; payload; requestedAt; jobId?; leaseEpoch?; naxAskId?; expiresAt? }
export interface ApprovalResolution { status: Exclude<ApprovalStatus, 'pending'>; resolvedBy: ApprovalResolvedBy; decidedAt: Date;
  decision?: ApprovalDecision | null; decidedById?: string | null; comment?: string | null; outcome?: Record<string, unknown> | null }
export interface ApprovalFilters { projectId?: string; status?: ApprovalStatus; type?: ApprovalType; jobId?: string }
export interface RequeueCandidate { jobId: string; projectId: string; feature: string; queuedAt: Date }
export interface PendingCount { projectId: string; slug: string; pending: number }
export const APPROVAL_REPOSITORY = Symbol('APPROVAL_REPOSITORY');
export interface IApprovalRepository {
  create(data: NewFleetApproval): Promise<FleetApprovalRecord>;
  findById(id: string): Promise<FleetApprovalRecord | null>;
  lockById(id: string): Promise<FleetApprovalRecord | null>;           // FOR UPDATE, inside txManager.run
  findPendingForPolicy(policyId: string): Promise<FleetApprovalRecord | null>;
  resolve(id: string, r: ApprovalResolution): Promise<FleetApprovalRecord>;
  setOutcome(id: string, outcome: Record<string, unknown>): Promise<FleetApprovalRecord>;
  findPage(f: ApprovalFilters, page: IPageOption): Promise<IPageResult<FleetApprovalRecord>>;   // newest first
  countPending(projectIds: readonly string[]): Promise<PendingCount[]>;  // only projects with pending > 0, slug order
  countPendingUnscoped(): Promise<number>;
  findRequeueCandidates(policyId: string, since: Date, limit: number): Promise<RequeueCandidate[]>;
  findProjectSlug(projectId: string): Promise<string | null>;
}
```

- [ ] **Step 1: Write the failing repository test**

```ts
/**
 * Fleet S1.5 slice 1a — PrismaApprovalRepository on PG: create, lock, resolve, page, counts, re-queue candidates.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-repository.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PrismaApprovalRepository } from '../../../src/fleet/approvals/prisma-approval.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('approval repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let repo: PrismaApprovalRepository;
  let tx: ITransactionManager;
  let n = 0;
  const T0 = new Date('2026-10-02T10:00:00.000Z');
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `rp${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'CANCELLED',
      cancelReason: 'budget:pol', startedAt: null, finishedAt: new Date(T0.getTime() + 1_000), queuedAt: new Date(T0.getTime() + n), ...over,
    },
  });
  const budget = (over: Partial<Parameters<PrismaApprovalRepository['create']>[0]> = {}) => repo.create({
    type: 'budget_override_required', projectId: world.projectId, policyId: 'pol', payload: { spentUsd: '10' }, requestedAt: T0, ...over,
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    repo = app.get(PrismaApprovalRepository);
    tx = app.get(TRANSACTION_MANAGER);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('creates, finds the pending one per policy, locks and resolves', async () => {
    const a = await budget();
    expect(a).toEqual(expect.objectContaining({ status: 'pending', payload: { spentUsd: '10' }, outcome: null }));
    expect((await repo.findPendingForPolicy('pol'))?.id).toBe(a.id);
    const resolved = await tx.run(async () => {
      expect((await repo.lockById(a.id))?.id).toBe(a.id);
      return repo.resolve(a.id, { status: 'rejected', resolvedBy: 'user', decidedAt: T0, decision: 'keep_paused', decidedById: world.ids.root, comment: 'no' });
    });
    expect(resolved).toEqual(expect.objectContaining({ status: 'rejected', decision: 'keep_paused', resolvedBy: 'user', comment: 'no' }));
    expect(await repo.findPendingForPolicy('pol')).toBeNull();
    expect((await repo.setOutcome(a.id, { requeueResults: [] })).outcome).toEqual({ requeueResults: [] });
    expect(await tx.run(() => repo.lockById('missing'))).toBeNull();
  });

  it('pages newest first with filters', async () => {
    const old = await budget({ policyId: 'a', requestedAt: T0 });
    const recent = await budget({ policyId: 'b', requestedAt: new Date(T0.getTime() + 60_000) });
    await budget({ policyId: 'c', projectId: null });
    const page = await repo.findPage({ projectId: world.projectId }, { current: 1, size: 10 } as never);
    expect(page.records.map((r) => r.id)).toEqual([recent.id, old.id]);
    expect((await repo.findPage({ status: 'pending' }, { current: 1, size: 10 } as never)).total).toBe(3);
  });

  it('counts pending per project with slugs, and unscoped ones', async () => {
    await budget({ policyId: 'a' });
    await budget({ policyId: 'b' });
    await budget({ policyId: 'c', projectId: world.opsProjectId });
    await budget({ policyId: 'd', projectId: null });
    const closed = await budget({ policyId: 'e' });
    await repo.resolve(closed.id, { status: 'cancelled', resolvedBy: 'policy_deleted', decidedAt: T0 });
    expect(await repo.countPending([world.projectId, world.opsProjectId])).toEqual([
      { projectId: world.opsProjectId, slug: 'ops', pending: 1 },
      { projectId: world.projectId, slug: 'web', pending: 2 },
    ]);
    expect(await repo.countPending([])).toEqual([]);
    expect(await repo.countPendingUnscoped()).toBe(1);
  });

  it('candidates: budget-cancelled before start since the request, oldest first, capped', async () => {
    const a = await job();
    const b = await job({ projectId: world.opsProjectId, repoId: world.foreignRepoId });
    await job({ startedAt: new Date(T0.getTime() + 500) });              // was running: not offered
    await job({ cancelReason: 'budget:other' });                          // another policy
    await job({ cancelReason: null });                                    // a user cancel
    await job({ finishedAt: new Date(T0.getTime() - 1) });                // before this approval
    await job({ state: 'QUEUED', finishedAt: null });                     // already requeued
    const rows = await repo.findRequeueCandidates('pol', T0, 10);
    expect(rows.map((r) => r.jobId)).toEqual([a.id, b.id]);
    expect(rows[1]).toEqual(expect.objectContaining({ projectId: world.opsProjectId, feature: b.feature }));
    expect(await repo.findRequeueCandidates('pol', T0, 1)).toHaveLength(1);
  });

  it('finds a project slug', async () => {
    expect(await repo.findProjectSlug(world.projectId)).toBe('web');
    expect(await repo.findProjectSlug('missing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-repository.integration.spec.ts`
Expected: FAIL, `Cannot find module '../../../src/fleet/approvals/prisma-approval.repository'`.

- [ ] **Step 3: Write the domain file**

Create `apps/api/src/fleet/approvals/domain/approval.domain.ts` with exactly the "Produces" block above, written out
with full field types (`id: string`, `type: ApprovalType`, `status: ApprovalStatus`, `NewFleetApproval.projectId:
string | null`, `NewFleetApproval.policyId: string | null`, `payload: Record<string, unknown>`, optional fields typed as
in `FleetApprovalRecord`), plus these imports at the top:

```ts
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
```

and this doc comment above `IApprovalRepository`:

```ts
/** S1.5 §1.1. Lock order (§1.4): a caller that also locks a BudgetPolicy locks it first. */
```

- [ ] **Step 4: Write the repository**

Create `apps/api/src/fleet/approvals/prisma-approval.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { FleetApproval as ApprovalRow, Prisma, PrismaClient } from '@prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { FleetJobState } from '../../common/enums';
import { budgetReason } from '../budgets/budget-rules';
import {
  ApprovalDecision, ApprovalFilters, ApprovalResolution, ApprovalResolvedBy, ApprovalStatus, ApprovalType, FleetApprovalRecord,
  IApprovalRepository, NewFleetApproval, PendingCount, RequeueCandidate,
} from './domain/approval.domain';

const asObject = (v: Prisma.JsonValue | null): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const toApproval = (r: ApprovalRow): FleetApprovalRecord => ({
  ...r,
  type: r.type as ApprovalType,
  status: r.status as ApprovalStatus,
  decision: r.decision as ApprovalDecision | null,
  resolvedBy: r.resolvedBy as ApprovalResolvedBy | null,
  payload: asObject(r.payload) ?? {},
  outcome: asObject(r.outcome),
});

const json = (v: Record<string, unknown>): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

@Injectable()
export class PrismaApprovalRepository implements IApprovalRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /** Transaction-scoped inside txManager.run (nestjs-prisma ALS proxy). */
  private get db() {
    return this.prisma.client;
  }

  async create(d: NewFleetApproval): Promise<FleetApprovalRecord> {
    return toApproval(await this.db.fleetApproval.create({
      data: {
        type: d.type, projectId: d.projectId, policyId: d.policyId, payload: json(d.payload), requestedAt: d.requestedAt,
        jobId: d.jobId ?? null, leaseEpoch: d.leaseEpoch ?? null, naxAskId: d.naxAskId ?? null, expiresAt: d.expiresAt ?? null,
      },
    }));
  }

  async findById(id: string): Promise<FleetApprovalRecord | null> {
    const r = await this.db.fleetApproval.findUnique({ where: { id } });
    return r ? toApproval(r) : null;
  }

  async lockById(id: string): Promise<FleetApprovalRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "FleetApproval" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 0 ? null : this.findById(id);
  }

  async findPendingForPolicy(policyId: string): Promise<FleetApprovalRecord | null> {
    const r = await this.db.fleetApproval.findFirst({ where: { policyId, status: 'pending' } });
    return r ? toApproval(r) : null;
  }

  async resolve(id: string, x: ApprovalResolution): Promise<FleetApprovalRecord> {
    return toApproval(await this.db.fleetApproval.update({
      where: { id },
      data: {
        status: x.status, resolvedBy: x.resolvedBy, decidedAt: x.decidedAt, decision: x.decision ?? null,
        decidedById: x.decidedById ?? null, comment: x.comment ?? null,
        ...(x.outcome !== undefined ? { outcome: x.outcome === null ? Prisma.DbNull : json(x.outcome) } : {}),
      },
    }));
  }

  async setOutcome(id: string, outcome: Record<string, unknown>): Promise<FleetApprovalRecord> {
    return toApproval(await this.db.fleetApproval.update({ where: { id }, data: { outcome: json(outcome) } }));
  }

  async findPage(f: ApprovalFilters, page: IPageOption): Promise<IPageResult<FleetApprovalRecord>> {
    const where: Prisma.FleetApprovalWhereInput = {
      ...(f.projectId !== undefined ? { projectId: f.projectId } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.type ? { type: f.type } : {}),
      ...(f.jobId ? { jobId: f.jobId } : {}),
    };
    const rows = await Paginate(this.db.fleetApproval, page, { where, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] });
    return rows.remap((r: ApprovalRow) => toApproval(r));
  }

  async countPending(projectIds: readonly string[]): Promise<PendingCount[]> {
    if (projectIds.length === 0) return [];
    const groups = await this.db.fleetApproval.groupBy({
      by: ['projectId'], where: { status: 'pending', projectId: { in: [...projectIds] } }, _count: { _all: true },
    });
    const ids = groups.map((g) => g.projectId).filter((id): id is string => id !== null);
    const projects = await this.db.project.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true } });
    const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
    return groups
      .filter((g) => g.projectId !== null && slugOf.has(g.projectId))
      .map((g) => ({ projectId: g.projectId as string, slug: slugOf.get(g.projectId as string) as string, pending: g._count._all }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  countPendingUnscoped(): Promise<number> {
    return this.db.fleetApproval.count({ where: { status: 'pending', projectId: null } });
  }

  async findRequeueCandidates(policyId: string, since: Date, limit: number): Promise<RequeueCandidate[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { state: FleetJobState.CANCELLED, cancelReason: budgetReason(policyId), startedAt: null, finishedAt: { gte: since } },
      orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, projectId: true, feature: true, queuedAt: true },
    });
    return rows.map((r) => ({ jobId: r.id, projectId: r.projectId, feature: r.feature, queuedAt: r.queuedAt }));
  }

  async findProjectSlug(projectId: string): Promise<string | null> {
    return (await this.db.project.findUnique({ where: { id: projectId }, select: { slug: true } }))?.slug ?? null;
  }
}
```

The repository needs a provider to be resolvable from the app in the test: Task 3 registers it in
`ApprovalStoreModule`. To run this task's test now, also do Task 3 Step 5 (the module file) and add the module to
`FleetModule` imports, or run this test after Task 3.

- [ ] **Step 5: Run it to verify it passes (after Task 3 Step 5 is in place)**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-repository.integration.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/approvals/domain apps/api/src/fleet/approvals/prisma-approval.repository.ts apps/api/test/integration/fleet/fleet-approval-repository.integration.spec.ts
git commit -m "feat(fleet): S1.5 1a approval repository and re-queue candidate query"
```

---

### Task 3: Store module, `ApprovalCloser`, live event and payloads

**Files:**
- Modify: `apps/api/src/live/live-event.ts` (new `LiveFleetApprovalEvent`, union)
- Create: `apps/api/src/fleet/approvals/approval-payloads.ts`
- Create: `apps/api/src/fleet/approvals/approval-live.publisher.ts`
- Create: `apps/api/src/fleet/approvals/approval-closer.ts`
- Create: `apps/api/src/fleet/approvals/approval-store.module.ts`
- Modify: `apps/api/src/fleet/fleet.module.ts` (import `ApprovalStoreModule` until Task 6 adds `ApprovalsModule`)
- Test: `apps/api/src/fleet/approvals/approval-closer.spec.ts`, `apps/api/src/fleet/approvals/approval-payloads.spec.ts`

**Interfaces:**
- Consumes: `IApprovalRepository`, `APPROVAL_REPOSITORY` (Task 2); `BudgetPolicyRecord` (budgets domain);
  `FleetActivityService.record`; `WebhookDispatcherService.dispatch`; `ProjectEventBus.publish`.
- Produces:

```ts
// live-event.ts
export interface LiveFleetApprovalEvent { id: string; type: 'fleet_approval'; projectId: string; approvalId: string; status: string; at: string }
export type LiveEvent = LiveTicketEvent | LiveFleetJobEvent | LiveFleetApprovalEvent;

// approval-live.publisher.ts
export class ApprovalLivePublisher {
  event(a: Pick<FleetApprovalRecord, 'id' | 'projectId' | 'status'>): LiveFleetApprovalEvent[];   // [] when projectId is null
  publish(events: readonly LiveFleetApprovalEvent[]): void;
}

// approval-closer.ts
export interface ApprovalActor { type: 'USER' | 'SYSTEM'; id: string; responsibleUserId: string }
export interface ApprovalChange { approval: FleetApprovalRecord | null; live: LiveFleetApprovalEvent[] }
export interface PolicyClose { status: 'approved' | 'cancelled'; resolvedBy: ApprovalResolvedBy; actor: ApprovalActor;
  decision?: ApprovalDecision; outcome?: Record<string, unknown> }
export class ApprovalCloser {
  /** Inside the hard-stop transaction (policy locked). Supersedes a stray pending one first. */
  openBudget(policy: BudgetPolicyRecord, at: { windowStart: Date; spentUsd: string }, now: Date): Promise<ApprovalChange>;
  /** Inside the caller's transaction (policy locked). No pending approval -> { approval: null, live: [] }. */
  closeForPolicy(policyId: string, close: PolicyClose, now: Date): Promise<ApprovalChange>;
  /** Records the decided row's activity and webhook; used by ApprovalsService (Task 5). */
  recordResolved(approval: FleetApprovalRecord, actor: ApprovalActor): Promise<LiveFleetApprovalEvent[]>;
}

// approval-payloads.ts
export function approvalActivityPayload(a: FleetApprovalRecord, extra?: Record<string, unknown>): Record<string, unknown>;
export function approvalWebhookPayload(a: FleetApprovalRecord, slug: string): Record<string, unknown>;
export function approvalPath(slug: string, id: string): string;   // `/${slug}/fleet/approvals?id=${id}`
```

- [ ] **Step 1: Write the failing payload test**

`apps/api/src/fleet/approvals/approval-payloads.spec.ts`:

```ts
import { FLEET_ACTIVITY_SECRET_KEY } from '../activity/fleet-activity.service';
import { approvalActivityPayload, approvalPath, approvalWebhookPayload } from './approval-payloads';
import type { FleetApprovalRecord } from './domain/approval.domain';

const T = new Date('2026-10-02T10:00:00.000Z');
const approval = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null,
  policyId: 'pol', payload: { spentUsd: '10', command: 'rm -rf /' }, outcome: null, requestedAt: T, expiresAt: null, decision: null,
  decidedById: null, decidedAt: null, resolvedBy: null, comment: null, createdAt: T, updatedAt: T, ...over,
});

describe('approval payloads', () => {
  it('builds the inbox path', () => {
    expect(approvalPath('web', 'a1')).toBe('/web/fleet/approvals?id=a1');
  });

  it('webhook body carries ids and state, never the payload (A8)', () => {
    const body = approvalWebhookPayload(approval({ status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'user' }), 'web');
    expect(body).toEqual({
      approvalId: 'a1', type: 'budget_override_required', status: 'approved', decision: 'raise_budget_and_resume', resolvedBy: 'user',
      projectId: 'p1', jobId: null, policyId: 'pol', expiresAt: null, path: '/web/fleet/approvals?id=a1',
    });
    expect(JSON.stringify(body)).not.toContain('rm -rf');
  });

  it('activity payload keys never trip the secret check', () => {
    const payload = approvalActivityPayload(approval(), { requeueJobIds: ['j1'] });
    expect(Object.keys(payload).some((k) => FLEET_ACTIVITY_SECRET_KEY.test(k))).toBe(false);
    expect(payload).toEqual({ type: 'budget_override_required', status: 'pending', decision: null, resolvedBy: null, policyId: 'pol', jobId: null, requeueJobIds: ['j1'] });
  });
});
```

`FleetActivityService` keeps its regex in a module constant `SECRET_KEY`; export it as `FLEET_ACTIVITY_SECRET_KEY`
(rename the constant and its one use in `apps/api/src/fleet/activity/fleet-activity.service.ts`).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals/approval-payloads.spec.ts`
Expected: FAIL, `Cannot find module './approval-payloads'`.

- [ ] **Step 3: Write the payloads and the live event**

`apps/api/src/fleet/approvals/approval-payloads.ts`:

```ts
import type { FleetApprovalRecord } from './domain/approval.domain';

export const approvalPath = (slug: string, id: string): string => `/${slug}/fleet/approvals?id=${encodeURIComponent(id)}`;

/** FleetActivity payload of an approval row. No `*Key` names (FleetActivityService rejects them). */
export function approvalActivityPayload(a: FleetApprovalRecord, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: a.type, status: a.status, decision: a.decision, resolvedBy: a.resolvedBy, policyId: a.policyId, jobId: a.jobId, ...extra };
}

/** Body of fleet.approval.requested / fleet.approval.resolved (spec §2.5). Never payload content (A8). */
export function approvalWebhookPayload(a: FleetApprovalRecord, slug: string): Record<string, unknown> {
  return {
    approvalId: a.id, type: a.type, status: a.status, decision: a.decision, resolvedBy: a.resolvedBy, projectId: a.projectId,
    jobId: a.jobId, policyId: a.policyId, expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null, path: approvalPath(slug, a.id),
  };
}
```

In `apps/api/src/live/live-event.ts`, after `LiveFleetJobEvent`:

```ts
/**
 * Fleet S1.5 (spec §2.5): content-free approval change; the inbox refetches.
 * Only approvals with a project are published (the bus routes on projectId).
 */
export interface LiveFleetApprovalEvent {
  id: string;
  type: 'fleet_approval';
  projectId: string;
  approvalId: string;
  status: string;
  at: string;
}

export type LiveEvent = LiveTicketEvent | LiveFleetJobEvent | LiveFleetApprovalEvent;
```

(replace the old `LiveEvent` line, and add `fleet_approval since fleet S1.5` to the file's header comment).
`live-stream.ts` already forwards any `event.type`, so the SSE frame name is `fleet_approval` with no change there.

`apps/api/src/fleet/approvals/approval-live.publisher.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { ProjectEventBus } from '../../live/project-event-bus';
import type { FleetApprovalRecord } from './domain/approval.domain';

/** Builds fleet_approval live events inside a transaction; publishes them only after it commits. */
@Injectable()
export class ApprovalLivePublisher {
  constructor(private readonly bus: ProjectEventBus) {}

  /** [] for an approval with no project: there is no admin live channel (spec §2.5). */
  event(a: Pick<FleetApprovalRecord, 'id' | 'projectId' | 'status'>): LiveFleetApprovalEvent[] {
    if (!a.projectId) return [];
    return [{ id: randomUUID(), type: 'fleet_approval', projectId: a.projectId, approvalId: a.id, status: a.status, at: new Date().toISOString() }];
  }

  publish(events: readonly LiveFleetApprovalEvent[]): void {
    for (const event of events) this.bus.publish(event);
  }
}
```

- [ ] **Step 4: Write the failing closer test**

`apps/api/src/fleet/approvals/approval-closer.spec.ts` (fakes, no DB):

```ts
import { ApprovalCloser } from './approval-closer';
import type { FleetApprovalRecord, NewFleetApproval } from './domain/approval.domain';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'pol', scopeType: 'project', scopeId: 'p1', scopeKey: 'project:p1', projectId: 'p1', windowKind: 'calendar_month_utc',
  amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish', pausedAt: NOW, pausedWindowStart: NOW,
  createdById: 'u0', updatedById: 'u1', createdAt: NOW, updatedAt: NOW, ...over,
});

function fakes() {
  const rows = new Map<string, FleetApprovalRecord>();
  let seq = 0;
  const repo = {
    create: jest.fn(async (d: NewFleetApproval) => {
      const row = { id: `a${++seq}`, status: 'pending', jobId: null, leaseEpoch: null, naxAskId: null, outcome: null, expiresAt: null,
        decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW, ...d } as FleetApprovalRecord;
      rows.set(row.id, row);
      return row;
    }),
    findPendingForPolicy: jest.fn(async (id: string) => [...rows.values()].find((r) => r.policyId === id && r.status === 'pending') ?? null),
    lockById: jest.fn(async (id: string) => rows.get(id) ?? null),
    resolve: jest.fn(async (id: string, x: Partial<FleetApprovalRecord>) => {
      const row = { ...(rows.get(id) as FleetApprovalRecord), ...x };
      rows.set(id, row);
      return row;
    }),
    findProjectSlug: jest.fn(async () => 'web'),
  };
  const activity = { record: jest.fn(async () => undefined) };
  const webhooks = { dispatch: jest.fn(async () => undefined) };
  const live = { event: jest.fn((a: FleetApprovalRecord) => (a.projectId ? [{ approvalId: a.id, status: a.status }] : [])) };
  const closer = new ApprovalCloser(repo as never, activity as never, webhooks as never, live as never);
  return { closer, repo, activity, webhooks, rows };
}

describe('ApprovalCloser', () => {
  it('opens a budget approval with the stop snapshot, activity, webhook and live event', async () => {
    const { closer, activity, webhooks } = fakes();
    const r = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10.5' }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({
      type: 'budget_override_required', status: 'pending', projectId: 'p1', policyId: 'pol', requestedAt: NOW,
      payload: { scopeType: 'project', scopeId: 'p1', windowKind: 'calendar_month_utc', windowStart: NOW.toISOString(), spentUsd: '10.5', amountUsd: '10' },
    }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'SYSTEM', action: 'approval.requested', entityType: 'approval', entityId: r.approval?.id, projectId: 'p1', responsibleUserId: 'u1',
    }));
    expect(webhooks.dispatch).toHaveBeenCalledWith('p1', 'fleet.approval.requested', expect.objectContaining({ approvalId: r.approval?.id, path: `/web/fleet/approvals?id=${r.approval?.id}` }));
    expect(r.live).toHaveLength(1);
  });

  it('supersedes a stray pending approval before opening a new one', async () => {
    const { closer, rows } = fakes();
    const first = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const second = await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '11' }, NOW);
    expect(rows.get(first.approval?.id as string)).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'superseded' }));
    expect(second.approval?.status).toBe('pending');
  });

  it('sends no webhook and no live event for a policy with no project', async () => {
    const { closer, webhooks } = fakes();
    const r = await closer.openBudget(policy({ scopeType: 'global', scopeId: null, projectId: null }), { windowStart: NOW, spentUsd: '1' }, NOW);
    expect(webhooks.dispatch).not.toHaveBeenCalled();
    expect(r.live).toEqual([]);
  });

  it('closes the pending approval of a policy, or does nothing when there is none', async () => {
    const { closer, activity, webhooks } = fakes();
    expect(await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'window_reset', actor: { type: 'SYSTEM', id: 'system', responsibleUserId: 'u1' } }, NOW))
      .toEqual({ approval: null, live: [] });
    await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const r = await closer.closeForPolicy('pol', {
      status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume',
      actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' }, outcome: { resumedAmountUsd: '20', requeueResults: [] },
    }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({ status: 'approved', resolvedBy: 'manual_resume', decidedById: 'u9', decidedAt: NOW, outcome: { resumedAmountUsd: '20', requeueResults: [] } }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'USER', actorId: 'u9', action: 'approval.decided' }));
    expect(webhooks.dispatch).toHaveBeenLastCalledWith('p1', 'fleet.approval.resolved', expect.objectContaining({ status: 'approved' }));
  });

  it('records a cancelled close as approval.cancelled with no decider', async () => {
    const { closer, activity } = fakes();
    await closer.openBudget(policy(), { windowStart: NOW, spentUsd: '10' }, NOW);
    const r = await closer.closeForPolicy('pol', { status: 'cancelled', resolvedBy: 'policy_deleted', actor: { type: 'USER', id: 'u9', responsibleUserId: 'u9' } }, NOW);
    expect(r.approval).toEqual(expect.objectContaining({ status: 'cancelled', decidedById: null, decision: null }));
    expect(activity.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'approval.cancelled' }));
  });
});
```

- [ ] **Step 5: Write the closer and the store module**

`apps/api/src/fleet/approvals/approval-closer.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { LiveFleetApprovalEvent } from '../../live/live-event';
import { WebhookDispatcherService } from '../../webhook/webhook-dispatcher.service';
import { FleetActivityService } from '../activity/fleet-activity.service';
import type { BudgetPolicyRecord } from '../budgets/domain/budget.domain';
import { SYSTEM_ACTOR } from '../jobs/job-transitions.service';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { approvalActivityPayload, approvalWebhookPayload } from './approval-payloads';
import {
  APPROVAL_REPOSITORY, ApprovalDecision, ApprovalResolvedBy, FleetApprovalRecord, IApprovalRepository,
} from './domain/approval.domain';

export interface ApprovalActor { type: 'USER' | 'SYSTEM'; id: string; responsibleUserId: string }
export interface ApprovalChange { approval: FleetApprovalRecord | null; live: LiveFleetApprovalEvent[] }
export interface PolicyClose {
  status: 'approved' | 'cancelled';
  resolvedBy: ApprovalResolvedBy;
  actor: ApprovalActor;
  decision?: ApprovalDecision;
  outcome?: Record<string, unknown>;
}

/**
 * S1.5 §2.1: the narrow port budgets (and, from 2a, jobs) use to open and close approvals inside their own
 * transactions. Callers hold the BudgetPolicy lock (lock order, spec §1.4) and publish `live` after commit.
 */
@Injectable()
export class ApprovalCloser {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly repo: IApprovalRepository,
    private readonly activity: FleetActivityService,
    private readonly webhooks: WebhookDispatcherService,
    private readonly livePublisher: ApprovalLivePublisher,
  ) {}

  async openBudget(policy: BudgetPolicyRecord, at: { windowStart: Date; spentUsd: string }, now: Date): Promise<ApprovalChange> {
    const system: ApprovalActor = { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: policy.updatedById };
    const stray = await this.closeForPolicy(policy.id, { status: 'cancelled', resolvedBy: 'superseded', actor: system }, now);
    const approval = await this.repo.create({
      type: 'budget_override_required', projectId: policy.projectId, policyId: policy.id, requestedAt: now,
      payload: {
        scopeType: policy.scopeType, scopeId: policy.scopeId, windowKind: policy.windowKind,
        windowStart: at.windowStart.toISOString(), spentUsd: at.spentUsd, amountUsd: policy.amountUsd,
      },
    });
    await this.record(approval, system, 'approval.requested');
    await this.dispatch(approval, 'fleet.approval.requested');
    return { approval, live: [...stray.live, ...this.livePublisher.event(approval)] };
  }

  async closeForPolicy(policyId: string, close: PolicyClose, now: Date): Promise<ApprovalChange> {
    const pending = await this.repo.findPendingForPolicy(policyId);
    if (!pending || !(await this.repo.lockById(pending.id))) return { approval: null, live: [] };
    const decided = close.status === 'approved';
    const approval = await this.repo.resolve(pending.id, {
      status: close.status, resolvedBy: close.resolvedBy, decidedAt: now,
      decision: decided ? close.decision ?? null : null, decidedById: decided && close.actor.type === 'USER' ? close.actor.id : null,
      ...(close.outcome !== undefined ? { outcome: close.outcome } : {}),
    });
    return { approval, live: await this.recordResolved(approval, close.actor) };
  }

  async recordResolved(approval: FleetApprovalRecord, actor: ApprovalActor): Promise<LiveFleetApprovalEvent[]> {
    await this.record(approval, actor, approval.status === 'cancelled' || approval.status === 'expired' ? 'approval.cancelled' : 'approval.decided');
    await this.dispatch(approval, 'fleet.approval.resolved');
    return this.livePublisher.event(approval);
  }

  private record(approval: FleetApprovalRecord, actor: ApprovalActor, action: string): Promise<void> {
    return this.activity.record({
      actorType: actor.type, actorId: actor.id, action, entityType: 'approval', entityId: approval.id, jobId: approval.jobId,
      projectId: approval.projectId, responsibleUserId: actor.responsibleUserId, payload: approvalActivityPayload(approval),
    });
  }

  private async dispatch(approval: FleetApprovalRecord, event: string): Promise<void> {
    if (!approval.projectId) return;
    const slug = await this.repo.findProjectSlug(approval.projectId);
    if (slug) await this.webhooks.dispatch(approval.projectId, event, approvalWebhookPayload(approval, slug));
  }
}
```

`apps/api/src/fleet/approvals/approval-store.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { LiveModule } from '../../live/live.module';
import { WebhookModule } from '../../webhook/webhook.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import { APPROVAL_REPOSITORY } from './domain/approval.domain';
import { PrismaApprovalRepository } from './prisma-approval.repository';

/** Plan D226: approval storage and the close port, importable by budgets (and jobs in 2a) without a cycle. */
@Module({
  imports: [PrismaModule, LiveModule, FleetActivityModule, WebhookModule],
  providers: [PrismaApprovalRepository, { provide: APPROVAL_REPOSITORY, useExisting: PrismaApprovalRepository }, ApprovalLivePublisher, ApprovalCloser],
  exports: [APPROVAL_REPOSITORY, PrismaApprovalRepository, ApprovalLivePublisher, ApprovalCloser],
})
export class ApprovalStoreModule {}
```

Add `ApprovalStoreModule` to the `imports` of `FleetModule` (`apps/api/src/fleet/fleet.module.ts`) so the
repository test of Task 2 can resolve it; Task 6 replaces it with `ApprovalsModule`.

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals/approval-payloads.spec.ts src/fleet/approvals/approval-closer.spec.ts test/integration/fleet/fleet-approval-repository.integration.spec.ts src/live`
Expected: PASS. Then `cd apps/api && bun run type-check` (no errors; the widened `LiveEvent` must still compile in
`live-stream.ts`, `project-event-bus.ts` and their specs).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/live/live-event.ts apps/api/src/fleet/approvals apps/api/src/fleet/activity/fleet-activity.service.ts apps/api/src/fleet/fleet.module.ts
git commit -m "feat(fleet): S1.5 1a approval store module, closer, live event and payloads"
```

---

### Task 4: Budget wiring (open on hard stop; close on manual resume, rollover, delete)

**Files:**
- Modify: `apps/api/src/fleet/budgets/domain/budget.domain.ts` (`NewBudgetIncident.approvalId`)
- Modify: `apps/api/src/fleet/budgets/prisma-budget.repository.ts` (`insertIncident`)
- Modify: `apps/api/src/fleet/budgets/budget-evaluator.ts`
- Modify: `apps/api/src/fleet/budgets/budgets.service.ts` (`resume` options, `remove`)
- Modify: `apps/api/src/fleet/budgets/budget-sweeper.ts` (`resetWindow`, `deleteOrphan`)
- Modify: `apps/api/src/fleet/budgets/budgets.module.ts` (import `ApprovalStoreModule`, export `BudgetsService`)
- Modify: `apps/api/src/fleet/budgets/budget-evaluator.spec.ts`, `apps/api/src/fleet/budgets/budget-sweeper.spec.ts` (constructor args)
- Test: `apps/api/test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts`

**Interfaces:**
- Consumes: `ApprovalCloser.openBudget`, `ApprovalCloser.closeForPolicy`, `ApprovalLivePublisher.publish` (Task 3).
- Produces:
  - `NewBudgetIncident.approvalId?: string | null` (omitted = null).
  - `BudgetsService.resume(actorId, route, id, amountUsd, now = new Date(), opts: { approvalId?: string } = {})`:
    with `approvalId`, stamps it on the `resumed` incident and does **not** close anything (the caller decided);
    without it, closes the pending approval as `manual_resume` (D234) and stamps that approval's id.
  - `BudgetsService` exported from `BudgetsModule`.

- [ ] **Step 1: Write the failing wiring test**

```ts
/**
 * Fleet S1.5 slice 1a — budgets open and close approvals: hard stop, manual resume, rollover, delete, orphan (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { BudgetsService } from '../../../src/fleet/budgets/budgets.service';
import { BudgetSweeper } from '../../../src/fleet/budgets/budget-sweeper';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000);

describeIntegration('budget approval wiring (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let evaluator: BudgetEvaluator;
  let budgets: BudgetsService;
  let sweeper: BudgetSweeper;
  const seen: LiveEvent[] = [];
  let n = 0;

  const projectPolicy = (over: Partial<Prisma.BudgetPolicyUncheckedCreateInput> = {}) => prisma.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null,
      createdById: world.ids.root, updatedById: world.ids.dev, ...over,
    },
  });
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `bw${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });
  const approvals = (policyId: string) => prisma.fleetApproval.findMany({ where: { policyId }, orderBy: { createdAt: 'asc' } });
  const hooks = (event: string) => prisma.outboxEvent.count({ where: { type: 'webhook_delivery', payload: { contains: `"event":"${event}"` } } });
  const project = { kind: 'project' as const, projectId: '' };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    evaluator = app.get(BudgetEvaluator);
    budgets = app.get(BudgetsService);
    sweeper = app.get(BudgetSweeper);
    project.projectId = world.projectId;
    app.get(ProjectEventBus).subscribe(world.projectId, (e) => seen.push(e));
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.approval.requested', 'fleet.approval.resolved']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
    seen.length = 0;
  });

  it('a hard stop opens one pending approval, stamps the incident, sends the webhook and a live event', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    expect((await evaluator.evaluate(policy.id)).stopped).toBe(true);
    const [a] = await approvals(policy.id);
    expect(a).toEqual(expect.objectContaining({ type: 'budget_override_required', status: 'pending', projectId: world.projectId }));
    expect(a.payload).toEqual(expect.objectContaining({ spentUsd: '10', amountUsd: '10', scopeType: 'project' }));
    const incident = await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'hard_stop' } });
    expect(incident.approvalId).toBe(a.id);
    expect(await hooks('fleet.approval.requested')).toBe(1);
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'fleet_approval', approvalId: a.id, status: 'pending' })]));
    expect(await prisma.fleetActivity.count({ where: { entityType: 'approval', entityId: a.id, action: 'approval.requested' } })).toBe(1);
  });

  it('a manual resume closes it as manual_resume and stamps the resumed incident', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    await budgets.resume(world.ids.root, project, policy.id, 20);
    const [a] = await approvals(policy.id);
    expect(a).toEqual(expect.objectContaining({ status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume', decidedById: world.ids.root }));
    expect(a.outcome).toEqual({ resumedAmountUsd: '20', requeueResults: [] });
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(a.id);
    expect(await hooks('fleet.approval.resolved')).toBe(1);
  });

  it('a resume with an approvalId stamps it and closes nothing', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    const [pending] = await approvals(policy.id);
    await budgets.resume(world.ids.root, project, policy.id, 20, new Date(), { approvalId: pending.id });
    expect((await approvals(policy.id))[0].status).toBe('pending');
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(pending.id);
  });

  it('policy delete closes it as policy_deleted (review focus 3)', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    await budgets.remove(world.ids.root, project, policy.id);
    expect((await approvals(policy.id))[0]).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'policy_deleted', decidedById: null }));
  });

  it('the month rollover closes it as window_reset', async () => {
    const lastMonth = new Date(Date.UTC(2026, 8, 1));
    const policy = await projectPolicy({ pausedAt: lastMonth, pausedWindowStart: lastMonth });
    await prisma.fleetApproval.create({ data: { type: 'budget_override_required', projectId: world.projectId, policyId: policy.id, payload: {}, requestedAt: lastMonth } });
    await sweeper.tick();
    expect((await approvals(policy.id))[0]).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'window_reset' }));
  });

  it('the orphan sweep closes it as policy_deleted', async () => {
    const policy = await prisma.budgetPolicy.create({
      data: { scopeType: 'runner', scopeId: 'gone', scopeKey: 'runner:gone', windowKind: 'lifetime', amountUsd: new Prisma.Decimal(1), pausedAt: new Date(), createdById: world.ids.root, updatedById: world.ids.root },
    });
    await prisma.fleetApproval.create({ data: { type: 'budget_override_required', policyId: policy.id, payload: {}, requestedAt: new Date() } });
    await sweeper.tick();
    expect((await approvals(policy.id))[0]).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'policy_deleted' }));
  });

  it('a stop after a resume at the same amount still opens an approval with no new incident (D228)', async () => {
    const policy = await projectPolicy();
    await job({ costSpentUsd: 10 });
    await evaluator.evaluate(policy.id);
    await prisma.budgetPolicy.update({ where: { id: policy.id }, data: { pausedAt: null, pausedWindowStart: null } });
    await prisma.fleetApproval.updateMany({ where: { policyId: policy.id }, data: { status: 'approved', resolvedBy: 'manual_resume' } });
    expect((await evaluator.evaluate(policy.id)).stopped).toBe(true);
    expect((await approvals(policy.id)).map((a) => a.status)).toEqual(['approved', 'pending']);
    expect(await prisma.budgetIncident.count({ where: { policyId: policy.id, kind: 'hard_stop' } })).toBe(1);
    expect(await hooks('fleet.approval.requested')).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts`
Expected: FAIL; the first test finds no approval (`a` undefined).

- [ ] **Step 3: Carry `approvalId` on incidents**

`budget.domain.ts`, in `NewBudgetIncident` add:

```ts
  /** S1.5: the approval this incident raised or resolved; omitted = null. */
  approvalId?: string | null;
```

`prisma-budget.repository.ts`, `insertIncident`:

```ts
  async insertIncident(i: NewBudgetIncident): Promise<boolean> {
    // Bind timestamps as ISO text cast to timestamp(3) (UTC), as casAssign does.
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "BudgetIncident" ("id", "policyId", "kind", "windowStart", "spentUsd", "amountUsd", "actorId", "approvalId")
      VALUES (${randomUUID()}, ${i.policyId}, ${i.kind}, CAST(${i.windowStart.toISOString()} AS timestamp(3)),
              CAST(${i.spentUsd} AS DECIMAL(12,4)), CAST(${i.amountUsd} AS DECIMAL(12,4)), ${i.actorId}, ${i.approvalId ?? null})
      ON CONFLICT DO NOTHING
      RETURNING "id"`;
    return rows.length > 0;
  }
```

- [ ] **Step 4: Open on hard stop (evaluator)**

In `budget-evaluator.ts`: inject `ApprovalCloser` and `ApprovalLivePublisher` as the last two constructor parameters
(`private readonly approvals: ApprovalCloser, private readonly approvalLive: ApprovalLivePublisher`); import
`LiveFleetApprovalEvent` from `../../live/live-event`. Change `NOTHING` and `evaluate`/`hardStop`:

```ts
const NOTHING = Object.freeze({
  result: { warned: false, stopped: false }, live: [] as LiveFleetJobEvent[], approvalLive: [] as LiveFleetApprovalEvent[], wake: [] as string[],
});
```

```ts
  async evaluate(policyId: string, now = new Date()): Promise<EvaluationResult> {
    const { result, live, approvalLive, wake } = await this.txManager.run(async () => {
      const policy = await this.repo.lockById(policyId);
      // A policy whose scope row is gone is ignored; the sweep deletes it (S1b §2.1).
      if (!policy || !(await this.repo.scopeExists(policy))) return NOTHING;
      const start = windowStart(policy.windowKind, now);
      const spent = await this.repo.windowSpend(policy, spendSince(policy.windowKind, now));
      const warned = warnReached(spent, policy.amountUsd, policy.warnPercent) ? await this.warn(policy, start, spent) : false;
      if (!policy.hardStop || isEffectivelyPaused(policy, now) || !hardReached(spent, policy.amountUsd)) {
        return { ...NOTHING, result: { warned, stopped: false } };
      }
      const stop = await this.hardStop(policy, start, spent, now);
      return { result: { warned, stopped: true }, ...stop };
    });
    this.live.publish(live);
    this.approvalLive.publish(approvalLive);
    for (const runnerId of new Set(wake)) this.notifier.notify(runnerId);
    return result;
  }
```

```ts
  /** S1.5 plan D227: the approval is opened first so the incident carries its id. */
  private async hardStop(policy: BudgetPolicyRecord, start: Date, spent: string, now: Date)
    : Promise<{ live: LiveFleetJobEvent[]; approvalLive: LiveFleetApprovalEvent[]; wake: string[] }> {
    await this.repo.update(policy.id, { pausedAt: now, pausedWindowStart: start });
    const opened = await this.approvals.openBudget(policy, { windowStart: start, spentUsd: spent }, now);
    const inserted = await this.repo.insertIncident({
      policyId: policy.id, kind: 'hard_stop', windowStart: start, spentUsd: spent, amountUsd: policy.amountUsd, actorId: null, approvalId: opened.approval?.id ?? null,
    });
    const queued = await this.repo.findQueuedJobIds(policy);
    const held = policy.runningJobs === 'cancel' ? await this.repo.findHeldJobIds(policy) : [];
    const cancel = await this.jobs.cancelForBudget([...queued, ...held], { id: policy.id, responsibleUserId: policy.updatedById }, now);
    await this.record('budget.hard_stop', policy, { spentUsd: spent, cancelledJobIds: cancel.cancelled, cancelRequestedJobIds: cancel.requested, approvalId: opened.approval?.id ?? null });
    if (inserted && policy.projectId) await this.webhooks.dispatch(policy.projectId, 'fleet.budget.hard_stop', budgetWebhookPayload(policy, spent, start));
    return { live: cancel.live, approvalLive: opened.live, wake: cancel.wake };
  }
```

Update `budget-evaluator.spec.ts`: the constructor call gains two `{} as never` arguments (nine in total).

- [ ] **Step 5: Close on manual resume and delete (service)**

In `budgets.service.ts`: inject `ApprovalCloser` and `ApprovalLivePublisher` as the last two constructor parameters.
Import `type { ApprovalActor }` from `../approvals/approval-closer`. Replace `remove` and `resume`:

```ts
  /** Deleting a paused policy lifts its pause (the row is gone) and closes its pending approval (S1.5 §1.4). */
  async remove(actorId: string, route: BudgetRoute, id: string): Promise<void> {
    const live = await this.txManager.run(async () => {
      const policy = await this.lockOwned(route, id);
      const closed = await this.approvals.closeForPolicy(id, { status: 'cancelled', resolvedBy: 'policy_deleted', actor: userActor(actorId) }, new Date());
      await this.repo.delete(id);
      await this.record(actorId, 'budget.deleted', policy, { wasPaused: policy.pausedAt !== null });
      return closed.live;
    });
    this.approvalLive.publish(live);
  }

  /**
   * S1b §2.4, B1: optionally raise the amount, clear the pause, record a `resumed` incident.
   * S1.5: with `opts.approvalId` (a raise_budget_and_resume decision) the incident carries that id and nothing is
   * closed here; without it (the budgets page) the pending approval is closed as manual_resume (plan D234).
   */
  async resume(
    actorId: string, route: BudgetRoute, id: string, amountUsd: number | undefined, now = new Date(), opts: { approvalId?: string } = {},
  ): Promise<BudgetPolicyDto> {
    const { resumed, live } = await this.txManager.run(async () => {
      const policy = await this.lockOwned(route, id);
      if (!policy.pausedAt) throw new ConflictAppException({}, 'fleet.budgetNotPaused'); // plan D164
      const spent = await this.repo.windowSpend(policy, spendSince(policy.windowKind, now));
      const amount = amountUsd === undefined ? policy.amountUsd : String(amountUsd);
      if (!isAboveSpend(amount, spent)) throw new ValidationAppException({ amountUsd: amount, spentUsd: spent }, 'fleet.budgetAmountNotAboveSpend');
      const after = await this.repo.update(id, { amountUsd: amount, pausedAt: null, pausedWindowStart: null, updatedById: actorId });
      const closed = opts.approvalId
        ? { approval: null, live: [] }
        : await this.approvals.closeForPolicy(id, {
          status: 'approved', resolvedBy: 'manual_resume', decision: 'raise_budget_and_resume', actor: userActor(actorId),
          outcome: { resumedAmountUsd: amount, requeueResults: [] },
        }, now);
      const approvalId = opts.approvalId ?? closed.approval?.id ?? null;
      await this.repo.insertIncident({ policyId: id, kind: 'resumed', windowStart: windowStart(policy.windowKind, now), spentUsd: spent, amountUsd: amount, actorId, approvalId });
      await this.record(actorId, 'budget.resumed', after, { spentUsd: spent, previousAmountUsd: policy.amountUsd, approvalId });
      return { resumed: after, live: closed.live };
    });
    this.approvalLive.publish(live);
    return this.toDto(resumed, now);
  }
```

and add below the `owns` helper:

```ts
const userActor = (id: string): ApprovalActor => ({ type: 'USER', id, responsibleUserId: id });
```

`resumedAmountUsd` must be the normalised amount string: when the caller passed `20`, `amount` is `'20'`; the
`BudgetPolicyRecord.amountUsd` read back is `'20'` as well. Keep `amount` as written.

- [ ] **Step 6: Close on rollover and orphan delete (sweeper)**

In `budget-sweeper.ts`: inject `ApprovalCloser` and `ApprovalLivePublisher` after `fleetConfig` (keep
`fleetConfig` fifth so the existing spec's argument order stays). Change `deleteOrphan` and `resetWindow`:

```ts
  /** S1b §2.1: a policy whose scope row is gone is deleted with its incidents; S1.5 closes its pending approval. */
  private async deleteOrphan(id: string): Promise<boolean> {
    const { deleted, live } = await this.txManager.run(async () => {
      const policy = await this.repo.lockById(id);
      if (!policy || (await this.repo.scopeExists(policy))) return { deleted: false, live: [] };
      const closed = await this.approvals.closeForPolicy(id, { status: 'cancelled', resolvedBy: 'policy_deleted', actor: this.system(policy) }, new Date());
      await this.repo.delete(id);
      await this.record('budget.deleted', policy, { reason: 'scope_gone' });
      return { deleted: true, live: closed.live };
    });
    this.approvalLive.publish(live);
    return deleted;
  }

  /** B8: clear a monthly pause from an earlier window and record the rollover; S1.5 closes its pending approval. */
  private async resetWindow(id: string, now: Date): Promise<boolean> {
    const { reset, live } = await this.txManager.run(async () => {
      const policy = await this.repo.lockById(id);
      if (!policy || !isStaleMonthlyPause(policy, now)) return { reset: false, live: [] };
      const start = windowStart(policy.windowKind, now);
      const spent = await this.repo.windowSpend(policy, start);
      const closed = await this.approvals.closeForPolicy(id, { status: 'cancelled', resolvedBy: 'window_reset', actor: this.system(policy) }, now);
      await this.repo.update(id, { pausedAt: null, pausedWindowStart: null });
      await this.repo.insertIncident({ policyId: id, kind: 'window_reset', windowStart: start, spentUsd: spent, amountUsd: policy.amountUsd, actorId: null, approvalId: closed.approval?.id ?? null });
      await this.record('budget.window_reset', policy, { spentUsd: spent, windowStart: start.toISOString() });
      return { reset: true, live: closed.live };
    });
    this.approvalLive.publish(live);
    return reset;
  }

  private system(policy: BudgetPolicyRecord): ApprovalActor {
    return { type: 'SYSTEM', id: SYSTEM_ACTOR.id, responsibleUserId: policy.updatedById };
  }
```

(`live: []` literals need the type: declare `const none: LiveFleetApprovalEvent[] = [];` at the top of each callback
or annotate the return type of the `txManager.run` callback.) Update `budget-sweeper.spec.ts`: both constructor calls
gain two `{} as never` arguments after the config object.

- [ ] **Step 7: Module wiring**

`budgets.module.ts`: add `ApprovalStoreModule` to `imports` and `BudgetsService` to `exports`:

```ts
  imports: [PrismaModule, ProjectAccessModule, BudgetStoreModule, ApprovalStoreModule, FleetJobsModule, FleetActivityModule, WebhookModule],
  controllers: [FleetBudgetsController, ProjectFleetBudgetsController],
  providers: [BudgetEvaluator, BudgetSweeper, BudgetsService],
  exports: [BudgetEvaluator, BudgetsService],
```

- [ ] **Step 8: Run the tests**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts test/integration/fleet/fleet-budget-evaluator.integration.spec.ts test/integration/fleet/fleet-budget-sweeper.integration.spec.ts test/integration/fleet/fleet-budgets-api.integration.spec.ts src/fleet/budgets`
Expected: PASS (the existing budget suites stay green; the new file passes 7 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet/budgets apps/api/test/integration/fleet/fleet-approval-budget-wiring.integration.spec.ts
git commit -m "feat(fleet): S1.5 1a budget hard stop opens an approval; resume, rollover and delete close it"
```

---

### Task 5: `ApprovalsService` and DTOs

**Files:**
- Create: `apps/api/src/fleet/approvals/dto/fleet-approval.dto.ts`
- Create: `apps/api/src/fleet/approvals/dto/decide-approval.dto.ts`
- Create: `apps/api/src/fleet/approvals/dto/list-approvals.query.ts`
- Create: `apps/api/src/fleet/approvals/dto/approval-counts.dto.ts`
- Create: `apps/api/src/fleet/approvals/approvals.service.ts`
- Test: `apps/api/src/fleet/approvals/approvals.service.spec.ts`

**Interfaces:**
- Consumes: `IApprovalRepository` (Task 2), `ApprovalCloser.recordResolved`, `ApprovalLivePublisher` (Task 3),
  `BudgetsService.resume(..., opts)` (Task 4), `IBudgetRepository.lockById` (`BUDGET_REPOSITORY`),
  `FleetJobsService.requeue(actorId, projectId, jobId)`, `FleetActivityService.memberProjectIds(userId)`.
- Produces:

```ts
export type ApprovalRoute = { kind: 'admin' } | { kind: 'project'; projectId: string; role: string };
export interface ApprovalCaller { id: string; globalAdmin: boolean }
export class ApprovalsService {
  list(route: ApprovalRoute, q: { status?; type?; jobId? }, page: IPageOption): Promise<IPageResult<FleetApprovalDto>>;
  get(route: ApprovalRoute, id: string): Promise<FleetApprovalDto>;
  decide(caller: ApprovalCaller, route: ApprovalRoute, id: string, dto: DecideApprovalDto, now?: Date): Promise<FleetApprovalDto>;
  counts(caller: ApprovalCaller): Promise<ApprovalCountsDto>;
}
```

- [ ] **Step 1: Write the DTOs**

`dto/decide-approval.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { MAX_BUDGET_USD, whenProvided } from '../../budgets/dto/create-budget-policy.dto';
import { APPROVAL_DECISIONS, ApprovalDecision, MAX_REQUEUE_CANDIDATES } from '../domain/approval.domain';

export class DecideApprovalDto {
  @ApiProperty({ enum: APPROVAL_DECISIONS }) @IsIn(APPROVAL_DECISIONS)
  declare decision: ApprovalDecision;

  @ApiPropertyOptional({ description: 'raise_budget_and_resume: the new amount, above the window spend' })
  @ValidateIf(whenProvided) @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false }) @Min(0.0001) @Max(MAX_BUDGET_USD)
  amountUsd?: number;

  @ApiPropertyOptional({ type: [String], description: 'raise_budget_and_resume: candidate job ids to re-queue; omitted = none (plan D231)' })
  @ValidateIf(whenProvided) @IsArray() @ArrayMaxSize(MAX_REQUEUE_CANDIDATES) @IsString({ each: true }) @MaxLength(64, { each: true })
  requeueJobIds?: string[];

  @ApiPropertyOptional({ maxLength: 1000 }) @ValidateIf(whenProvided) @IsString() @MaxLength(1000)
  comment?: string;
}
```

`dto/list-approvals.query.ts`:

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';
import { APPROVAL_STATUSES, APPROVAL_TYPES, ApprovalStatus, ApprovalType } from '../domain/approval.domain';

export class ListApprovalsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: APPROVAL_STATUSES }) @IsOptional() @IsIn(APPROVAL_STATUSES) status?: ApprovalStatus;
  @ApiPropertyOptional({ enum: APPROVAL_TYPES }) @IsOptional() @IsIn(APPROVAL_TYPES) type?: ApprovalType;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) jobId?: string;
}
```

`dto/fleet-approval.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  APPROVAL_DECISIONS, APPROVAL_RESOLVED_BY, APPROVAL_STATUSES, APPROVAL_TYPES, ApprovalDecision, ApprovalResolvedBy, ApprovalStatus,
  ApprovalType, FleetApprovalRecord, RequeueCandidate,
} from '../domain/approval.domain';

export class RequeueCandidateDto {
  @ApiProperty() declare jobId: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty() declare feature: string;
  @ApiProperty() declare queuedAt: string;

  static from(c: RequeueCandidate): RequeueCandidateDto {
    return Object.assign(new RequeueCandidateDto(), { jobId: c.jobId, projectId: c.projectId, feature: c.feature, queuedAt: c.queuedAt.toISOString() });
  }
}

/** S1.5 §1.1 approval row; `payload` and `outcome` are per-type objects (plan D237). */
export class FleetApprovalDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: APPROVAL_TYPES }) declare type: ApprovalType;
  @ApiProperty({ enum: APPROVAL_STATUSES }) declare status: ApprovalStatus;
  @ApiPropertyOptional({ type: String, nullable: true }) declare projectId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare jobId: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare policyId: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) declare payload: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) declare outcome: Record<string, unknown> | null;
  @ApiProperty() declare requestedAt: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare expiresAt: string | null;
  @ApiPropertyOptional({ enum: APPROVAL_DECISIONS, nullable: true }) declare decision: ApprovalDecision | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare decidedById: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare decidedAt: string | null;
  @ApiPropertyOptional({ enum: APPROVAL_RESOLVED_BY, nullable: true }) declare resolvedBy: ApprovalResolvedBy | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare comment: string | null;
  @ApiPropertyOptional({ type: [RequeueCandidateDto], description: 'Pending budget approvals on get only (spec §1.5)' })
  requeueCandidates?: RequeueCandidateDto[];
  @ApiPropertyOptional({ description: 'More than 200 candidates exist' }) requeueCandidatesTruncated?: boolean;

  static from(a: FleetApprovalRecord, candidates?: { rows: RequeueCandidate[]; truncated: boolean }): FleetApprovalDto {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return Object.assign(new FleetApprovalDto(), {
      id: a.id, type: a.type, status: a.status, projectId: a.projectId, jobId: a.jobId, policyId: a.policyId, payload: a.payload,
      outcome: a.outcome, requestedAt: a.requestedAt.toISOString(), expiresAt: iso(a.expiresAt), decision: a.decision,
      decidedById: a.decidedById, decidedAt: iso(a.decidedAt), resolvedBy: a.resolvedBy, comment: a.comment,
      ...(candidates ? { requeueCandidates: candidates.rows.map(RequeueCandidateDto.from), requeueCandidatesTruncated: candidates.truncated } : {}),
    });
  }
}
```

`dto/approval-counts.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';

export class ProjectApprovalCountDto {
  @ApiProperty() declare projectId: string;
  @ApiProperty() declare slug: string;
  @ApiProperty() declare pending: number;
}

/** Plan D235: pending approvals over the caller's memberships; `unscoped` only for a global ADMIN. */
export class ApprovalCountsDto {
  @ApiProperty() declare total: number;
  @ApiProperty() declare unscoped: number;
  @ApiProperty({ type: [ProjectApprovalCountDto] }) declare projects: ProjectApprovalCountDto[];
}
```

- [ ] **Step 2: Write the failing service test**

`apps/api/src/fleet/approvals/approvals.service.spec.ts` (fakes; the PG behaviour is Task 6):

```ts
import { ApprovalsService } from './approvals.service';
import type { FleetApprovalRecord } from './domain/approval.domain';

const NOW = new Date('2026-10-02T10:00:00.000Z');
const pendingBudget = (over: Partial<FleetApprovalRecord> = {}): FleetApprovalRecord => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, leaseEpoch: null, naxAskId: null,
  policyId: 'pol', payload: {}, outcome: null, requestedAt: NOW, expiresAt: null, decision: null, decidedById: null, decidedAt: null,
  resolvedBy: null, comment: null, createdAt: NOW, updatedAt: NOW, ...over,
});

function build(approval: FleetApprovalRecord | null, policyScope: 'project' | 'global' = 'project') {
  let row = approval;
  const repo = {
    findById: jest.fn(async () => row),
    lockById: jest.fn(async () => row),
    resolve: jest.fn(async (_id: string, x: Partial<FleetApprovalRecord>) => (row = { ...(row as FleetApprovalRecord), ...x })),
    setOutcome: jest.fn(async (_id: string, outcome: Record<string, unknown>) => (row = { ...(row as FleetApprovalRecord), outcome })),
    findRequeueCandidates: jest.fn(async () => [
      { jobId: 'j1', projectId: 'p1', feature: 'f1', queuedAt: NOW },
      { jobId: 'j2', projectId: 'p2', feature: 'f2', queuedAt: NOW },
    ]),
    countPending: jest.fn(async () => [{ projectId: 'p1', slug: 'web', pending: 2 }]),
    countPendingUnscoped: jest.fn(async () => 3),
  };
  const policy = policyScope === 'project'
    ? { id: 'pol', scopeType: 'project', projectId: 'p1' }
    : { id: 'pol', scopeType: 'global', projectId: null };
  const budgetRepo = { lockById: jest.fn(async () => policy) };
  const budgets = { resume: jest.fn(async () => ({})) };
  const jobs = { requeue: jest.fn(async (_a: string, _p: string, id: string) => { if (id === 'j2') throw new Error('fleet.jobs'); return {}; }) };
  const closer = { recordResolved: jest.fn(async () => []) };
  const live = { publish: jest.fn() };
  const activity = { memberProjectIds: jest.fn(async () => ['p1']) };
  const tx = { run: jest.fn(async (fn: () => Promise<unknown>) => fn()) };
  const service = new ApprovalsService(repo as never, budgetRepo as never, budgets as never, jobs as never, closer as never, live as never, activity as never, tx as never);
  return { service, repo, budgets, jobs, budgetRepo };
}

/** AppException carries its HTTP status in the `httpStatus` getter; 0 = resolved. */
const statusOf = (p: Promise<unknown>): Promise<number> => p.then(() => 0, (e: { httpStatus?: number }) => e.httpStatus ?? -1);
const ADMIN_CALLER = { id: 'root', globalAdmin: true };
const PROJECT_ADMIN = { kind: 'project' as const, projectId: 'p1', role: 'ADMIN' };
const PROJECT_DEV = { kind: 'project' as const, projectId: 'p1', role: 'DEVELOPER' };

describe('ApprovalsService.decide (budget)', () => {
  it('keep_paused rejects the approval without resuming', async () => {
    const { service, budgets } = build(pendingBudget());
    const dto = await service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused', comment: 'later' }, NOW);
    expect(dto).toEqual(expect.objectContaining({ status: 'rejected', decision: 'keep_paused', resolvedBy: 'user', decidedById: 'root', comment: 'later' }));
    expect(budgets.resume).not.toHaveBeenCalled();
  });

  it('raise_budget_and_resume resumes on the policy route (D229), then re-queues and keeps failures (A9, D233)', async () => {
    const { service, budgets, jobs } = build(pendingBudget({ projectId: null }), 'global');
    const dto = await service.decide(ADMIN_CALLER, { kind: 'admin' }, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20, requeueJobIds: ['j1', 'j2'] }, NOW);
    expect(budgets.resume).toHaveBeenCalledWith('root', { kind: 'admin' }, 'pol', 20, NOW, { approvalId: 'a1' });
    expect(jobs.requeue.mock.calls).toEqual([['root', 'p1', 'j1'], ['root', 'p2', 'j2']]);
    expect(dto.status).toBe('approved');
    expect(dto.outcome).toEqual({ resumedAmountUsd: '20', requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: 'fleet.jobs' }] });
  });

  it('a project policy decided on the admin prefix resumes on the project route (review focus 5)', async () => {
    const { service, budgets } = build(pendingBudget());
    await service.decide(ADMIN_CALLER, { kind: 'admin' }, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20 }, NOW);
    expect(budgets.resume).toHaveBeenCalledWith('root', { kind: 'project', projectId: 'p1' }, 'pol', 20, NOW, { approvalId: 'a1' });
  });

  it('refuses: amount missing, foreign re-queue id, project developer, not pending, other project, bash type', async () => {
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'raise_budget_and_resume' }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'raise_budget_and_resume', amountUsd: 20, requeueJobIds: ['zzz'] }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide({ id: 'dev', globalAdmin: false }, PROJECT_DEV, 'a1', { decision: 'keep_paused' }, NOW))).toBe(403);
    expect(await statusOf(build(pendingBudget({ status: 'approved' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW))).toBe(409);
    expect(await statusOf(build(pendingBudget({ projectId: 'p9' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW))).toBe(404);
    expect(await statusOf(build(pendingBudget({ type: 'nax_bash_escalate' })).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'deny' }, NOW))).toBe(400);
    expect(await statusOf(build(pendingBudget()).service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'allow' }, NOW))).toBe(400);
  });

  it('locks the policy before the approval (lock order, spec §1.4)', async () => {
    const { service, repo, budgetRepo } = build(pendingBudget());
    await service.decide(ADMIN_CALLER, PROJECT_ADMIN, 'a1', { decision: 'keep_paused' }, NOW);
    expect(budgetRepo.lockById.mock.invocationCallOrder[0]).toBeLessThan(repo.lockById.mock.invocationCallOrder[0]);
  });
});

describe('ApprovalsService.counts', () => {
  it('sums member projects, plus unscoped for a global admin only (D235)', async () => {
    expect(await build(null).service.counts({ id: 'root', globalAdmin: true })).toEqual({ total: 5, unscoped: 3, projects: [{ projectId: 'p1', slug: 'web', pending: 2 }] });
    expect(await build(null).service.counts({ id: 'dev', globalAdmin: false })).toEqual({ total: 2, unscoped: 0, projects: [{ projectId: 'p1', slug: 'web', pending: 2 }] });
  });
});
```

`AppException` (`@nathapp/nestjs-common`) exposes its HTTP status through the `httpStatus` getter; `statusOf` reads it.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals/approvals.service.spec.ts`
Expected: FAIL, `Cannot find module './approvals.service'`.

- [ ] **Step 4: Write the service**

`apps/api/src/fleet/approvals/approvals.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { IPageResult, ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { BudgetRoute, BudgetsService } from '../budgets/budgets.service';
import { BUDGET_REPOSITORY, BudgetPolicyRecord, IBudgetRepository } from '../budgets/domain/budget.domain';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { ApprovalCloser } from './approval-closer';
import { ApprovalLivePublisher } from './approval-live.publisher';
import {
  APPROVAL_REPOSITORY, ApprovalStatus, ApprovalType, FleetApprovalRecord, IApprovalRepository, MAX_REQUEUE_CANDIDATES, RequeueCandidate,
} from './domain/approval.domain';
import { ApprovalCountsDto } from './dto/approval-counts.dto';
import type { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';

/** Which prefix a request came through (plan D230); `role` is the caller's project role. */
export type ApprovalRoute = { kind: 'admin' } | { kind: 'project'; projectId: string; role: string };
export interface ApprovalCaller { id: string; globalAdmin: boolean }

interface RequeueResult { jobId: string; ok: boolean; error?: string }

function invalid(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.approvalDecisionInvalid');
}

const visible = (route: ApprovalRoute, a: FleetApprovalRecord): boolean => route.kind === 'admin' || a.projectId === route.projectId;

/** Plan D229: the budgets service's ownership route follows the policy's scope, not the request prefix. */
const budgetRouteOf = (p: BudgetPolicyRecord): BudgetRoute =>
  p.scopeType === 'project' || p.scopeType === 'repo' ? { kind: 'project', projectId: p.projectId as string } : { kind: 'admin' };

/** Spec §1.7: budget asks are decided by whoever may resume the policy (S1b B3). */
const mayDecideBudget = (route: ApprovalRoute): boolean => route.kind === 'admin' || route.role === 'ADMIN';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** S1.5 §2.3: list, get, decide and count approvals. Budget decides lock the policy before the approval (§1.4). */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(APPROVAL_REPOSITORY) private readonly repo: IApprovalRepository,
    @Inject(BUDGET_REPOSITORY) private readonly budgetRepo: IBudgetRepository,
    private readonly budgets: BudgetsService,
    private readonly jobs: FleetJobsService,
    private readonly closer: ApprovalCloser,
    private readonly live: ApprovalLivePublisher,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async list(route: ApprovalRoute, q: { status?: ApprovalStatus; type?: ApprovalType; jobId?: string }, page: IPageOption): Promise<IPageResult<FleetApprovalDto>> {
    const projectId = route.kind === 'project' ? route.projectId : undefined;
    return remapPage(await this.repo.findPage({ ...q, ...(projectId !== undefined ? { projectId } : {}) }, page), (a) => FleetApprovalDto.from(a));
  }

  async get(route: ApprovalRoute, id: string): Promise<FleetApprovalDto> {
    const approval = await this.findVisible(route, id);
    if (approval.type !== 'budget_override_required' || approval.status !== 'pending' || !approval.policyId) return FleetApprovalDto.from(approval);
    return FleetApprovalDto.from(approval, await this.candidates(approval.policyId, approval.requestedAt));
  }

  async decide(caller: ApprovalCaller, route: ApprovalRoute, id: string, dto: DecideApprovalDto, now = new Date()): Promise<FleetApprovalDto> {
    const current = await this.findVisible(route, id);
    if (current.type !== 'budget_override_required' || !current.policyId) invalid('bash approvals are not decidable yet'); // plan D236
    if (dto.decision !== 'keep_paused' && dto.decision !== 'raise_budget_and_resume') invalid(`${dto.decision} does not apply to a budget approval`);
    if (!mayDecideBudget(route)) throw new ForbiddenAppException({}, 'projects');
    const policyId = current.policyId as string;

    const t1 = await this.txManager.run(async () => {
      const policy = await this.budgetRepo.lockById(policyId); // lock order: policy first (spec §1.4)
      const approval = await this.repo.lockById(id);
      if (!approval || approval.status !== 'pending') throw new ConflictAppException({}, 'fleet.approvalNotPending');
      if (dto.decision === 'keep_paused') {
        const decided = await this.repo.resolve(id, { status: 'rejected', resolvedBy: 'user', decidedAt: now, decision: 'keep_paused', decidedById: caller.id, comment: dto.comment ?? null });
        return { approval: decided, live: await this.closer.recordResolved(decided, user(caller.id)), requeue: [] as RequeueCandidate[] };
      }
      if (dto.amountUsd === undefined) invalid('amountUsd is required to raise and resume');
      if (!policy) throw new ConflictAppException({}, 'fleet.approvalNotPending');
      const candidates = await this.repo.findRequeueCandidates(policyId, approval.requestedAt, MAX_REQUEUE_CANDIDATES);
      const byId = new Map(candidates.map((c) => [c.jobId, c]));
      const selected = (dto.requeueJobIds ?? []).map((jobId) => byId.get(jobId) ?? invalid(`job ${jobId} is not a re-queue candidate`));
      const resumed = await this.budgets.resume(caller.id, budgetRouteOf(policy), policyId, dto.amountUsd, now, { approvalId: id });
      const decided = await this.repo.resolve(id, {
        status: 'approved', resolvedBy: 'user', decidedAt: now, decision: 'raise_budget_and_resume', decidedById: caller.id,
        comment: dto.comment ?? null, outcome: { resumedAmountUsd: resumed.amountUsd ?? String(dto.amountUsd), requeueResults: [] },
      });
      return { approval: decided, live: await this.closer.recordResolved(decided, user(caller.id)), requeue: selected };
    });
    this.live.publish(t1.live);
    if (t1.approval.decision !== 'raise_budget_and_resume') return FleetApprovalDto.from(t1.approval);

    const results: RequeueResult[] = [];
    for (const c of t1.requeue) {
      try {
        await this.jobs.requeue(caller.id, c.projectId, c.jobId); // plan D232: its own transaction
        results.push({ jobId: c.jobId, ok: true });
      } catch (error) {
        results.push({ jobId: c.jobId, ok: false, error: errorText(error) }); // A9, plan D233
      }
    }
    const final = await this.repo.setOutcome(id, { ...(t1.approval.outcome ?? {}), requeueResults: results });
    return FleetApprovalDto.from(final);
  }

  async counts(caller: ApprovalCaller): Promise<ApprovalCountsDto> {
    const projects = await this.repo.countPending(await this.activity.memberProjectIds(caller.id));
    const unscoped = caller.globalAdmin ? await this.repo.countPendingUnscoped() : 0;
    return Object.assign(new ApprovalCountsDto(), {
      total: projects.reduce((sum, p) => sum + p.pending, unscoped), unscoped, projects,
    });
  }

  private async findVisible(route: ApprovalRoute, id: string): Promise<FleetApprovalRecord> {
    const approval = await this.repo.findById(id);
    if (!approval || !visible(route, approval)) throw new NotFoundAppException({}, 'fleet.approvals');
    return approval;
  }

  private async candidates(policyId: string, since: Date): Promise<{ rows: RequeueCandidate[]; truncated: boolean }> {
    const rows = await this.repo.findRequeueCandidates(policyId, since, MAX_REQUEUE_CANDIDATES + 1);
    return { rows: rows.slice(0, MAX_REQUEUE_CANDIDATES), truncated: rows.length > MAX_REQUEUE_CANDIDATES };
  }
}

const user = (id: string) => ({ type: 'USER' as const, id, responsibleUserId: id });
```

Notes for the implementer:
- `BudgetsService.resume` returns a `BudgetPolicyDto`; its `amountUsd` is the stored decimal string, so
  `resumedAmountUsd` is `'20'` for `20`. The fake in the spec returns `{}`, hence the `?? String(dto.amountUsd)`.
- A `memberProjectIds` call for a global ADMIN returns only the projects they belong to (D235 keeps that).

- [ ] **Step 5: Run it to verify it passes**

Run: `cd apps/api && bun run test:scoped src/fleet/approvals/approvals.service.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/fleet/approvals/dto apps/api/src/fleet/approvals/approvals.service.ts apps/api/src/fleet/approvals/approvals.service.spec.ts
git commit -m "feat(fleet): S1.5 1a approvals service: list, get, decide budget overrides, counts"
```

---

### Task 6: Controllers, module, i18n, OpenAPI and the HTTP suite

**Files:**
- Create: `apps/api/src/fleet/approvals/project-fleet-approvals.controller.ts`
- Create: `apps/api/src/fleet/approvals/fleet-approvals.controller.ts`
- Create: `apps/api/src/fleet/approvals/fleet-approval-counts.controller.ts`
- Create: `apps/api/src/fleet/approvals/approvals.module.ts`, `apps/api/src/fleet/approvals/approvals.module.spec.ts`
- Modify: `apps/api/src/fleet/fleet.module.ts` (replace `ApprovalStoreModule` with `ApprovalsModule`)
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`
- Modify: `apps/api/src/fleet/fleet-openapi.contract.spec.ts`, `openapi.json` (regenerated)
- Test: `apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts`

**Interfaces:**
- Consumes: `ApprovalsService` (Task 5).
- Produces: routes `GET/GET :id/POST :id/decide` under `/api/projects/{slug}/fleet/approvals` and
  `/api/fleet/approvals`, plus `GET /api/fleet/approval-counts`. Generated client names (Task 7):
  `projectFleetApprovalsControllerList|Get|Decide`, `fleetApprovalsControllerList|Get|Decide`,
  `fleetApprovalCountsControllerGet`.

- [ ] **Step 1: Write the failing HTTP suite**

```ts
/**
 * Fleet S1.5 slice 1a — approvals over HTTP: both prefixes, permissions, decide, re-queue, counts, webhooks (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(30_000);

interface Approval { id: string; status: string; decision: string | null; resolvedBy: string | null; outcome: { requeueResults?: Array<{ jobId: string; ok: boolean; error?: string }> } | null; requeueCandidates?: Array<{ jobId: string }>; requeueCandidatesTruncated?: boolean }
interface Page<T> { total: number; records: T[] }

describeIntegration('fleet approvals API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let evaluator: BudgetEvaluator;
  let padmin: string;
  let n = 0;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tok = (who: keyof FleetHttpWorld['tokens']) => as(world.tokens[who]);
  const PROJECT = '/api/projects/web/fleet/approvals';
  const ADMIN = '/api/fleet/approvals';

  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `ap${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', firstStartedAt: new Date(), ...over,
    },
  });
  /** A paused project policy with its pending approval, one queued job the stop cancels, and the approval id. */
  const stopped = async (scope: 'project' | 'global' = 'project') => {
    const policy = await prisma.budgetPolicy.create({
      data: scope === 'project'
        ? { scopeType: 'project', scopeId: world.projectId, scopeKey: `project:${world.projectId}`, projectId: world.projectId, windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root }
        : { scopeType: 'global', scopeKey: 'global', windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: world.ids.root, updatedById: world.ids.root },
    });
    await job({ costSpentUsd: 10 });
    const queued = await job({ state: 'QUEUED', firstStartedAt: null });
    await evaluator.evaluate(policy.id);
    const approval = await prisma.fleetApproval.findFirstOrThrow({ where: { policyId: policy.id, status: 'pending' } });
    return { policy, queued, approvalId: approval.id };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    evaluator = app.get(BudgetEvaluator);
    await request(server).post('/api/admin/users').set(tok('root')).send({ email: 'padmin@koda.test', name: 'padmin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(tok('root')).send({ email: 'padmin@koda.test', role: 'ADMIN' }).expect(201);
    padmin = await loginToken(server, 'padmin@koda.test');
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.approval.requested', 'fleet.approval.resolved']) },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
  });

  it('members list and get; outsiders get 403; candidates on a pending budget approval', async () => {
    const { approvalId, queued } = await stopped();
    const page = data<Page<Approval>>(await request(server).get(PROJECT).set(tok('viewer')).expect(200));
    expect(page.records.map((a) => a.id)).toEqual([approvalId]);
    const one = data<Approval>(await request(server).get(`${PROJECT}/${approvalId}`).set(tok('viewer')).expect(200));
    expect(one.requeueCandidates?.map((c) => c.jobId)).toEqual([queued.id]);
    expect(one.requeueCandidatesTruncated).toBe(false);
    await request(server).get(PROJECT).set(tok('outsider')).expect(403);
    await request(server).get(`/api/projects/ops/fleet/approvals/${approvalId}`).set(tok('root')).expect(404);
  });

  it('a global policy approval is on the admin routes only', async () => {
    const { approvalId } = await stopped('global');
    expect(data<Page<Approval>>(await request(server).get(PROJECT).set(tok('root')).expect(200)).total).toBe(0);
    expect(data<Page<Approval>>(await request(server).get(ADMIN).set(tok('root')).expect(200)).records.map((a) => a.id)).toEqual([approvalId]);
    await request(server).get(ADMIN).set(tok('dev')).expect(403);
  });

  it('a developer cannot decide a budget override; a project admin can keep it paused', async () => {
    const { approvalId, policy } = await stopped();
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(tok('dev')).send({ decision: 'keep_paused' }).expect(403);
    const decided = data<Approval>(await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(200));
    expect(decided).toEqual(expect.objectContaining({ status: 'rejected', decision: 'keep_paused', resolvedBy: 'user' }));
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).not.toBeNull();
    const again = await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(409);
    expect(again.body.message).toBeDefined();
  });

  it('raise and resume lifts the pause and re-queues the selected candidates, including a placement-cancelled job', async () => {
    const { approvalId, policy, queued } = await stopped();
    const later = await job({ state: 'CANCELLED', firstStartedAt: null, startedAt: null, cancelReason: `budget:${policy.id}`, stateReason: `budget:${policy.id}`, finishedAt: new Date(Date.now() + 1_000) });
    const decided = data<Approval>(await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin))
      .send({ decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: [queued.id, later.id] }).expect(200));
    expect(decided).toEqual(expect.objectContaining({ status: 'approved', decision: 'raise_budget_and_resume' }));
    expect(decided.outcome?.requeueResults).toEqual([{ jobId: queued.id, ok: true }, { jobId: later.id, ok: true }]);
    const after = await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(after).toEqual(expect.objectContaining({ pausedAt: null, amountUsd: new Prisma.Decimal(25) }));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe('QUEUED');
    expect((await prisma.budgetIncident.findFirstOrThrow({ where: { policyId: policy.id, kind: 'resumed' } })).approvalId).toBe(approvalId);
    expect(await prisma.outboxEvent.count({ where: { payload: { contains: '"event":"fleet.approval.resolved"' } } })).toBe(1);
  });

  it('partial re-queue: an active duplicate fails alone, the resume stands (review focus 2)', async () => {
    const { approvalId, queued } = await stopped();
    await job({ state: 'QUEUED', firstStartedAt: null, feature: queued.feature });
    const decided = data<Approval>(await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin))
      .send({ decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: [queued.id] }).expect(200));
    expect(decided.status).toBe('approved');
    expect(decided.outcome?.requeueResults).toEqual([{ jobId: queued.id, ok: false, error: expect.any(String) }]);
  });

  it('refuses a missing amount, an amount not above spend, and a non-candidate id', async () => {
    const { approvalId } = await stopped();
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume' }).expect(400);
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume', amountUsd: 5 }).expect(400);
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: ['nope'] }).expect(400);
    expect((await prisma.fleetApproval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('pending');
  });

  it('admin prefix on a project policy resumes it (review focus 5)', async () => {
    const { approvalId, policy } = await stopped();
    await request(server).post(`${ADMIN}/${approvalId}/decide`).set(tok('root')).send({ decision: 'raise_budget_and_resume', amountUsd: 30 }).expect(200);
    expect((await prisma.budgetPolicy.findUniqueOrThrow({ where: { id: policy.id } })).pausedAt).toBeNull();
  });

  it('decide after the policy was deleted is 409 (review focus 3)', async () => {
    const { approvalId, policy } = await stopped();
    await request(server).delete(`/api/projects/web/fleet/budgets/${policy.id}`).set(as(padmin)).expect(204);
    await request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'keep_paused' }).expect(409);
  });

  it('concurrent evaluate and decide: no deadlock (review focus 1)', async () => {
    const { approvalId, policy } = await stopped();
    const [res] = await Promise.all([
      request(server).post(`${PROJECT}/${approvalId}/decide`).set(as(padmin)).send({ decision: 'raise_budget_and_resume', amountUsd: 40 }),
      evaluator.evaluate(policy.id),
      evaluator.evaluate(policy.id),
    ]);
    expect([200, 409]).toContain(res.status);
    expect(await prisma.fleetApproval.count({ where: { policyId: policy.id, status: 'pending' } })).toBeLessThanOrEqual(1);
  });

  it('counts pending over memberships; unscoped for a global admin only', async () => {
    await stopped();
    await stopped('global');
    const forDev = data<{ total: number; unscoped: number; projects: Array<{ slug: string; pending: number }> }>(
      await request(server).get('/api/fleet/approval-counts').set(tok('dev')).expect(200));
    expect(forDev).toEqual({ total: 1, unscoped: 0, projects: [expect.objectContaining({ slug: 'web', pending: 1 })] });
    const forRoot = data<{ total: number; unscoped: number }>(await request(server).get('/api/fleet/approval-counts').set(tok('root')).expect(200));
    expect(forRoot.unscoped).toBe(1);
    expect(data<{ total: number }>(await request(server).get('/api/fleet/approval-counts').set(tok('outsider')).expect(200)).total).toBe(0);
  });
});
```

The `stopped('global')` helper runs after a project stop in one test; the second `job({ costSpentUsd: 10 })` makes the
global spend 20 and the global policy stops too. That is intended.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-api.integration.spec.ts`
Expected: FAIL; `GET /api/projects/web/fleet/approvals` answers 404.

- [ ] **Step 3: Write the controllers**

`project-fleet-approvals.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ApprovalRoute, ApprovalsService } from './approvals.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';
import { ListApprovalsQuery } from './dto/list-approvals.query';

const route = (ctx: ProjectContext): ApprovalRoute => ({ kind: 'project', projectId: ctx.project.id, role: ctx.role });

function requireUser(principal: KodaPrincipal): void {
  if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
}

/** S1.5 §2.3 project routes: members read; decide per §1.7 (budget asks: project ADMIN). */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/fleet/approvals')
@UseGuards(ProjectMembershipGuard)
export class ProjectFleetApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @ApiOperation({ summary: "This project's approvals, newest first (project member)" })
  @ApiResponse({ status: 200, description: 'Page of FleetApprovalDto' })
  async list(@Query() raw: ListApprovalsQuery, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireUser(principal);
    const { current, size, status, type, jobId } = parseQuery(ListApprovalsQuery, raw);
    return JsonResponse.Ok(toPageResult(await this.approvals.list(route(ctx), { status, type, jobId }, { current, size })));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One approval; a pending budget override includes its re-queue candidates (project member)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  async get(@Param('id') id: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    requireUser(principal);
    return JsonResponse.Ok(await this.approvals.get(route(ctx), id));
  }

  @Post(':id/decide')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decide a pending approval (budget overrides: project ADMIN)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  @ApiResponse({ status: 400, description: 'fleet.approvalDecisionInvalid, fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 409, description: 'fleet.approvalNotPending, fleet.budgetNotPaused' })
  async decide(@Param('id') id: string, @Body() dto: DecideApprovalDto, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.approvals.decide({ id: principal.id, globalAdmin: principal.role === 'ADMIN' }, route(ctx), id, dto));
  }
}
```

`fleet-approvals.controller.ts` (global ADMIN):

```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal, RequiredPermission } from '@nathapp/nestjs-auth';
import { JsonResponse } from '@nathapp/nestjs-common';
import { parseQuery, toPageResult } from '../../common/dto/koda-page.query';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalRoute, ApprovalsService } from './approvals.service';
import { DecideApprovalDto } from './dto/decide-approval.dto';
import { FleetApprovalDto } from './dto/fleet-approval.dto';
import { ListApprovalsQuery } from './dto/list-approvals.query';

const ADMIN: ApprovalRoute = { kind: 'admin' };

/** S1.5 §2.3 global-admin routes: every approval, including those with no project. */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/approvals')
export class FleetApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Every approval, newest first (global admin)' })
  @ApiResponse({ status: 200, description: 'Page of FleetApprovalDto' })
  async list(@Query() raw: ListApprovalsQuery) {
    const { current, size, status, type, jobId } = parseQuery(ListApprovalsQuery, raw);
    return JsonResponse.Ok(toPageResult(await this.approvals.list(ADMIN, { status, type, jobId }, { current, size })));
  }

  @Get(':id')
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'One approval with re-queue candidates when pending (global admin)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  async get(@Param('id') id: string) {
    return JsonResponse.Ok(await this.approvals.get(ADMIN, id));
  }

  @Post(':id/decide')
  @HttpCode(200)
  @RequiredPermission('ADMIN')
  @ApiOperation({ summary: 'Decide a pending approval (global admin)' })
  @ApiResponse({ status: 200, type: FleetApprovalDto })
  @ApiResponse({ status: 400, description: 'fleet.approvalDecisionInvalid, fleet.budgetAmountNotAboveSpend' })
  @ApiResponse({ status: 409, description: 'fleet.approvalNotPending, fleet.budgetNotPaused' })
  async decide(@Param('id') id: string, @Body() dto: DecideApprovalDto, @Principal() principal: KodaPrincipal) {
    return JsonResponse.Ok(await this.approvals.decide({ id: principal.id, globalAdmin: true }, ADMIN, id, dto));
  }
}
```

`fleet-approval-counts.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalsService } from './approvals.service';
import { ApprovalCountsDto } from './dto/approval-counts.dto';

/** Plan D235: the web badge's count, for any signed-in user over their memberships. */
@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/approval-counts')
export class FleetApprovalCountsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @ApiOperation({ summary: 'Pending approvals per member project; no-project ones for a global admin' })
  @ApiResponse({ status: 200, type: ApprovalCountsDto })
  async get(@Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.approvals.counts({ id: principal.id, globalAdmin: principal.role === 'ADMIN' }));
  }
}
```

- [ ] **Step 4: Module, DI guard and FleetModule**

`approvals.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { ProjectAccessModule } from '../../projects/project-access.module';
import { FleetActivityModule } from '../activity/fleet-activity.module';
import { BudgetStoreModule } from '../budgets/budget-store.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FleetJobsModule } from '../jobs/fleet-jobs.module';
import { ApprovalStoreModule } from './approval-store.module';
import { ApprovalsService } from './approvals.service';
import { FleetApprovalCountsController } from './fleet-approval-counts.controller';
import { FleetApprovalsController } from './fleet-approvals.controller';
import { ProjectFleetApprovalsController } from './project-fleet-approvals.controller';

/** S1.5 C8 approvals (plan D226): decide, list, counts. Storage and the close port are ApprovalStoreModule. */
@Module({
  imports: [PrismaModule, ProjectAccessModule, ApprovalStoreModule, BudgetStoreModule, BudgetsModule, FleetJobsModule, FleetActivityModule],
  controllers: [ProjectFleetApprovalsController, FleetApprovalsController, FleetApprovalCountsController],
  providers: [ApprovalsService],
})
export class ApprovalsModule {}
```

`approvals.module.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { GlobalStubsModule } from '../../common/test-helpers/global-stubs.module';
import { ApprovalsModule } from './approvals.module';
import { ApprovalsService } from './approvals.service';

/** DI guard, as budgets.module.spec.ts: a missing provider or an import cycle fails `bun run test`. */
describe('ApprovalsModule', () => {
  it('compiles and resolves the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubsModule, ApprovalsModule] }).compile();
    try {
      expect(moduleRef.get(ApprovalsService)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
```

In `fleet.module.ts`, replace `ApprovalStoreModule` (Task 3) with `ApprovalsModule` in `imports`.

- [ ] **Step 5: i18n**

`apps/api/src/i18n/en/fleet.json`, append before the closing brace (add a comma to the previous line):

```json
  "approvals": { "404": "Approval not found" },
  "approvalNotPending": { "409": "This approval is no longer pending" },
  "approvalDecisionInvalid": { "-2": "This decision is not allowed: {reason}" },
  "approvalInput": { "-2": "Invalid approval request: {reason}" }
```

`apps/api/src/i18n/zh/fleet.json`:

```json
  "approvals": { "404": "未找到该审批" },
  "approvalNotPending": { "409": "该审批已不再处于待处理状态" },
  "approvalDecisionInvalid": { "-2": "不允许此决定：{reason}" },
  "approvalInput": { "-2": "审批请求无效：{reason}" }
```

- [ ] **Step 6: Run the HTTP suite and the DI guard**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-approvals-api.integration.spec.ts src/fleet/approvals/approvals.module.spec.ts src/fleet/budgets/budgets.module.spec.ts`
Expected: PASS (10 + 1 + 1). If the "concurrent evaluate and decide" test hangs, the lock order is wrong somewhere:
check that no path calls `repo.lockById` on an approval before `budgetRepo.lockById` on its policy.

- [ ] **Step 7: OpenAPI and contract**

Add to `apps/api/src/fleet/fleet-openapi.contract.spec.ts`:

```ts
  it('exposes the approval routes, the counts route and the approval schemas (S1.5 §2.3)', () => {
    for (const base of ['/api/fleet/approvals', '/api/projects/{slug}/fleet/approvals']) {
      expect(spec.paths[base]?.['get']).toBeDefined();
      expect(spec.paths[`${base}/{id}`]?.['get']).toBeDefined();
      expect(spec.paths[`${base}/{id}/decide`]?.['post']).toBeDefined();
    }
    expect(spec.paths['/api/fleet/approval-counts']?.['get']).toBeDefined();
    expect(Object.keys(spec.components.schemas['FleetApprovalDto']?.properties ?? {}))
      .toEqual(expect.arrayContaining(['type', 'status', 'payload', 'outcome', 'decision', 'resolvedBy', 'requeueCandidates']));
    expect(Object.keys(spec.components.schemas['DecideApprovalDto']?.properties ?? {}).sort())
      .toEqual(['amountUsd', 'comment', 'decision', 'requeueJobIds']);
    expect(Object.keys(spec.components.schemas['ApprovalCountsDto']?.properties ?? {}).sort()).toEqual(['projects', 'total', 'unscoped']);
  });
```

Run: `bun run generate` (repo root), then `cd apps/api && bun run test:scoped src/fleet/fleet-openapi.contract.spec.ts`
Expected: PASS; `git diff --stat openapi.json` shows the new paths and schemas only.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet/approvals apps/api/src/fleet/fleet.module.ts apps/api/src/i18n apps/api/src/fleet/fleet-openapi.contract.spec.ts openapi.json apps/api/test/integration/fleet/fleet-approvals-api.integration.spec.ts
git commit -m "feat(fleet): S1.5 1a approval routes (project, admin, counts), i18n, OpenAPI"
```

---

### Task 7: CLI `koda fleet approval`

**Files:**
- Create: `apps/cli/src/commands/fleet-approval.ts`
- Modify: `apps/cli/src/commands/fleet.ts` (register)
- Test: `apps/cli/src/commands/fleet-approval.spec.ts`

**Interfaces:**
- Consumes: generated `fleetApprovalsControllerList|Get|Decide`, `projectFleetApprovalsControllerList|Get|Decide`,
  types `FleetApprovalDto`, `DecideApprovalDto` (Task 6 `bun run generate`); `unwrap`, `withContext`,
  `handleApiError`, `table`, `parseBudgetUsd`, `ADMIN_TOKEN_HINT` (existing CLI utils, as `fleet-budget.ts` uses them).
- Produces: `registerFleetApproval(fleet: Command): void`; exported `parseRequeue(value: string): 'all' | string[]`.

- [ ] **Step 1: Write the failing CLI test**

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  fleetApprovalsControllerList: jest.fn(),
  fleetApprovalsControllerGet: jest.fn(),
  fleetApprovalsControllerDecide: jest.fn(),
  projectFleetApprovalsControllerList: jest.fn(),
  projectFleetApprovalsControllerGet: jest.fn(),
  projectFleetApprovalsControllerDecide: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { fleetCommand } from './fleet';
import { parseRequeue } from './fleet-approval';
import {
  fleetApprovalsControllerDecide, fleetApprovalsControllerList, projectFleetApprovalsControllerDecide, projectFleetApprovalsControllerGet,
} from '../generated';
import { resolveContext } from '../config';

const CTX = { apiKey: 'jwt', apiUrl: 'https://koda.example.com', projectSlug: 'web' };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1', type: 'budget_override_required', status: 'pending', projectId: 'p1', jobId: null, policyId: 'pol',
  payload: { spentUsd: '10', amountUsd: '10', scopeType: 'project' }, outcome: null, requestedAt: '2026-10-02T10:00:00.000Z',
  expiresAt: null, decision: null, decidedById: null, decidedAt: null, resolvedBy: null, comment: null, ...over,
});
const ok = (data: unknown) => ({ ret: 0, data });

describe('koda fleet approval', () => {
  let program: Command;
  let logSpy: jest.SpyInstance;
  const run = (...args: string[]) => program.parseAsync(['node', 'koda', 'fleet', 'approval', ...args]);

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    fleetCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue(CTX);
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.clearAllMocks());

  it('parses --requeue', () => {
    expect(parseRequeue('all')).toBe('all');
    expect(parseRequeue('j1,j2')).toEqual(['j1', 'j2']);
    expect(() => parseRequeue(',')).toThrow();
  });

  it('list uses the admin route without --project and passes filters', async () => {
    (fleetApprovalsControllerList as jest.Mock).mockResolvedValue(ok({ total: 1, current: 1, size: 20, records: [row()] }));
    await run('list', '--status', 'pending');
    expect(fleetApprovalsControllerList).toHaveBeenCalledWith({ query: { status: 'pending' } });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('a1');
  });

  it('decide keep_paused on the project route', async () => {
    (projectFleetApprovalsControllerDecide as jest.Mock).mockResolvedValue(ok(row({ status: 'rejected', decision: 'keep_paused' })));
    await run('decide', 'a1', '--project', 'web', '--decision', 'keep_paused', '--comment', 'later');
    expect(projectFleetApprovalsControllerDecide).toHaveBeenCalledWith({ path: { slug: 'web', id: 'a1' }, body: { decision: 'keep_paused', comment: 'later' } });
  });

  it('decide raise with --requeue all sends every candidate from a fresh show', async () => {
    (projectFleetApprovalsControllerGet as jest.Mock).mockResolvedValue(ok(row({ requeueCandidates: [{ jobId: 'j1' }, { jobId: 'j2' }] })));
    (projectFleetApprovalsControllerDecide as jest.Mock).mockResolvedValue(ok(row({ status: 'approved', outcome: { requeueResults: [{ jobId: 'j1', ok: true }, { jobId: 'j2', ok: false, error: 'x' }] } })));
    await run('decide', 'a1', '--project', 'web', '--decision', 'raise_budget_and_resume', '--amount', '25', '--requeue', 'all');
    expect(projectFleetApprovalsControllerDecide).toHaveBeenCalledWith({
      path: { slug: 'web', id: 'a1' }, body: { decision: 'raise_budget_and_resume', amountUsd: 25, requeueJobIds: ['j1', 'j2'] },
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('1 of 2 re-queued');
  });

  it('decide on the admin route without --project', async () => {
    (fleetApprovalsControllerDecide as jest.Mock).mockResolvedValue(ok(row({ status: 'rejected' })));
    await run('decide', 'a1', '--decision', 'keep_paused');
    expect(fleetApprovalsControllerDecide).toHaveBeenCalledWith({ path: { id: 'a1' }, body: { decision: 'keep_paused' } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/cli && bun run test -- src/commands/fleet-approval.spec.ts`
Expected: FAIL, `Cannot find module './fleet-approval'`.

- [ ] **Step 3: Write the command**

`apps/cli/src/commands/fleet-approval.ts`:

```ts
import { Command, InvalidArgumentError } from 'commander';
import {
  fleetApprovalsControllerDecide,
  fleetApprovalsControllerGet,
  fleetApprovalsControllerList,
  projectFleetApprovalsControllerDecide,
  projectFleetApprovalsControllerGet,
  projectFleetApprovalsControllerList,
  type DecideApprovalDto,
  type FleetApprovalDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { parseBudgetUsd } from '../utils/parse-usd';
import { ADMIN_TOKEN_HINT } from './fleet-shared';

type ListQuery = { status?: string; type?: string };
interface ApprovalApi {
  list(query: ListQuery): Promise<unknown>;
  get(id: string): Promise<unknown>;
  decide(id: string, body: DecideApprovalDto): Promise<unknown>;
}
interface Page { records: FleetApprovalDto[] }
interface RequeueResult { jobId: string; ok: boolean; error?: string }

const ADMIN_API: ApprovalApi = {
  list: (query) => fleetApprovalsControllerList({ query: query as never }),
  get: (id) => fleetApprovalsControllerGet({ path: { id } }),
  decide: (id, body) => fleetApprovalsControllerDecide({ path: { id }, body }),
};

const projectApi = (slug: string): ApprovalApi => ({
  list: (query) => projectFleetApprovalsControllerList({ path: { slug }, query: query as never }),
  get: (id) => projectFleetApprovalsControllerGet({ path: { slug, id } }),
  decide: (id, body) => projectFleetApprovalsControllerDecide({ path: { slug, id }, body }),
});

/** `--project` selects the project routes; without it, the global-admin routes (plan D238). */
async function routeFor(project: string | undefined): Promise<ApprovalApi> {
  if (project !== undefined) return projectApi((await withContext({ projectSlug: project })).projectSlug);
  await withContext({}, { requireProject: false });
  return ADMIN_API;
}

const adminHint = (project: string | undefined) => (project === undefined ? { forbiddenHint: ADMIN_TOKEN_HINT } : undefined);

export function parseRequeue(value: string): 'all' | string[] {
  if (value === 'all') return 'all';
  const ids = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (ids.length === 0) throw new InvalidArgumentError('expected all or a comma-separated list of job ids');
  return ids;
}

function parseDecision(value: string): DecideApprovalDto['decision'] {
  if (value === 'keep_paused' || value === 'raise_budget_and_resume') return value;
  throw new InvalidArgumentError('expected keep_paused or raise_budget_and_resume');
}

function summary(a: FleetApprovalDto): string {
  const p = a.payload as Record<string, unknown>;
  if (a.type === 'budget_override_required') return `${String(p['scopeType'] ?? '')} spent $${String(p['spentUsd'] ?? '?')} of $${String(p['amountUsd'] ?? '?')}`;
  return String(p['command'] ?? '').slice(0, 60);
}

function printOne(verb: string, a: FleetApprovalDto): void {
  console.log(`${verb} approval ${a.id}: ${a.type} ${a.status}${a.decision ? ` (${a.decision})` : ''}`);
  const results = ((a.outcome as Record<string, unknown> | null)?.['requeueResults'] ?? []) as RequeueResult[];
  if (results.length > 0) {
    console.log(`${results.filter((r) => r.ok).length} of ${results.length} re-queued`);
    for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.jobId}: ${r.error ?? 'failed'}`);
  }
}

function registerList(approval: Command): void {
  approval
    .command('list')
    .description('Approvals, newest first (--project: that project; otherwise all, global admin)')
    .option('--project <slug>', 'Use the project routes')
    .option('--status <status>', 'pending, approved, rejected, expired or cancelled')
    .option('--type <type>', 'budget_override_required or nax_bash_escalate')
    .option('--json', 'Output as JSON')
    .action(async (options: { project?: string; status?: string; type?: string; json?: boolean }) => {
      try {
        const query: ListQuery = { ...(options.status ? { status: options.status } : {}), ...(options.type ? { type: options.type } : {}) };
        const page = unwrap<Page>(await (await routeFor(options.project)).list(query));
        if (options.json) console.log(JSON.stringify(page.records, null, 2));
        else table(['ID', 'Type', 'Status', 'Requested', 'Summary'], page.records.map((a) => [a.id, a.type, a.status, a.requestedAt, summary(a)]));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, adminHint(options.project));
      }
    });
}

function registerShow(approval: Command): void {
  approval
    .command('show <approvalId>')
    .description('One approval; a pending budget override lists its re-queue candidates')
    .option('--project <slug>', 'Use the project routes')
    .option('--json', 'Output as JSON')
    .action(async (approvalId: string, options: { project?: string; json?: boolean }) => {
      try {
        const a = unwrap<FleetApprovalDto>(await (await routeFor(options.project)).get(approvalId));
        if (options.json) {
          console.log(JSON.stringify(a, null, 2));
        } else {
          printOne('Showing', a);
          for (const c of a.requeueCandidates ?? []) console.log(`  candidate ${c.jobId} ${c.feature}`);
          if (a.requeueCandidatesTruncated) console.log('  (more candidates exist)');
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...adminHint(options.project), notFoundMessage: `Approval not found: ${approvalId}` });
      }
    });
}

interface DecideOptions { project?: string; decision: DecideApprovalDto['decision']; amount?: number; requeue?: 'all' | string[]; comment?: string; json?: boolean }

function registerDecide(approval: Command): void {
  approval
    .command('decide <approvalId>')
    .description('Decide a pending budget override: keep it paused, or raise the amount and resume')
    .requiredOption('--decision <decision>', 'keep_paused or raise_budget_and_resume', parseDecision)
    .option('--amount <usd>', 'raise_budget_and_resume: the new amount, above the window spend', parseBudgetUsd)
    .option('--requeue <ids>', 'raise_budget_and_resume: all, or comma-separated candidate job ids; omitted = none', parseRequeue)
    .option('--comment <text>', 'Optional note (at most 1000 characters)')
    .option('--project <slug>', 'Use the project routes')
    .option('--json', 'Output as JSON')
    .action(async (approvalId: string, options: DecideOptions) => {
      try {
        const api = await routeFor(options.project);
        const requeueJobIds = options.requeue === 'all'
          ? (unwrap<FleetApprovalDto>(await api.get(approvalId)).requeueCandidates ?? []).map((c) => c.jobId)
          : options.requeue;
        const body: DecideApprovalDto = {
          decision: options.decision,
          ...(options.amount !== undefined ? { amountUsd: options.amount } : {}),
          ...(requeueJobIds !== undefined ? { requeueJobIds } : {}),
          ...(options.comment !== undefined ? { comment: options.comment } : {}),
        };
        const decided = unwrap<FleetApprovalDto>(await api.decide(approvalId, body));
        if (options.json) console.log(JSON.stringify(decided, null, 2));
        else printOne('Decided', decided);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...adminHint(options.project), notFoundMessage: `Approval not found: ${approvalId}` });
      }
    });
}

/** `koda fleet approval …`: S1.5 typed approvals (spec §2.5, plan D238). */
export function registerFleetApproval(fleet: Command): void {
  const approval = fleet.command('approval');
  approval.description('Fleet approvals: budget overrides now, bash command asks from S1.5 slice 2');
  registerList(approval);
  registerShow(approval);
  registerDecide(approval);
}
```

In `apps/cli/src/commands/fleet.ts`, import `registerFleetApproval` and call it next to `registerFleetBudget(fleet)`.
If the generated `list` functions type `query` strictly enough that `as never` is unneeded, drop the cast.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/cli && bun run test -- src/commands/fleet-approval.spec.ts src/commands/fleet-budget.spec.ts && bun run type-check`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/fleet-approval.ts apps/cli/src/commands/fleet-approval.spec.ts apps/cli/src/commands/fleet.ts
git commit -m "feat(cli): S1.5 1a koda fleet approval list, show, decide"
```

---

### Task 8: Docs and whole-slice verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-fleet-s1-5-approvals-design.md` (a "1a plan notes" bullet under §8)
- Modify: `docs/deployment/runner.md` only if it documents budget resume (grep first; add one line that a hard stop
  now raises an approval answerable with `koda fleet approval decide`)

- [ ] **Step 1: Spec plan notes**

Append under §8 of the spec:

```markdown
- 1a plan notes (`docs/superpowers/plans/2026-10-02-fleet-s1-5-slice-1a-approvals-core.md`, D226-D238): two modules
  (store + approvals); the hard stop opens the approval before inserting its incident; the resume route follows the
  policy scope; an omitted `requeueJobIds` re-queues nothing; counts live at `GET /fleet/approval-counts`; bash
  approvals answer 400 until 2a.
```

- [ ] **Step 2: Run every gate**

Run, from the repo root:

```bash
cd apps/api && bun run lint && bun run type-check && bun run test && bun run test:scoped test/integration/fleet
cd ../cli && bun run lint && bun run type-check && bun run test
cd ../.. && bun run generate && git status --short openapi.json
```

Expected: lint and type-check clean; all unit suites green; every `test/integration/fleet` file green (rerun a file
alone after a minute if it hits the login throttle cascade); `bun run generate` leaves `openapi.json` unchanged.

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs(fleet): S1.5 1a plan notes"
```
