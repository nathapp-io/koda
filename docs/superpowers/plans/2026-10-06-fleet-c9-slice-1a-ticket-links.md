# Fleet C9 Slice 1a — Ticket Links, Dispatch and Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fleet job can be dispatched for one or more tickets; a RUN moves them to IN_PROGRESS, a failed attempt comments on them, and each ticket can list and unlink its jobs (API + CLI).

**Architecture:** A new `FleetJobTicket` join table links jobs to tickets inside the dispatch transaction. A new `apps/api/src/fleet/tickets/` module owns ticket-side reads, unlink and the after-commit effects (`FleetJobTicketEffects`), which reuse `TicketTransitionsService` for status moves and the `TicketEvent` outbox for live events. Slice 1b (fleet PR links, refresher, matching fix) and slice 2 (web) follow in their own plans.

**Tech Stack:** NestJS 11 + Prisma (PostgreSQL 16), Jest, Commander.js CLI with the generated OpenAPI client.

**Spec:** `docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md` (§1, §2, §3.1, §3.2, §5, §7 slice 1a; D448-D454, D459, D460).

## Global Constraints

- No Prisma enums (repo rule, `apps/api/CLAUDE.md`): string columns with a value comment; constants in `apps/api/src/common/enums.ts`.
- `ticketRefs`: at most 20, upper-cased, deduplicated; each must be a ticket of this project, not deleted, status not CLOSED or REJECTED; otherwise 400 through `fleet.dispatchInput` with reason `ticket <REF>` (D450).
- Links are written in the dispatch transaction; a failed dispatch leaves none (D450).
- Ticket effects run after commit, best-effort per ticket, and never fail dispatch or sync (D451).
- RUN dispatch: CREATED or VERIFIED -> IN_PROGRESS as the requester; PLAN: no transition; no backward moves (D452).
- Failure comment for FAILED, ESCALATED, CRASHED only; once per attempt via `FleetJobTicket.notifiedEpoch`; null author; type GENERAL; reason truncated to 500 chars (D453).
- `onTerminal` is called after commit from sync `afterTerminal` and the sweeper only (D454).
- Unlink deletes the join row and that job's `source = 'fleet'` links on that ticket; status changes and comments stay (D459).
- `GET .../tickets/:ref/fleet-jobs`: at most 50, newest `queuedAt` first; `FleetJobDto.tickets` is `null` on lists (D460).
- Existing `TicketLink` rows become `source = 'vcs'` via the column default.
- API strings in `apps/api/src/i18n/{en,zh}`; generated files under `apps/cli/src/generated/` are never hand-edited; `bun run generate` must leave no diff after the contract change.
- No emojis in code, comments or docs.

## Review Focus

- **Lower-case refs** (`web-1` from a terminal): accepted as `WEB-1`, not rejected. Pinned in Task 2 (`parseDispatchRefs`).
- **A ticket soft-deleted after it was linked:** it disappears from the job's `tickets` and gets no effects. Pinned in Task 2 (repository integration) and Task 5.
- **A ticket transition that loses a race** (409 from `updateTicketStatusIf`) or throws: dispatch still returns 201 and the other tickets still move. Pinned in Task 4.
- **The same terminal state processed twice** (runner resends a report, sweeper and sync overlap): one comment per attempt; a requeued attempt that fails again comments again. Pinned in Task 5.
- **A failure with no reason recorded:** the comment says `no reason recorded` instead of `null`. Pinned in Task 5 (`failureCommentBody`).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` | `FleetJobTicket` model; `TicketLink.source`, `TicketLink.jobId`; back-relations. |
| `apps/api/prisma/migrations/20261006120000_fleet_ticket_work_products/migration.sql` | The DDL. |
| `apps/api/src/common/enums.ts` | `TicketLinkSource` constants. |
| `apps/api/src/fleet/tickets/ticket-refs.ts` | Pure: parse and validate dispatch refs. |
| `apps/api/src/fleet/tickets/failure-comment.ts` | Pure: failure states and comment body. |
| `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts` | All Prisma access for the module. |
| `apps/api/src/fleet/tickets/fleet-tickets.service.ts` | Dispatch resolution, linking, reads, unlink. |
| `apps/api/src/fleet/tickets/fleet-ticket-event.recorder.ts` | Writes `TicketEvent` + outbox rows (live events). |
| `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts` | After-commit effects: RUN status move, failure comments. |
| `apps/api/src/fleet/tickets/ticket-fleet-jobs.controller.ts` | `GET` / `DELETE /projects/:slug/tickets/:ref/fleet-jobs`. |
| `apps/api/src/fleet/tickets/dto/ticket-fleet-job.dto.ts` | `TicketFleetJobDto`, `FleetJobTicketDto`. |
| `apps/api/src/fleet/tickets/fleet-tickets.module.ts` | Module wiring. |
| `apps/api/src/fleet/jobs/*` | `ticketRefs` on dispatch, `tickets` on job detail. |
| `apps/api/src/fleet/sync/sync.service.ts`, `fleet-sweeper.ts` | Call `onTerminal`. |
| `apps/cli/src/commands/fleet-dispatch.ts`, `ticket.ts` | `--ticket`, "Fleet runs" section. |

---

### Task 1: Schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (models `Ticket` ~L139, `TicketLink` L249-265, `FleetJob` L751-830)
- Create: `apps/api/prisma/migrations/20261006120000_fleet_ticket_work_products/migration.sql`
- Modify: `apps/api/src/common/enums.ts`
- Test: `apps/api/test/integration/fleet/fleet-tickets-schema.integration.spec.ts`

**Interfaces:**
- Produces: Prisma model `fleetJobTicket` (`jobId`, `ticketId`, `notifiedEpoch: number | null`, `createdAt`), `ticketLink.source: string`, `ticketLink.jobId: string | null`; `TicketLinkSource = { VCS: 'vcs', FLEET: 'fleet' }`.

- [ ] **Step 1: Write the failing schema test**

```ts
/**
 * Fleet C9 slice 1a — FleetJobTicket and TicketLink.source/jobId (PG), spec §1.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-schema.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet tickets schema (PG)', () => {
  const prisma = new PrismaClient();
  let projectId: string;
  let repoId: string;
  let userId: string;

  const newJob = (feature: string) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: userId,
      },
    });
  const newTicket = (number: number) =>
    prisma.ticket.create({ data: { projectId, number, type: 'TASK', title: `t${number}` } });

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repo = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    userId = user.id;
    projectId = project.id;
    repoId = repo.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('links a job to many tickets and refuses a duplicate pair', async () => {
    const job = await newJob('many');
    const [a, b] = [await newTicket(1), await newTicket(2)];
    await prisma.fleetJobTicket.createMany({ data: [{ jobId: job.id, ticketId: a.id }, { jobId: job.id, ticketId: b.id }] });
    expect(await prisma.fleetJobTicket.count({ where: { jobId: job.id } })).toBe(2);
    await expect(prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: a.id } })).rejects.toThrow();
  });

  it('cascades from both sides', async () => {
    const job = await newJob('cascade');
    const t = await newTicket(3);
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: t.id } });
    await prisma.ticket.delete({ where: { id: t.id } });
    expect(await prisma.fleetJobTicket.count({ where: { jobId: job.id } })).toBe(0);
    const t2 = await newTicket(4);
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: t2.id } });
    await prisma.fleetJob.delete({ where: { id: job.id } });
    expect(await prisma.fleetJobTicket.count({ where: { ticketId: t2.id } })).toBe(0);
  });

  it('defaults TicketLink.source to vcs and nulls jobId when the job goes', async () => {
    const t = await newTicket(5);
    const plain = await prisma.ticketLink.create({ data: { ticketId: t.id, url: 'https://x.test/1', provider: 'other' } });
    expect(plain).toEqual(expect.objectContaining({ source: 'vcs', jobId: null }));
    const job = await newJob('pr');
    const fleet = await prisma.ticketLink.create({
      data: { ticketId: t.id, url: 'https://github.com/acme/app/pull/9', provider: 'github', linkType: 'pr', source: 'fleet', jobId: job.id },
    });
    await prisma.fleetJob.delete({ where: { id: job.id } });
    expect(await prisma.ticketLink.findUniqueOrThrow({ where: { id: fleet.id } })).toEqual(expect.objectContaining({ source: 'fleet', jobId: null }));
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-tickets-schema.integration.spec.ts`
Expected: FAIL to compile (`fleetJobTicket` does not exist on PrismaClient).

- [ ] **Step 3: Edit the schema**

In `model Ticket` add, after `labels TicketLabel[]`:

```prisma
  fleetJobs       FleetJobTicket[]
```

Replace `model TicketLink` with:

```prisma
model TicketLink {
  id          String    @id @default(cuid())
  ticketId    String
  url         String
  provider    String // github | gitlab | bitbucket | other
  externalRef String? // provider-specific reference e.g. 'owner/repo#42'
  prState     String? // draft | open | merged | closed
  prNumber    Int? // direct PR lookup
  prUpdatedAt DateTime? // tracking last sync time
  linkType    String    @default("url") // url | pr | commit | branch
  source      String    @default("vcs") // vcs | fleet (fleet C9 §1)
  jobId       String? // fleet job that produced the link (fleet C9 §1)
  createdAt   DateTime  @default(now())

  ticket Ticket    @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  job    FleetJob? @relation(fields: [jobId], references: [id], onDelete: SetNull)

  @@unique([ticketId, url])
  @@index([externalRef])
  @@index([jobId])
}
```

In `model FleetJob`, next to the other relation lists (e.g. after `costEvents FleetCostEvent[]`), add:

```prisma
  tickets     FleetJobTicket[]
  ticketLinks TicketLink[]
```

After `model FleetJob`, add:

```prisma
/// Fleet C9 §1 (D448): a job dispatched for one or more tickets.
model FleetJobTicket {
  jobId         String
  ticketId      String
  notifiedEpoch Int? // last leaseEpoch whose failure comment was written (D453)
  createdAt     DateTime @default(now())

  job    FleetJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  ticket Ticket   @relation(fields: [ticketId], references: [id], onDelete: Cascade)

  @@id([jobId, ticketId])
  @@index([ticketId])
}
```

- [ ] **Step 4: Write the migration**

`apps/api/prisma/migrations/20261006120000_fleet_ticket_work_products/migration.sql`:

```sql
-- Fleet C9 slice 1a: job <-> ticket links and fleet-sourced ticket links (spec §1, D448, D449).
CREATE TABLE "FleetJobTicket" (
    "jobId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "notifiedEpoch" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetJobTicket_pkey" PRIMARY KEY ("jobId","ticketId")
);
CREATE INDEX "FleetJobTicket_ticketId_idx" ON "FleetJobTicket"("ticketId");
ALTER TABLE "FleetJobTicket" ADD CONSTRAINT "FleetJobTicket_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetJobTicket" ADD CONSTRAINT "FleetJobTicket_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketLink" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'vcs';
ALTER TABLE "TicketLink" ADD COLUMN "jobId" TEXT;
CREATE INDEX "TicketLink_jobId_idx" ON "TicketLink"("jobId");
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 5: Add the constants**

In `apps/api/src/common/enums.ts`, next to the other ticket constants:

```ts
/** Fleet C9 §1: where a TicketLink came from. */
export const TicketLinkSource = {
  VCS: 'vcs',
  FLEET: 'fleet',
} as const;
export type TicketLinkSource = (typeof TicketLinkSource)[keyof typeof TicketLinkSource];
```

- [ ] **Step 6: Regenerate, check the migration matches the schema, run the test**

```bash
cd apps/api && bunx prisma format && bunx prisma validate && bun run db:generate
docker compose -f ../../docker-compose.test.yml exec -T postgres psql -U koda -d koda_test -c 'DROP DATABASE IF EXISTS koda_c9_check' -c 'CREATE DATABASE koda_c9_check'
DATABASE_URL=postgresql://koda:koda@localhost:5433/koda_c9_check bunx prisma migrate deploy
bunx prisma migrate diff --from-url postgresql://koda:koda@localhost:5433/koda_c9_check --to-schema-datamodel prisma/schema.prisma --exit-code
docker compose -f ../../docker-compose.test.yml exec -T postgres psql -U koda -d koda_test -c 'DROP DATABASE koda_c9_check'
bun run test:scoped test/integration/fleet/fleet-tickets-schema.integration.spec.ts
```

Expected: `migrate diff` exits 0 ("No difference detected"); the 3 schema tests PASS. If `prisma format` reformats unrelated lines, keep only the lines this task added.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/common/enums.ts apps/api/test/integration/fleet/fleet-tickets-schema.integration.spec.ts
git commit -m "feat(fleet): FleetJobTicket table and TicketLink source/jobId (C9 1a)"
```

---

### Task 2: Ref parsing and the fleet-tickets repository

**Files:**
- Create: `apps/api/src/fleet/tickets/ticket-refs.ts`
- Create: `apps/api/src/fleet/tickets/ticket-refs.spec.ts`
- Create: `apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts`
- Test: `apps/api/test/integration/fleet/fleet-tickets-repository.integration.spec.ts`

**Interfaces:**
- Consumes: Task 1 models.
- Produces:
  - `MAX_DISPATCH_TICKETS = 20`
  - `parseDispatchRefs(refs: readonly string[], projectKey: string): ParsedDispatchRef[]` with `ParsedDispatchRef = { ref: string; number: number }`; throws `ValidationAppException({ reason: 'ticket <REF>' }, 'fleet.dispatchInput')`.
  - `PrismaFleetTicketsRepository` methods (all use `this.prisma.client`, so they join an open `txManager.run`):
    - `findProject(projectId: string): Promise<{ key: string; slug: string } | null>`
    - `findTicketsByNumbers(projectId: string, numbers: readonly number[]): Promise<TicketRow[]>`, `TicketRow = { id: string; number: number; title: string; status: string; deletedAt: Date | null }`
    - `findTicketByRef(projectId: string, projectKey: string, ref: string): Promise<{ id: string } | null>`
    - `linkTickets(jobId: string, ticketIds: readonly string[]): Promise<void>`
    - `findTicketsForJob(jobId: string): Promise<LinkedTicket[]>`, `LinkedTicket = { ticketId: string; ref: string; title: string; status: string; notifiedEpoch: number | null }` (excludes deleted tickets, ordered by ticket number)
    - `findJobForEffects(jobId: string): Promise<EffectJob | null>`, `EffectJob = { id: string; projectId: string; projectSlug: string; command: string; state: string; leaseEpoch: number; stateReason: string | null; escalationReason: string | null; requestedById: string }`
    - `claimNotified(jobId: string, ticketId: string, epoch: number): Promise<boolean>`
    - `createSystemComment(ticketId: string, body: string): Promise<{ id: string }>`
    - `findJobsForTicket(ticketId: string, limit: number): Promise<TicketJobRow[]>`, `TicketJobRow = { id: string; command: string; feature: string; state: string; stateReason: string | null; escalationReason: string | null; resultBranch: string | null; resultSha: string | null; resultPrUrl: string | null; costSpentUsd: string; costCarriedUsd: string; queuedAt: Date; finishedAt: Date | null }`
    - `unlink(jobId: string, ticketId: string): Promise<boolean>` (true when a join row was deleted; also deletes that job's `source = 'fleet'` links on the ticket)

- [ ] **Step 1: Write the failing unit test for ref parsing**

`apps/api/src/fleet/tickets/ticket-refs.spec.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { MAX_DISPATCH_TICKETS, parseDispatchRefs } from './ticket-refs';

const reasonOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationAppException);
    return JSON.stringify(error);
  }
  throw new Error('expected a throw');
};

describe('parseDispatchRefs (C9 D450)', () => {
  it('upper-cases, trims and deduplicates', () => {
    expect(parseDispatchRefs([' web-1', 'WEB-2', 'Web-1'], 'WEB')).toEqual([
      { ref: 'WEB-1', number: 1 },
      { ref: 'WEB-2', number: 2 },
    ]);
  });

  it('returns [] for no refs', () => {
    expect(parseDispatchRefs([], 'WEB')).toEqual([]);
  });

  it.each([
    ['another project key', 'OPS-1'],
    ['a CUID', 'clx0000000000000000000000'],
    ['an empty ref', '  '],
    ['a zero number', 'WEB-0'],
  ])('refuses %s, naming the ref', (_label, ref) => {
    expect(reasonOf(() => parseDispatchRefs([ref], 'WEB'))).toContain(`ticket ${ref.trim().toUpperCase()}`);
  });

  it(`refuses more than ${MAX_DISPATCH_TICKETS} distinct refs`, () => {
    const refs = Array.from({ length: MAX_DISPATCH_TICKETS + 1 }, (_, i) => `WEB-${i + 1}`);
    expect(reasonOf(() => parseDispatchRefs(refs, 'WEB'))).toContain('too many tickets');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && bunx jest src/fleet/tickets/ticket-refs.spec.ts`
Expected: FAIL, "Cannot find module './ticket-refs'".

- [ ] **Step 3: Implement `ticket-refs.ts`**

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseTicketRef } from '../../common/utils/ticket-ref.util';

/** Spec §2.1 (D450). */
export const MAX_DISPATCH_TICKETS = 20;

export interface ParsedDispatchRef {
  ref: string;
  number: number;
}

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.dispatchInput');
}

/** Upper-cased, deduplicated `KEY-N` refs of this project, in first-seen order. Throws 400 naming the first bad ref. */
export function parseDispatchRefs(refs: readonly string[], projectKey: string): ParsedDispatchRef[] {
  const normalized = [...new Set(refs.map((r) => r.trim().toUpperCase()))];
  if (normalized.length > MAX_DISPATCH_TICKETS) fail(`too many tickets (max ${MAX_DISPATCH_TICKETS})`);
  return normalized.map((ref) => {
    const parsed = parseTicketRef(ref);
    if (!parsed || parsed.prefix !== projectKey || parsed.number < 1) fail(`ticket ${ref}`);
    return { ref, number: parsed.number };
  });
}
```

- [ ] **Step 4: Run the unit test**

Run: `cd apps/api && bunx jest src/fleet/tickets/ticket-refs.spec.ts`
Expected: PASS (5 cases + the each-table).

- [ ] **Step 5: Write the failing repository integration test**

`apps/api/test/integration/fleet/fleet-tickets-repository.integration.spec.ts`:

```ts
/**
 * Fleet C9 slice 1a — PrismaFleetTicketsRepository (PG), spec §1-§3.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-repository.integration.spec.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { PrismaFleetTicketsRepository } from '../../../src/fleet/tickets/prisma-fleet-tickets.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet tickets repository (PG)', () => {
  const prisma = new PrismaClient();
  const repo = new PrismaFleetTicketsRepository({ client: prisma } as never);
  let projectId: string;
  let repoId: string;
  let userId: string;

  const newJob = (feature: string, extra: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', feature, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: userId, ...extra,
      },
    });
  const newTicket = (number: number, extra: Partial<Prisma.TicketUncheckedCreateInput> = {}) =>
    prisma.ticket.create({ data: { projectId, number, type: 'TASK', title: `t${number}`, ...extra } });

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'Web', slug: 'web', key: 'WEB' } });
    const repoRow = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: user.id },
    });
    userId = user.id;
    projectId = project.id;
    repoId = repoRow.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('finds the project key and slug, and tickets by number including deleted ones', async () => {
    expect(await repo.findProject(projectId)).toEqual({ key: 'WEB', slug: 'web' });
    const live = await newTicket(1);
    await newTicket(2, { deletedAt: new Date() });
    const rows = await repo.findTicketsByNumbers(projectId, [1, 2, 99]);
    expect(rows.map((r) => [r.number, r.deletedAt === null])).toEqual(expect.arrayContaining([[1, true], [2, false]]));
    expect(await repo.findTicketByRef(projectId, 'WEB', 'web-1')).toEqual({ id: live.id });
    expect(await repo.findTicketByRef(projectId, 'WEB', live.id)).toEqual({ id: live.id });
    expect(await repo.findTicketByRef(projectId, 'WEB', 'OPS-1')).toBeNull();
    expect(await repo.findTicketByRef(projectId, 'WEB', 'WEB-2')).toBeNull();
  });

  it('links tickets, lists them by number and hides a ticket deleted later', async () => {
    const job = await newJob('link');
    const [a, b] = [await newTicket(11), await newTicket(10)];
    await repo.linkTickets(job.id, [a.id, b.id]);
    expect((await repo.findTicketsForJob(job.id)).map((t) => t.ref)).toEqual(['WEB-10', 'WEB-11']);
    await prisma.ticket.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    expect((await repo.findTicketsForJob(job.id)).map((t) => t.ref)).toEqual(['WEB-10']);
  });

  it('claims a notification once per epoch and again for a later epoch', async () => {
    const job = await newJob('claim');
    const t = await newTicket(20);
    await repo.linkTickets(job.id, [t.id]);
    expect(await repo.claimNotified(job.id, t.id, 1)).toBe(true);
    expect(await repo.claimNotified(job.id, t.id, 1)).toBe(false);
    expect(await repo.claimNotified(job.id, t.id, 2)).toBe(true);
    expect(await repo.claimNotified(job.id, 'missing', 3)).toBe(false);
  });

  it('reads the job for effects with the project slug', async () => {
    const job = await newJob('effects', { state: 'ESCALATED', leaseEpoch: 2, escalationReason: 'review blocked' });
    expect(await repo.findJobForEffects(job.id)).toEqual(expect.objectContaining({
      id: job.id, projectSlug: 'web', command: 'RUN', state: 'ESCALATED', leaseEpoch: 2, escalationReason: 'review blocked', requestedById: userId,
    }));
    expect(await repo.findJobForEffects('missing')).toBeNull();
  });

  it('writes a system comment with no author', async () => {
    const t = await newTicket(30);
    const { id } = await repo.createSystemComment(t.id, 'hello');
    expect(await prisma.comment.findUniqueOrThrow({ where: { id } })).toEqual(
      expect.objectContaining({ body: 'hello', type: 'GENERAL', authorUserId: null, authorAgentId: null }),
    );
  });

  it('lists a ticket\'s jobs newest first, capped', async () => {
    const t = await newTicket(40);
    const older = await newJob('older', { queuedAt: new Date('2026-10-01T00:00:00Z'), costSpentUsd: new Prisma.Decimal('0.5'), costCarriedUsd: new Prisma.Decimal('0.25') });
    const newer = await newJob('newer', { queuedAt: new Date('2026-10-02T00:00:00Z') });
    await repo.linkTickets(older.id, [t.id]);
    await repo.linkTickets(newer.id, [t.id]);
    const rows = await repo.findJobsForTicket(t.id, 50);
    expect(rows.map((r) => r.feature)).toEqual(['newer', 'older']);
    expect(rows[1]).toEqual(expect.objectContaining({ costSpentUsd: '0.5', costCarriedUsd: '0.25' }));
    expect(await repo.findJobsForTicket(t.id, 1)).toHaveLength(1);
  });

  it('unlinks the join row and only that job\'s fleet links on that ticket', async () => {
    const job = await newJob('unlink');
    const other = await newJob('unlink-other');
    const t = await newTicket(50);
    await repo.linkTickets(job.id, [t.id]);
    await prisma.ticketLink.createMany({
      data: [
        { ticketId: t.id, url: 'https://github.com/acme/app/pull/1', provider: 'github', linkType: 'pr', source: 'fleet', jobId: job.id },
        { ticketId: t.id, url: 'https://github.com/acme/app/pull/2', provider: 'github', linkType: 'pr', source: 'fleet', jobId: other.id },
        { ticketId: t.id, url: 'https://github.com/acme/app/pull/3', provider: 'github', linkType: 'pr', source: 'vcs', jobId: job.id },
      ],
    });
    expect(await repo.unlink(job.id, t.id)).toBe(true);
    expect(await prisma.fleetJobTicket.count({ where: { jobId: job.id } })).toBe(0);
    expect((await prisma.ticketLink.findMany({ where: { ticketId: t.id }, orderBy: { url: 'asc' } })).map((l) => l.url)).toEqual([
      'https://github.com/acme/app/pull/2', 'https://github.com/acme/app/pull/3',
    ]);
    expect(await repo.unlink(job.id, t.id)).toBe(false);
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-repository.integration.spec.ts`
Expected: FAIL, "Cannot find module '../../../src/fleet/tickets/prisma-fleet-tickets.repository'".

- [ ] **Step 7: Implement the repository**

`apps/api/src/fleet/tickets/prisma-fleet-tickets.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { CommentType, TicketLinkSource } from '../../common/enums';
import { parseTicketRef } from '../../common/utils/ticket-ref.util';

export interface TicketRow { id: string; number: number; title: string; status: string; deletedAt: Date | null }
export interface LinkedTicket { ticketId: string; ref: string; title: string; status: string; notifiedEpoch: number | null }
export interface EffectJob {
  id: string; projectId: string; projectSlug: string; command: string; state: string; leaseEpoch: number;
  stateReason: string | null; escalationReason: string | null; requestedById: string;
}
export interface TicketJobRow {
  id: string; command: string; feature: string; state: string; stateReason: string | null; escalationReason: string | null;
  resultBranch: string | null; resultSha: string | null; resultPrUrl: string | null;
  costSpentUsd: string; costCarriedUsd: string; queuedAt: Date; finishedAt: Date | null;
}

/** Fleet C9 (spec §1-§3.2): every Prisma access of the fleet tickets module. Joins an open txManager.run. */
@Injectable()
export class PrismaFleetTicketsRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findProject(projectId: string): Promise<{ key: string; slug: string } | null> {
    return this.db.project.findUnique({ where: { id: projectId }, select: { key: true, slug: true } });
  }

  async findTicketsByNumbers(projectId: string, numbers: readonly number[]): Promise<TicketRow[]> {
    if (numbers.length === 0) return [];
    return this.db.ticket.findMany({
      where: { projectId, number: { in: [...numbers] } },
      select: { id: true, number: true, title: true, status: true, deletedAt: true },
    });
  }

  /** `KEY-N` (case-insensitive, this project's key only) or a ticket id of this project; deleted tickets never resolve. */
  async findTicketByRef(projectId: string, projectKey: string, ref: string): Promise<{ id: string } | null> {
    const parsed = parseTicketRef(ref.trim().toUpperCase());
    if (parsed) {
      if (parsed.prefix !== projectKey) return null;
      return this.db.ticket.findFirst({ where: { projectId, number: parsed.number, deletedAt: null }, select: { id: true } });
    }
    return this.db.ticket.findFirst({ where: { id: ref, projectId, deletedAt: null }, select: { id: true } });
  }

  async linkTickets(jobId: string, ticketIds: readonly string[]): Promise<void> {
    if (ticketIds.length === 0) return;
    await this.db.fleetJobTicket.createMany({ data: ticketIds.map((ticketId) => ({ jobId, ticketId })), skipDuplicates: true });
  }

  async findTicketsForJob(jobId: string): Promise<LinkedTicket[]> {
    const rows = await this.db.fleetJobTicket.findMany({
      where: { jobId, ticket: { deletedAt: null } },
      select: {
        notifiedEpoch: true,
        ticket: { select: { id: true, number: true, title: true, status: true, project: { select: { key: true } } } },
      },
      orderBy: { ticket: { number: 'asc' } },
    });
    return rows.map((r) => ({
      ticketId: r.ticket.id,
      ref: `${r.ticket.project.key}-${r.ticket.number}`,
      title: r.ticket.title,
      status: r.ticket.status,
      notifiedEpoch: r.notifiedEpoch,
    }));
  }

  async findJobForEffects(jobId: string): Promise<EffectJob | null> {
    const r = await this.db.fleetJob.findUnique({
      where: { id: jobId },
      select: {
        id: true, projectId: true, command: true, state: true, leaseEpoch: true, stateReason: true, escalationReason: true,
        requestedById: true, project: { select: { slug: true } },
      },
    });
    if (!r) return null;
    const { project, ...rest } = r;
    return { ...rest, projectSlug: project.slug };
  }

  /** D453: true for exactly one caller per (job, ticket, epoch); a later epoch claims again. */
  async claimNotified(jobId: string, ticketId: string, epoch: number): Promise<boolean> {
    const { count } = await this.db.fleetJobTicket.updateMany({
      where: { jobId, ticketId, OR: [{ notifiedEpoch: null }, { notifiedEpoch: { lt: epoch } }] },
      data: { notifiedEpoch: epoch },
    });
    return count === 1;
  }

  async createSystemComment(ticketId: string, body: string): Promise<{ id: string }> {
    return this.db.comment.create({
      data: { ticketId, body, type: CommentType.GENERAL, authorUserId: null, authorAgentId: null },
      select: { id: true },
    });
  }

  async findJobsForTicket(ticketId: string, limit: number): Promise<TicketJobRow[]> {
    const rows = await this.db.fleetJob.findMany({
      where: { tickets: { some: { ticketId } } },
      orderBy: { queuedAt: 'desc' },
      take: limit,
      select: {
        id: true, command: true, feature: true, state: true, stateReason: true, escalationReason: true,
        resultBranch: true, resultSha: true, resultPrUrl: true, costSpentUsd: true, costCarriedUsd: true,
        queuedAt: true, finishedAt: true,
      },
    });
    return rows.map((r) => ({ ...r, costSpentUsd: r.costSpentUsd.toString(), costCarriedUsd: r.costCarriedUsd.toString() }));
  }

  /** D459: the join row plus that job's fleet links on that ticket. Call inside txManager.run. */
  async unlink(jobId: string, ticketId: string): Promise<boolean> {
    const { count } = await this.db.fleetJobTicket.deleteMany({ where: { jobId, ticketId } });
    if (count === 0) return false;
    await this.db.ticketLink.deleteMany({ where: { ticketId, jobId, source: TicketLinkSource.FLEET } });
    return true;
  }
}
```

Note: Prisma `Decimal.toString()` prints `0.5` for `0.5000`; if the test sees `0.5000`, normalize with `new Prisma.Decimal(x).toFixed()` in the mapper instead, and keep the assertion as written.

- [ ] **Step 8: Run both tests**

Run: `cd apps/api && bunx jest src/fleet/tickets/ticket-refs.spec.ts && bun run test:scoped test/integration/fleet/fleet-tickets-repository.integration.spec.ts`
Expected: PASS (7 repository cases).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/fleet/tickets apps/api/test/integration/fleet/fleet-tickets-repository.integration.spec.ts
git commit -m "feat(fleet): ticket ref parsing and fleet tickets repository (C9 1a)"
```

---

### Task 3: Dispatch links tickets; job detail lists them

**Files:**
- Create: `apps/api/src/fleet/tickets/dto/ticket-fleet-job.dto.ts`
- Create: `apps/api/src/fleet/tickets/fleet-tickets.service.ts`
- Create: `apps/api/src/fleet/tickets/fleet-tickets.service.spec.ts`
- Create: `apps/api/src/fleet/tickets/fleet-tickets.module.ts`
- Modify: `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts`
- Modify: `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts:66-95`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts:38-95,236-238`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts:28-38`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.module.ts`
- Modify: `apps/api/src/fleet/fleet.module.ts`
- Test: `apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts`

**Interfaces:**
- Consumes: Task 2 `parseDispatchRefs`, `PrismaFleetTicketsRepository`.
- Produces:
  - `FleetJobTicketDto { ref: string; title: string; status: string }`
  - `DispatchTicket { id: string; ref: string; title: string; status: string }`
  - `FleetTicketsService.resolveForDispatch(projectId: string, refs: readonly string[] | undefined): Promise<DispatchTicket[]>`
  - `FleetTicketsService.link(jobId: string, tickets: readonly DispatchTicket[]): Promise<void>`
  - `FleetTicketsService.forJob(jobId: string): Promise<FleetJobTicketDto[]>`
  - `FleetJobDto.tickets: FleetJobTicketDto[] | null`
  - `FleetJobsService.dispatch(actorId, projectId, dto, opts: { scheduleId?: string; ticketActor?: TicketActor })`, `TicketActor = { principal: KodaPrincipal; projectSlug: string }` (exported from `fleet/tickets/fleet-job-ticket.effects.ts` in Task 4; in this task declare it in `fleet-tickets.service.ts` and Task 4 re-exports it)
  - `FleetTicketsModule` exporting `FleetTicketsService`, `PrismaFleetTicketsRepository`

- [ ] **Step 1: Write the failing service unit test**

`apps/api/src/fleet/tickets/fleet-tickets.service.spec.ts`:

```ts
import { ValidationAppException } from '@nathapp/nestjs-common';
import { FleetTicketsService } from './fleet-tickets.service';

describe('FleetTicketsService.resolveForDispatch (C9 D450)', () => {
  const ticket = (number: number, status = 'CREATED', deletedAt: Date | null = null) =>
    ({ id: `t${number}`, number, title: `T${number}`, status, deletedAt });
  let repo: { findProject: jest.Mock; findTicketsByNumbers: jest.Mock };
  let service: FleetTicketsService;

  beforeEach(() => {
    repo = { findProject: jest.fn().mockResolvedValue({ key: 'WEB', slug: 'web' }), findTicketsByNumbers: jest.fn() };
    service = new FleetTicketsService(repo as never, { run: (fn: () => unknown) => fn() } as never);
  });

  it('returns [] without touching the DB when no refs are given', async () => {
    await expect(service.resolveForDispatch('p', undefined)).resolves.toEqual([]);
    await expect(service.resolveForDispatch('p', [])).resolves.toEqual([]);
    expect(repo.findProject).not.toHaveBeenCalled();
  });

  it('resolves refs in request order', async () => {
    repo.findTicketsByNumbers.mockResolvedValue([ticket(2, 'VERIFIED'), ticket(1)]);
    await expect(service.resolveForDispatch('p', ['web-1', 'WEB-2'])).resolves.toEqual([
      { id: 't1', ref: 'WEB-1', title: 'T1', status: 'CREATED' },
      { id: 't2', ref: 'WEB-2', title: 'T2', status: 'VERIFIED' },
    ]);
  });

  it.each([
    ['missing', []],
    ['deleted', [ticket(1, 'CREATED', new Date())]],
    ['CLOSED', [ticket(1, 'CLOSED')]],
    ['REJECTED', [ticket(1, 'REJECTED')]],
  ])('refuses a %s ticket with 400 naming it', async (_label, rows) => {
    repo.findTicketsByNumbers.mockResolvedValue(rows);
    const error = await service.resolveForDispatch('p', ['WEB-1']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationAppException);
    expect(JSON.stringify(error)).toContain('ticket WEB-1');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && bunx jest src/fleet/tickets/fleet-tickets.service.spec.ts`
Expected: FAIL, "Cannot find module './fleet-tickets.service'".

- [ ] **Step 3: Write the DTO file**

`apps/api/src/fleet/tickets/dto/ticket-fleet-job.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { addUsd } from '../../budgets/money';
import type { TicketJobRow } from '../prisma-fleet-tickets.repository';

/** A ticket linked to a fleet job (spec §2.2). */
export class FleetJobTicketDto {
  @ApiProperty({ description: 'Ticket ref, KEY-N' }) declare ref: string;
  @ApiProperty() declare title: string;
  @ApiProperty() declare status: string;
}

/** A fleet job linked to a ticket, read live from FleetJob (spec §2.2, D460). */
export class TicketFleetJobDto {
  @ApiProperty() declare id: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) declare command: string;
  @ApiProperty() declare feature: string;
  @ApiProperty() declare state: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare stateReason: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare escalationReason: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultBranch: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultSha: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare resultPrUrl: string | null;
  @ApiProperty({ description: 'USD spent across all attempts (costSpentUsd + costCarriedUsd)' }) declare costUsd: string;
  @ApiProperty() declare queuedAt: string;
  @ApiPropertyOptional({ type: String, nullable: true }) declare finishedAt: string | null;

  static from(r: TicketJobRow): TicketFleetJobDto {
    return Object.assign(new TicketFleetJobDto(), {
      id: r.id, command: r.command, feature: r.feature, state: r.state, stateReason: r.stateReason,
      escalationReason: r.escalationReason, resultBranch: r.resultBranch, resultSha: r.resultSha, resultPrUrl: r.resultPrUrl,
      costUsd: addUsd(r.costSpentUsd, r.costCarriedUsd), queuedAt: r.queuedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    });
  }
}
```

- [ ] **Step 4: Implement `FleetTicketsService` (dispatch half)**

`apps/api/src/fleet/tickets/fleet-tickets.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TicketStatus } from '../../common/enums';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { FleetJobTicketDto } from './dto/ticket-fleet-job.dto';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import { parseDispatchRefs } from './ticket-refs';

/** Who a RUN dispatch moves tickets as (spec §3.1, D452). */
export interface TicketActor {
  principal: KodaPrincipal;
  projectSlug: string;
}

export interface DispatchTicket {
  id: string;
  ref: string;
  title: string;
  status: string;
}

const NOT_LINKABLE: ReadonlySet<string> = new Set([TicketStatus.CLOSED, TicketStatus.REJECTED]);

function fail(reason: string): never {
  throw new ValidationAppException({ reason }, 'fleet.dispatchInput');
}

/** Fleet C9: ticket links of fleet jobs (spec §2). */
@Injectable()
export class FleetTicketsService {
  constructor(
    private readonly repo: PrismaFleetTicketsRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** D450: validated before the dispatch transaction; throws 400 naming the first bad ref. */
  async resolveForDispatch(projectId: string, refs: readonly string[] | undefined): Promise<DispatchTicket[]> {
    if (!refs || refs.length === 0) return [];
    const project = await this.repo.findProject(projectId);
    if (!project) fail('project');
    const parsed = parseDispatchRefs(refs, project.key);
    const rows = await this.repo.findTicketsByNumbers(projectId, parsed.map((p) => p.number));
    return parsed.map((p) => {
      const row = rows.find((r) => r.number === p.number);
      if (!row || row.deletedAt !== null || NOT_LINKABLE.has(row.status)) fail(`ticket ${p.ref}`);
      return { id: row.id, ref: p.ref, title: row.title, status: row.status };
    });
  }

  /** Call inside the dispatch transaction (D450). */
  async link(jobId: string, tickets: readonly DispatchTicket[]): Promise<void> {
    await this.repo.linkTickets(jobId, tickets.map((t) => t.id));
  }

  async forJob(jobId: string): Promise<FleetJobTicketDto[]> {
    const rows = await this.repo.findTicketsForJob(jobId);
    return rows.map((t) => Object.assign(new FleetJobTicketDto(), { ref: t.ref, title: t.title, status: t.status }));
  }
}
```

(`txManager` is used by `unlink` in Task 6; the constructor takes it now so its signature does not change later.)

- [ ] **Step 5: Run the unit test**

Run: `cd apps/api && bunx jest src/fleet/tickets/fleet-tickets.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Add `ticketRefs` to the dispatch DTO**

In `apps/api/src/fleet/jobs/dto/dispatch-fleet-job.dto.ts`, after `pinnedRunnerId`:

```ts
  @ApiPropertyOptional({ type: [String], maxItems: 20, description: 'Tickets this job works on, KEY-N (fleet C9). A RUN moves CREATED/VERIFIED ones to IN_PROGRESS.' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(32, { each: true }) ticketRefs?: string[];
```

- [ ] **Step 7: Add `tickets` to `FleetJobDto`**

In `apps/api/src/fleet/jobs/dto/fleet-job.dto.ts`: import `FleetJobTicketDto` from `'../../tickets/dto/ticket-fleet-job.dto'`; add after `postRun`:

```ts
  @ApiPropertyOptional({ type: [FleetJobTicketDto], nullable: true, description: 'Linked tickets (fleet C9 §2.2). Null on list pages (D460).' })
  declare tickets: FleetJobTicketDto[] | null;
```

In `static from(...)` add `tickets: null,` after `postRun: r.postRun,`. `summary()` already spreads `from()`, so lists stay `null`.

- [ ] **Step 8: Write the module**

`apps/api/src/fleet/tickets/fleet-tickets.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { FleetTicketsService } from './fleet-tickets.service';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';

/** Fleet C9 (spec docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md). */
@Module({
  imports: [PrismaModule],
  providers: [PrismaFleetTicketsRepository, FleetTicketsService],
  exports: [PrismaFleetTicketsRepository, FleetTicketsService],
})
export class FleetTicketsModule {}
```

Add `FleetTicketsModule` to `imports` of `FleetJobsModule` (`fleet/jobs/fleet-jobs.module.ts`) and of `FleetModule` (`fleet/fleet.module.ts`).

- [ ] **Step 9: Wire dispatch and job detail**

In `apps/api/src/fleet/jobs/fleet-jobs.service.ts`:

Imports:

```ts
import { FleetTicketsService, TicketActor } from '../tickets/fleet-tickets.service';
```

Constructor, append as the last parameter:

```ts
    private readonly fleetTickets: FleetTicketsService,
```

`dispatch` signature and body changes (only the marked lines change):

```ts
  async dispatch(actorId: string, projectId: string, dto: DispatchFleetJobDto, opts: { scheduleId?: string; ticketActor?: TicketActor } = {}): Promise<DispatchResultDto> {
    const repo = await this.repo.findRepo(dto.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    const input = normalizeDispatch(dto, repo.defaultBranch);
    const tickets = await this.fleetTickets.resolveForDispatch(projectId, dto.ticketRefs);   // C9 D450
    // ... unchanged pinned-runner and budget checks ...
        const created = await this.repo.createJob({ /* unchanged */ });
        await this.fleetTickets.link(created.id, tickets);                                    // C9 D450: same transaction
        // ... unchanged appendEvent / activity.record (add ticketRefs to the payload) ...
          payload: { repoId: repo.id, feature: created.feature, command: created.command, ref: created.ref, ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}), ...(tickets.length > 0 ? { ticketRefs: tickets.map((t) => t.ref) } : {}) },
    // ... unchanged until the return ...
    return Object.assign(new DispatchResultDto(), {
      job: Object.assign(FleetJobDto.from(fresh), { tickets: tickets.map((t) => Object.assign(new FleetJobTicketDto(), { ref: t.ref, title: t.title, status: t.status })) }),
      placement: { assigned: outcome.assigned, runnerId: outcome.runnerId, misfits: outcome.misfits },
    });
  }
```

(import `FleetJobTicketDto` from `'../tickets/dto/ticket-fleet-job.dto'`). `opts.ticketActor` is consumed in Task 4.

`get`:

```ts
  async get(projectId: string, id: string): Promise<FleetJobDto> {
    const job = await this.findInProject(projectId, id);
    return Object.assign(await this.withPending(job), { tickets: await this.fleetTickets.forJob(job.id) });
  }
```

In `apps/api/src/fleet/jobs/fleet-jobs.service.spec.ts`, the positional constructor gains one trailing `{} as never` after `approvals as never` (the `get` test then needs `forJob`): change the construction to

```ts
    fleetTickets = { forJob: jest.fn().mockResolvedValue([]) };
    service = new FleetJobsService(
      repo as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      approvals as never, fleetTickets as never,
    );
```

with `let fleetTickets: { forJob: jest.Mock };` declared next to `approvals`.

In the controller (`fleet-jobs.controller.ts` `dispatch`), pass the actor:

```ts
    return JsonResponse.Ok(await this.jobs.dispatch(principal.id, ctx.project.id, dto, { ticketActor: { principal, projectSlug: ctx.project.slug } }));
```

Schedules call `dispatch` without `ticketActor` and their DTO never carries `ticketRefs`; nothing changes there.

- [ ] **Step 10: Write the dispatch integration test**

`apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts`:

```ts
/**
 * Fleet C9 slice 1a — dispatch with ticketRefs, job detail tickets (PG), spec §2.1-§2.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet dispatch with tickets (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let number = 0;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const dispatch = (body: Record<string, unknown>) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth('dev')).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, ...body });
  const ticket = async (status = 'CREATED', projectId = world.projectId) => {
    number += 1;
    return prisma.ticket.create({ data: { projectId, number, type: 'TASK', title: `T${number}`, status } });
  };

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

  it('links every ticket and returns them on the dispatch result and the job detail', async () => {
    const [a, b] = [await ticket(), await ticket('VERIFIED')];
    const res = data<{ job: { id: string; tickets: Array<{ ref: string }> } }>(
      await dispatch({ feature: 'two', ticketRefs: [`web-${a.number}`, `WEB-${b.number}`] }).expect(201),
    );
    expect(res.job.tickets.map((t) => t.ref)).toEqual([`WEB-${a.number}`, `WEB-${b.number}`]);
    expect(await prisma.fleetJobTicket.count({ where: { jobId: res.job.id } })).toBe(2);
    const detail = data<{ tickets: Array<{ ref: string; title: string; status: string }> }>(
      await request(server).get(`/api/projects/web/fleet/jobs/${res.job.id}`).set(auth('viewer')).expect(200),
    );
    expect(detail.tickets.map((t) => t.ref)).toEqual([`WEB-${a.number}`, `WEB-${b.number}`]);
    const list = data<{ records: Array<{ id: string; tickets: unknown }> }>(
      await request(server).get('/api/projects/web/fleet/jobs').set(auth('viewer')).expect(200),
    );
    expect(list.records.find((j) => j.id === res.job.id)?.tickets).toBeNull();
  });

  it.each([
    ['an unknown ref', async () => 'WEB-999'],
    ['a CLOSED ticket', async () => `WEB-${(await ticket('CLOSED')).number}`],
    ['another project\'s ref', async () => 'OPS-1'],
  ])('answers 400 naming %s and creates no job', async (_label, refOf) => {
    const ref = await refOf();
    const before = await prisma.fleetJob.count();
    const res = await dispatch({ feature: `bad-${number}`, ticketRefs: [ref] }).expect(400);
    expect(JSON.stringify(res.body)).toContain(`ticket ${ref}`);
    expect(await prisma.fleetJob.count()).toBe(before);
  });

  it('leaves no links when the dispatch itself fails (409 duplicate feature)', async () => {
    const t = await ticket();
    await dispatch({ feature: 'dup-c9' }).expect(201);
    await dispatch({ feature: 'dup-c9', ticketRefs: [`WEB-${t.number}`] }).expect(409);
    expect(await prisma.fleetJobTicket.count({ where: { ticketId: t.id } })).toBe(0);
  });

  it('answers 400 for more than 20 refs', async () => {
    await dispatch({ feature: 'many', ticketRefs: Array.from({ length: 21 }, (_, i) => `WEB-${i + 1}`) }).expect(400);
  });
});
```

- [ ] **Step 11: Run unit + integration tests**

```bash
cd apps/api && bunx jest src/fleet/tickets src/fleet/jobs
bun run test:scoped test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts test/integration/fleet/fleet-jobs.integration.spec.ts
```

Expected: all PASS; the existing `fleet-jobs.integration.spec.ts` still passes unchanged.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts
git commit -m "feat(fleet): dispatch links tickets, job detail lists them (C9 1a)"
```

---

### Task 4: RUN dispatch moves tickets to IN_PROGRESS

**Files:**
- Create: `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`
- Create: `apps/api/src/fleet/tickets/fleet-job-ticket.effects.spec.ts`
- Modify: `apps/api/src/fleet/tickets/fleet-tickets.module.ts`
- Modify: `apps/api/src/fleet/jobs/fleet-jobs.service.ts` (dispatch tail), `fleet-jobs.service.spec.ts`
- Test: `apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts` (extend)

**Interfaces:**
- Consumes: `TicketTransitionsService.start(projectSlug: string, ticketRef: string, principal: KodaPrincipal)`; Task 3 `DispatchTicket`, `TicketActor`.
- Produces: `FleetJobTicketEffects.onRunDispatched(actor: TicketActor, tickets: readonly DispatchTicket[]): Promise<void>` (never throws); `FleetJobTicketEffects.onTerminal` is added in Task 5.

- [ ] **Step 1: Write the failing unit test**

`apps/api/src/fleet/tickets/fleet-job-ticket.effects.spec.ts`:

```ts
import { FleetJobTicketEffects } from './fleet-job-ticket.effects';

describe('FleetJobTicketEffects.onRunDispatched (C9 §3.1, D452)', () => {
  const principal = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u@koda.test' } as never;
  const actor = { principal, projectSlug: 'web' };
  const t = (ref: string, status: string) => ({ id: ref, ref, title: ref, status });
  let transitions: { start: jest.Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    transitions = { start: jest.fn().mockResolvedValue({}) };
    effects = new FleetJobTicketEffects(transitions as never, {} as never, {} as never, {} as never);
  });

  it('starts CREATED and VERIFIED tickets only, as the requester', async () => {
    await effects.onRunDispatched(actor, [t('WEB-1', 'CREATED'), t('WEB-2', 'VERIFIED'), t('WEB-3', 'IN_PROGRESS'), t('WEB-4', 'VERIFY_FIX')]);
    expect(transitions.start.mock.calls).toEqual([['web', 'WEB-1', principal], ['web', 'WEB-2', principal]]);
  });

  it('keeps going when one transition fails, and never throws', async () => {
    transitions.start.mockRejectedValueOnce(new Error('Ticket state changed concurrently'));
    await expect(effects.onRunDispatched(actor, [t('WEB-1', 'CREATED'), t('WEB-2', 'CREATED')])).resolves.toBeUndefined();
    expect(transitions.start).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && bunx jest src/fleet/tickets/fleet-job-ticket.effects.spec.ts`
Expected: FAIL, "Cannot find module './fleet-job-ticket.effects'".

- [ ] **Step 3: Implement the effects class (dispatch half)**

`apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { TicketStatus } from '../../common/enums';
import { TicketTransitionsService } from '../../tickets/state-machine/ticket-transitions.service';
import type { DispatchTicket, TicketActor } from './fleet-tickets.service';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';

export type { TicketActor } from './fleet-tickets.service';

const STARTABLE: ReadonlySet<string> = new Set([TicketStatus.CREATED, TicketStatus.VERIFIED]);

/** Fleet C9 §3: ticket-side effects of fleet jobs. After commit, best-effort per ticket, never throws (D451). */
@Injectable()
export class FleetJobTicketEffects {
  private readonly logger = new Logger(FleetJobTicketEffects.name);

  constructor(
    private readonly transitions: TicketTransitionsService,
    private readonly repo: PrismaFleetTicketsRepository,
    private readonly events: FleetTicketEventRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** D452: a RUN dispatch starts each CREATED/VERIFIED ticket as the requester; PLAN callers never call this. */
  async onRunDispatched(actor: TicketActor, tickets: readonly DispatchTicket[]): Promise<void> {
    for (const ticket of tickets.filter((t) => STARTABLE.has(t.status))) {
      try {
        await this.transitions.start(actor.projectSlug, ticket.ref, actor.principal);
      } catch (error) {
        this.logger.warn(`Fleet ticket ${ticket.ref}: start failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
```

Create the recorder now (used in Task 5 and Task 6), `apps/api/src/fleet/tickets/fleet-ticket-event.recorder.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { TicketEventService } from '../../events/ticket-event.service';
import { buildTicketEventOutboxPayload } from '../../events/outbox-envelope.util';

/**
 * Fleet C9: TicketEvent + outbox rows for ticket writes the fleet makes (live `commented` / `updated`).
 * Attributed to the job's requester as a user (TicketEvent.actorType is user | agent). Call inside txManager.run.
 */
@Injectable()
export class FleetTicketEventRecorder {
  constructor(
    private readonly ticketEvents: TicketEventService,
    private readonly outbox: NathappOutboxService,
  ) {}

  async record(input: { projectId: string; ticketId: string; action: 'COMMENT_ADDED' | 'TICKET_UPDATED'; actorId: string; data: Record<string, unknown> }): Promise<void> {
    const { projectId, ticketId, action, actorId, data } = input;
    const event = await this.ticketEvents.create({ ticketId, projectId, action, actorId, actorType: 'user', source: 'internal', data });
    await this.outbox.record({
      type: 'ticket_event',
      payload: buildTicketEventOutboxPayload({ event, ticketId, projectId, actorId, actorType: 'user', data }),
      metadata: { projectId, eventId: event.id },
    });
  }
}
```

If `WriteTicketEventInput.data` is typed as a string in `koda-domain-writer/write-result.dto.ts`, pass `data` exactly as `ticket-transitions.service.ts:100` does (it passes the object); match that call.

Update the module (`fleet-tickets.module.ts`):

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { EventsModule } from '../../events/events.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { FleetJobTicketEffects } from './fleet-job-ticket.effects';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
import { FleetTicketsService } from './fleet-tickets.service';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';

/** Fleet C9 (spec docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md). */
@Module({
  imports: [PrismaModule, TicketsModule, EventsModule],
  providers: [PrismaFleetTicketsRepository, FleetTicketsService, FleetTicketEventRecorder, FleetJobTicketEffects],
  exports: [PrismaFleetTicketsRepository, FleetTicketsService, FleetJobTicketEffects],
})
export class FleetTicketsModule {}
```

- [ ] **Step 4: Call it from dispatch**

In `fleet-jobs.service.ts`: import `FleetJobTicketEffects` from `'../tickets/fleet-job-ticket.effects'`; append constructor parameter `private readonly ticketEffects: FleetJobTicketEffects,` after `fleetTickets`; after `const fresh = ...` in `dispatch`:

```ts
    if (input.command === 'RUN' && tickets.length > 0 && opts.ticketActor) {
      await this.ticketEffects.onRunDispatched(opts.ticketActor, tickets);   // C9 D452, after commit
    }
```

The dispatch result's `tickets[].status` stays the value read before the transition (the web reloads the job detail on the live event). In `fleet-jobs.service.spec.ts` append `{} as never` for `ticketEffects` to the constructor call.

- [ ] **Step 5: Run unit tests, then the boot-time module check**

```bash
cd apps/api && bunx jest src/fleet/tickets src/fleet/jobs src/fleet/fleet.module.spec.ts
```

Expected: PASS. If Nest reports a circular module import involving `TicketsModule`, wrap the import in `forwardRef(() => TicketsModule)` in `FleetTicketsModule` and re-run.

- [ ] **Step 6: Extend the dispatch integration test**

Append to `fleet-tickets-dispatch.integration.spec.ts`:

```ts
  it('a RUN starts CREATED and VERIFIED tickets and leaves others; a PLAN starts none', async () => {
    const [created, verified, fixing] = [await ticket(), await ticket('VERIFIED'), await ticket('VERIFY_FIX')];
    await dispatch({ feature: 'starts', ticketRefs: [created, verified, fixing].map((t) => `WEB-${t.number}`) }).expect(201);
    const statuses = await prisma.ticket.findMany({ where: { id: { in: [created.id, verified.id, fixing.id] } }, orderBy: { number: 'asc' } });
    expect(statuses.map((s) => s.status)).toEqual(['IN_PROGRESS', 'IN_PROGRESS', 'VERIFY_FIX']);
    const activity = await prisma.ticketActivity.findFirst({ where: { ticketId: created.id, toStatus: 'IN_PROGRESS' } });
    expect(activity?.actorUserId).toBe(world.ids.dev);

    const planned = await ticket();
    await request(server).post('/api/projects/web/fleet/jobs').set(auth('dev'))
      .send({ repoId: world.repoId, command: 'PLAN', planFrom: 'docs/spec.md', maxCostUsd: 5, feature: 'plans', ticketRefs: [`WEB-${planned.number}`] })
      .expect(201);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: planned.id } })).status).toBe('CREATED');
  });
```

- [ ] **Step 7: Run the integration test**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts
git commit -m "feat(fleet): RUN dispatch moves linked tickets to IN_PROGRESS (C9 1a)"
```

---

### Task 5: Failure comments on terminal jobs

**Files:**
- Create: `apps/api/src/fleet/tickets/failure-comment.ts`
- Create: `apps/api/src/fleet/tickets/failure-comment.spec.ts`
- Modify: `apps/api/src/fleet/tickets/fleet-job-ticket.effects.ts`, `fleet-job-ticket.effects.spec.ts`
- Modify: `apps/api/src/fleet/sync/sync.service.ts:136-142`, `apps/api/src/fleet/sync/fleet-sweeper.ts:23-60`, `apps/api/src/fleet/sync/sync.module.ts`
- Modify: `apps/api/src/fleet/sync/fleet-sweeper.spec.ts` (constructor calls)
- Test: `apps/api/test/integration/fleet/fleet-tickets-terminal.integration.spec.ts`

**Interfaces:**
- Consumes: Task 2 `findJobForEffects`, `findTicketsForJob`, `claimNotified`, `createSystemComment`; Task 4 `FleetTicketEventRecorder.record`.
- Produces: `FAILURE_STATES: ReadonlySet<string>`, `MAX_REASON_CHARS = 500`, `failureCommentBody(job: EffectJob): string`; `FleetJobTicketEffects.onTerminal(jobIds: readonly string[]): Promise<void>` (never throws).

- [ ] **Step 1: Write the failing unit test for the body**

`apps/api/src/fleet/tickets/failure-comment.spec.ts`:

```ts
import { FAILURE_STATES, MAX_REASON_CHARS, failureCommentBody } from './failure-comment';

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job1', projectId: 'p', projectSlug: 'web', command: 'RUN', state: 'FAILED', leaseEpoch: 1,
  stateReason: 'exit 1', escalationReason: null, requestedById: 'u', ...over,
});

describe('failureCommentBody (C9 §3.2, D453)', () => {
  it('names the command, job, state and reason, and links the job page', () => {
    expect(failureCommentBody(job())).toBe('Fleet RUN job job1 ended FAILED: exit 1\n/web/fleet/jobs/job1');
  });

  it('prefers the escalation reason for ESCALATED', () => {
    expect(failureCommentBody(job({ state: 'ESCALATED', escalationReason: 'review blocked', stateReason: 'x' }))).toContain('ended ESCALATED: review blocked');
  });

  it('falls back to the state reason, then to a fixed text', () => {
    expect(failureCommentBody(job({ state: 'ESCALATED', escalationReason: null, stateReason: 'finish escalated' }))).toContain(': finish escalated');
    expect(failureCommentBody(job({ state: 'CRASHED', stateReason: null }))).toContain('ended CRASHED: no reason recorded');
    expect(failureCommentBody(job({ stateReason: '   ' }))).toContain(': no reason recorded');
  });

  it(`truncates the reason to ${MAX_REASON_CHARS} characters`, () => {
    const body = failureCommentBody(job({ stateReason: 'x'.repeat(2000) }));
    const reason = body.split('\n')[0].split(': ')[1];
    expect(reason).toHaveLength(MAX_REASON_CHARS);
    expect(reason.endsWith('...')).toBe(true);
  });

  it('covers exactly the failure states', () => {
    expect([...FAILURE_STATES].sort()).toEqual(['CRASHED', 'ESCALATED', 'FAILED']);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && bunx jest src/fleet/tickets/failure-comment.spec.ts`
Expected: FAIL, "Cannot find module './failure-comment'".

- [ ] **Step 3: Implement `failure-comment.ts`**

```ts
import { FleetJobState } from '../../common/enums';
import type { EffectJob } from './prisma-fleet-tickets.repository';

/** Spec §3.2 (D453): the terminal states that comment on linked tickets. */
export const FAILURE_STATES: ReadonlySet<string> = new Set([FleetJobState.FAILED, FleetJobState.ESCALATED, FleetJobState.CRASHED]);
export const MAX_REASON_CHARS = 500;

function reasonOf(job: EffectJob): string {
  const raw = (job.state === FleetJobState.ESCALATED ? job.escalationReason?.trim() || job.stateReason : job.stateReason)?.trim();
  if (!raw) return 'no reason recorded';
  return raw.length > MAX_REASON_CHARS ? `${raw.slice(0, MAX_REASON_CHARS - 3)}...` : raw;
}

export function failureCommentBody(job: EffectJob): string {
  return `Fleet ${job.command} job ${job.id} ended ${job.state}: ${reasonOf(job)}\n/${job.projectSlug}/fleet/jobs/${job.id}`;
}
```

- [ ] **Step 4: Run it**

Run: `cd apps/api && bunx jest src/fleet/tickets/failure-comment.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add failing unit tests for `onTerminal`**

Append to `fleet-job-ticket.effects.spec.ts`:

```ts
describe('FleetJobTicketEffects.onTerminal (C9 §3.2, D453)', () => {
  const effectJob = (state: string) => ({
    id: 'j1', projectId: 'p', projectSlug: 'web', command: 'RUN', state, leaseEpoch: 3,
    stateReason: 'boom', escalationReason: null, requestedById: 'u1',
  });
  const linked = (ticketId: string) => ({ ticketId, ref: ticketId, title: ticketId, status: 'IN_PROGRESS', notifiedEpoch: null });
  let repo: { findJobForEffects: jest.Mock; findTicketsForJob: jest.Mock; claimNotified: jest.Mock; createSystemComment: jest.Mock };
  let events: { record: jest.Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    repo = {
      findJobForEffects: jest.fn(),
      findTicketsForJob: jest.fn().mockResolvedValue([linked('t1'), linked('t2')]),
      claimNotified: jest.fn().mockResolvedValue(true),
      createSystemComment: jest.fn().mockImplementation(async (ticketId: string) => ({ id: `c-${ticketId}` })),
    };
    events = { record: jest.fn() };
    effects = new FleetJobTicketEffects({} as never, repo as never, events as never, { run: (fn: () => unknown) => fn() } as never);
  });

  it.each(['FAILED', 'ESCALATED', 'CRASHED'])('comments on every linked ticket for %s and records COMMENT_ADDED', async (state) => {
    repo.findJobForEffects.mockResolvedValue(effectJob(state));
    await effects.onTerminal(['j1']);
    expect(repo.claimNotified.mock.calls).toEqual([['j1', 't1', 3], ['j1', 't2', 3]]);
    expect(repo.createSystemComment).toHaveBeenCalledWith('t1', expect.stringContaining(`ended ${state}: boom`));
    expect(events.record).toHaveBeenCalledWith({ projectId: 'p', ticketId: 't2', action: 'COMMENT_ADDED', actorId: 'u1', data: { commentId: 'c-t2' } });
  });

  it.each(['COMPLETED', 'CANCELLED', 'RUNNING'])('does nothing for %s', async (state) => {
    repo.findJobForEffects.mockResolvedValue(effectJob(state));
    await effects.onTerminal(['j1']);
    expect(repo.findTicketsForJob).not.toHaveBeenCalled();
  });

  it('skips a ticket whose claim is lost (already commented this attempt)', async () => {
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    repo.claimNotified.mockResolvedValueOnce(false);
    await effects.onTerminal(['j1']);
    expect(repo.createSystemComment.mock.calls.map((c) => c[0])).toEqual(['t2']);
  });

  it('never throws: one ticket failing does not stop the next, one job failing does not stop the next', async () => {
    repo.findJobForEffects.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(effectJob('FAILED'));
    repo.createSystemComment.mockRejectedValueOnce(new Error('fk'));
    await expect(effects.onTerminal(['jx', 'j1'])).resolves.toBeUndefined();
    expect(repo.createSystemComment.mock.calls.map((c) => c[0])).toEqual(['t1', 't2']);
  });

  it('deduplicates job ids and ignores a missing job', async () => {
    repo.findJobForEffects.mockResolvedValue(null);
    await effects.onTerminal(['j1', 'j1']);
    expect(repo.findJobForEffects).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run and see them fail**

Run: `cd apps/api && bunx jest src/fleet/tickets/fleet-job-ticket.effects.spec.ts`
Expected: FAIL, "effects.onTerminal is not a function".

- [ ] **Step 7: Implement `onTerminal`**

Add to `FleetJobTicketEffects` (and import `FAILURE_STATES`, `failureCommentBody` from `./failure-comment`, `EffectJob`, `LinkedTicket` types from `./prisma-fleet-tickets.repository`):

```ts
  /** D453/D454: after commit, from sync afterTerminal and the sweeper. One comment per (ticket, attempt). */
  async onTerminal(jobIds: readonly string[]): Promise<void> {
    for (const jobId of new Set(jobIds)) {
      try {
        const job = await this.repo.findJobForEffects(jobId);
        if (!job || !FAILURE_STATES.has(job.state)) continue;
        const body = failureCommentBody(job);
        for (const ticket of await this.repo.findTicketsForJob(jobId)) {
          await this.commentOnce(job, ticket, body);
        }
      } catch (error) {
        this.logger.warn(`Fleet job ${jobId}: ticket effects failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async commentOnce(job: EffectJob, ticket: LinkedTicket, body: string): Promise<void> {
    try {
      await this.txManager.run(async () => {
        if (!(await this.repo.claimNotified(job.id, ticket.ticketId, job.leaseEpoch))) return;
        const comment = await this.repo.createSystemComment(ticket.ticketId, body);
        await this.events.record({ projectId: job.projectId, ticketId: ticket.ticketId, action: 'COMMENT_ADDED', actorId: job.requestedById, data: { commentId: comment.id } });
      });
    } catch (error) {
      this.logger.warn(`Fleet job ${job.id}: comment on ticket ${ticket.ref} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
```

The claim and the comment share one transaction: a failed comment rolls the claim back, so a later retry can still comment.

- [ ] **Step 8: Run the unit tests**

Run: `cd apps/api && bunx jest src/fleet/tickets`
Expected: PASS.

- [ ] **Step 9: Wire sync and the sweeper**

`sync.module.ts`: add `FleetTicketsModule` (from `'../tickets/fleet-tickets.module'`) to `imports`.

`sync.service.ts`: import `FleetJobTicketEffects` from `'../tickets/fleet-job-ticket.effects'`; append the constructor parameter `private readonly ticketEffects: FleetJobTicketEffects,`; replace `afterTerminal`:

```ts
  /** Evicts cached tokens; posts the attribution comment (spec §7.1); ticket effects (C9 §3.2). */
  protected async afterTerminal(jobIds: readonly string[]): Promise<void> {
    const ids = [...new Set(jobIds)];
    for (const id of ids) {
      this.broker.evict(id);
      void this.attribution.attribute(id); // fire-and-forget; never throws
    }
    if (ids.length > 0) void this.ticketEffects.onTerminal(ids); // fire-and-forget; never throws (D451)
  }
```

`fleet-sweeper.ts`: import `FleetJobTicketEffects`; append the constructor parameter `private readonly ticketEffects: FleetJobTicketEffects,` after `approvalLive`; next to `void this.attribution.attribute(id);` add:

```ts
        void this.ticketEffects.onTerminal([id]); // C9 §3.2; never throws
```

`fleet-sweeper.spec.ts`: every `new FleetSweeper(...)` gains a trailing argument; the two in the timer test get `{} as never`, the tick test gets `{ onTerminal: jest.fn() } as never` and asserts:

```ts
    expect(ticketEffects.onTerminal).toHaveBeenCalledWith([job.id]);
```

(declare `const ticketEffects = { onTerminal: jest.fn() };` above the construction and pass it).

- [ ] **Step 10: Write the terminal integration test**

`apps/api/test/integration/fleet/fleet-tickets-terminal.integration.spec.ts`:

```ts
/**
 * Fleet C9 slice 1a — failure comments on linked tickets (PG), spec §3.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-terminal.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetJobTicketEffects } from '../../../src/fleet/tickets/fleet-job-ticket.effects';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet ticket failure comments (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let effects: FleetJobTicketEffects;
  let n = 0;

  const linkedJob = async (state: string, extra: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => {
    n += 1;
    const ticket = await prisma.ticket.create({ data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' } });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `f${n}`, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state, leaseEpoch: 1, ...extra,
      },
    });
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: ticket.id } });
    return { job, ticket };
  };
  const comments = (ticketId: string) => prisma.comment.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    effects = app.get(FleetJobTicketEffects);
  });
  afterAll(async () => {
    await app.close();
  });

  it('comments once per attempt, again after a requeued attempt fails, and not for COMPLETED', async () => {
    const { job, ticket } = await linkedJob('ESCALATED', { escalationReason: 'quality review missing WALK' });
    await effects.onTerminal([job.id]);
    await effects.onTerminal([job.id]);
    expect((await comments(ticket.id)).map((c) => c.body)).toEqual([
      `Fleet RUN job ${job.id} ended ESCALATED: quality review missing WALK\n/web/fleet/jobs/${job.id}`,
    ]);
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'FAILED', leaseEpoch: 2, stateReason: 'exit 1' } });
    await effects.onTerminal([job.id]);
    expect(await comments(ticket.id)).toHaveLength(2);

    const done = await linkedJob('COMPLETED');
    await effects.onTerminal([done.job.id]);
    expect(await comments(done.ticket.id)).toHaveLength(0);
  });

  it('writes a null-author GENERAL comment and a live commented event', async () => {
    const seen: LiveEvent[] = [];
    const off = app.get(ProjectEventBus).subscribe(world.projectId, (e) => seen.push(e));
    const { job, ticket } = await linkedJob('CRASHED', { stateReason: 'runner silent' });
    await effects.onTerminal([job.id]);
    const [comment] = await comments(ticket.id);
    expect(comment).toEqual(expect.objectContaining({ type: 'GENERAL', authorUserId: null, authorAgentId: null }));
    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id, action: 'COMMENT_ADDED' } });
    expect(event).toEqual(expect.objectContaining({ actorId: world.ids.dev, actorType: 'user', source: 'internal' }));
    // The outbox relay delivers asynchronously; wait up to 5 s for the live event.
    for (let i = 0; i < 50 && !seen.some((e) => e.type === 'ticket'); i += 1) await new Promise((r) => setTimeout(r, 100));
    off();
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'ticket', action: 'commented' })]));
  });

  it('skips a ticket deleted after linking', async () => {
    const { job, ticket } = await linkedJob('FAILED', { stateReason: 'x' });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { deletedAt: new Date() } });
    await effects.onTerminal([job.id]);
    expect(await comments(ticket.id)).toHaveLength(0);
  });
});
```

If the outbox relay is disabled in the HTTP test app (check `bootHttpApp` / `OUTBOX_RELAY` config) and no `ticket` live event arrives, replace the live assertion with an assertion on the outbox row: `expect(await prisma.outboxMessage.count({ where: { type: 'ticket_event' } })).toBeGreaterThan(0)` using the outbox table name from `prisma/schema.prisma`.

- [ ] **Step 11: Run unit + integration**

```bash
cd apps/api && bunx jest src/fleet
bun run test:scoped test/integration/fleet/fleet-tickets-terminal.integration.spec.ts test/integration/fleet/fleet-sweep.integration.spec.ts test/integration/fleet/runner-sync-lifecycle.integration.spec.ts
```

Expected: all PASS; existing sweep and sync lifecycle suites unchanged.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/fleet apps/api/test/integration/fleet/fleet-tickets-terminal.integration.spec.ts
git commit -m "feat(fleet): failed, escalated and crashed jobs comment on linked tickets (C9 1a)"
```

---

### Task 6: Ticket fleet-jobs endpoints (list, unlink)

**Files:**
- Create: `apps/api/src/fleet/tickets/ticket-fleet-jobs.controller.ts`
- Modify: `apps/api/src/fleet/tickets/fleet-tickets.service.ts`, `fleet-tickets.service.spec.ts`, `fleet-tickets.module.ts`
- Modify: `apps/api/src/i18n/en/fleet.json`, `apps/api/src/i18n/zh/fleet.json`
- Test: `apps/api/test/integration/fleet/fleet-tickets-api.integration.spec.ts`

**Interfaces:**
- Consumes: Task 2 `findProject`, `findTicketByRef`, `findJobsForTicket`, `unlink`; Task 4 `FleetTicketEventRecorder`.
- Produces:
  - `FleetTicketsService.listForTicket(projectId: string, ref: string): Promise<TicketFleetJobDto[]>`
  - `FleetTicketsService.unlink(projectId: string, ref: string, jobId: string, actorId: string): Promise<void>`
  - Routes `GET /projects/:slug/tickets/:ref/fleet-jobs` (member), `DELETE /projects/:slug/tickets/:ref/fleet-jobs/:jobId` (DEVELOPER+, 204). Generated CLI functions (Task 7): `ticketFleetJobsControllerList`, `ticketFleetJobsControllerUnlink`.

- [ ] **Step 1: Add failing unit tests**

Append to `fleet-tickets.service.spec.ts`:

```ts
describe('FleetTicketsService list and unlink (C9 §2.2-§2.3)', () => {
  let repo: { findProject: jest.Mock; findTicketByRef: jest.Mock; findJobsForTicket: jest.Mock; unlink: jest.Mock };
  let events: { record: jest.Mock };
  let service: FleetTicketsService;
  const row = {
    id: 'j1', command: 'RUN', feature: 'f', state: 'COMPLETED', stateReason: null, escalationReason: null,
    resultBranch: 'feat/f', resultSha: 'a'.repeat(40), resultPrUrl: 'https://github.com/acme/app/pull/1',
    costSpentUsd: '0.5', costCarriedUsd: '0.25', queuedAt: new Date('2026-10-06T00:00:00Z'), finishedAt: null,
  };

  beforeEach(() => {
    repo = {
      findProject: jest.fn().mockResolvedValue({ key: 'WEB', slug: 'web' }),
      findTicketByRef: jest.fn().mockResolvedValue({ id: 't1' }),
      findJobsForTicket: jest.fn().mockResolvedValue([row]),
      unlink: jest.fn().mockResolvedValue(true),
    };
    events = { record: jest.fn() };
    service = new FleetTicketsService(repo as never, { run: (fn: () => unknown) => fn() } as never, events as never);
  });

  it('lists up to 50 jobs with the summed cost', async () => {
    const [dto] = await service.listForTicket('p', 'web-1');
    expect(repo.findTicketByRef).toHaveBeenCalledWith('p', 'WEB', 'web-1');
    expect(repo.findJobsForTicket).toHaveBeenCalledWith('t1', 50);
    expect(dto).toEqual(expect.objectContaining({ id: 'j1', costUsd: '0.75', queuedAt: '2026-10-06T00:00:00.000Z', finishedAt: null }));
  });

  it('404s for an unknown ticket', async () => {
    repo.findTicketByRef.mockResolvedValue(null);
    await expect(service.listForTicket('p', 'WEB-9')).rejects.toThrow();
  });

  it('unlinks and records TICKET_UPDATED; 404s when not linked', async () => {
    await service.unlink('p', 'WEB-1', 'j1', 'u1');
    expect(repo.unlink).toHaveBeenCalledWith('j1', 't1');
    expect(events.record).toHaveBeenCalledWith({ projectId: 'p', ticketId: 't1', action: 'TICKET_UPDATED', actorId: 'u1', data: { fleetJobUnlinked: 'j1' } });
    repo.unlink.mockResolvedValue(false);
    await expect(service.unlink('p', 'WEB-1', 'j1', 'u1')).rejects.toThrow();
  });
});
```

The earlier `describe` in this file constructs the service with two arguments; change it to pass a third `{} as never`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd apps/api && bunx jest src/fleet/tickets/fleet-tickets.service.spec.ts`
Expected: FAIL, "service.listForTicket is not a function".

- [ ] **Step 3: Implement**

In `fleet-tickets.service.ts`: add imports

```ts
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketFleetJobDto } from './dto/ticket-fleet-job.dto';
import { FleetTicketEventRecorder } from './fleet-ticket-event.recorder';
```

constructor becomes

```ts
  constructor(
    private readonly repo: PrismaFleetTicketsRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly events: FleetTicketEventRecorder,
  ) {}
```

and add

```ts
  static readonly LIST_LIMIT = 50;   // D460

  async listForTicket(projectId: string, ref: string): Promise<TicketFleetJobDto[]> {
    const ticketId = await this.ticketIdOf(projectId, ref);
    const rows = await this.repo.findJobsForTicket(ticketId, FleetTicketsService.LIST_LIMIT);
    return rows.map(TicketFleetJobDto.from);
  }

  /** D459: the join row and that job's fleet links on this ticket; history stays. */
  async unlink(projectId: string, ref: string, jobId: string, actorId: string): Promise<void> {
    const ticketId = await this.ticketIdOf(projectId, ref);
    await this.txManager.run(async () => {
      if (!(await this.repo.unlink(jobId, ticketId))) throw new NotFoundAppException({}, 'fleet.ticketJobs');
      await this.events.record({ projectId, ticketId, action: 'TICKET_UPDATED', actorId, data: { fleetJobUnlinked: jobId } });
    });
  }

  private async ticketIdOf(projectId: string, ref: string): Promise<string> {
    const project = await this.repo.findProject(projectId);
    const ticket = project ? await this.repo.findTicketByRef(projectId, project.key, ref) : null;
    if (!ticket) throw new NotFoundAppException({}, 'tickets');
    return ticket.id;
  }
```

`apps/api/src/fleet/tickets/ticket-fleet-jobs.controller.ts`:

```ts
import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CaslPermissionAction, Principal } from '@nathapp/nestjs-auth';
import { ForbiddenAppException, JsonResponse } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { isUserPrincipal } from '../../auth/principal/koda-principal.types';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ProjectPermission } from '../../projects/project-permission.decorator';
import { CurrentProject } from '../../projects/current-project.decorator';
import type { ProjectContext } from '../../projects/project-context';
import { TicketFleetJobDto } from './dto/ticket-fleet-job.dto';
import { FleetTicketsService } from './fleet-tickets.service';

/** Fleet C9 §2.2-§2.3: a ticket's fleet jobs. */
@ApiTags('fleet')
@ApiBearerAuth()
@ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
@ApiParam({ name: 'ref', required: true, schema: { type: 'string' } })
@Controller('projects/:slug/tickets/:ref/fleet-jobs')
@UseGuards(ProjectMembershipGuard)
export class TicketFleetJobsController {
  constructor(private readonly service: FleetTicketsService) {}

  @Get()
  @ApiOperation({ summary: 'Fleet jobs linked to a ticket, newest first, at most 50 (project member)' })
  @ApiResponse({ status: 200, type: [TicketFleetJobDto] })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async list(@Param('ref') ref: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal) {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    return JsonResponse.Ok(await this.service.listForTicket(ctx.project.id, ref));
  }

  @Delete(':jobId')
  @HttpCode(204)
  @ProjectPermission([CaslPermissionAction.CREATE, 'FleetJob'])
  @ApiOperation({ summary: 'Unlink a fleet job from a ticket (project DEVELOPER+); the PR and history stay' })
  @ApiResponse({ status: 204, description: 'Unlinked' })
  @ApiResponse({ status: 404, description: 'Ticket not found, or the job is not linked to it' })
  async unlink(@Param('ref') ref: string, @Param('jobId') jobId: string, @CurrentProject() ctx: ProjectContext, @Principal() principal: KodaPrincipal): Promise<void> {
    if (!isUserPrincipal(principal)) throw new ForbiddenAppException({}, 'projects');
    await this.service.unlink(ctx.project.id, ref, jobId, principal.id);
  }
}
```

Module: add `ProjectAccessModule` (from `'../../projects/project-access.module'`) to `imports` and `controllers: [TicketFleetJobsController]`.

i18n: in `apps/api/src/i18n/en/fleet.json` add `"ticketJobs": { "404": "This fleet job is not linked to the ticket" }`; in `zh/fleet.json` add `"ticketJobs": { "404": "该任务未关联到此工单" }`.

- [ ] **Step 4: Run unit tests**

Run: `cd apps/api && bunx jest src/fleet/tickets`
Expected: PASS.

- [ ] **Step 5: Write the API integration test**

`apps/api/test/integration/fleet/fleet-tickets-api.integration.spec.ts`:

```ts
/**
 * Fleet C9 slice 1a — GET/DELETE /projects/:slug/tickets/:ref/fleet-jobs (PG), spec §2.2-§2.3.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('ticket fleet jobs API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let ticketId: string;
  let jobId: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const url = (ref: string, job = '') => `/api/projects/web/tickets/${ref}/fleet-jobs${job ? `/${job}` : ''}`;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    const ticket = await prisma.ticket.create({ data: { projectId: world.projectId, number: 1, type: 'TASK', title: 'T1' } });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: 'f', profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED',
        resultBranch: 'feat/f', resultPrUrl: 'https://github.com/acme/app/pull/7', costSpentUsd: new Prisma.Decimal('0.5'),
      },
    });
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: ticket.id } });
    await prisma.ticketLink.create({
      data: { ticketId: ticket.id, url: 'https://github.com/acme/app/pull/7', provider: 'github', linkType: 'pr', source: 'fleet', jobId: job.id },
    });
    ticketId = ticket.id;
    jobId = job.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('lists the ticket\'s jobs for a viewer, by KEY-N in any case', async () => {
    const rows = data<Array<{ id: string; resultPrUrl: string; costUsd: string }>>(await request(server).get(url('web-1')).set(auth('viewer')).expect(200));
    expect(rows).toEqual([expect.objectContaining({ id: jobId, resultPrUrl: 'https://github.com/acme/app/pull/7', costUsd: '0.5' })]);
  });

  it('refuses outsiders and unknown tickets', async () => {
    await request(server).get(url('WEB-1')).set(auth('outsider')).expect(403);
    await request(server).get(url('WEB-404')).set(auth('viewer')).expect(404);
  });

  it('lets only DEVELOPER+ unlink; unlink removes the fleet PR link; a second unlink is 404', async () => {
    await request(server).delete(url('WEB-1', jobId)).set(auth('viewer')).expect(403);
    await request(server).delete(url('WEB-1', jobId)).set(auth('dev')).expect(204);
    expect(await prisma.fleetJobTicket.count({ where: { ticketId } })).toBe(0);
    expect(await prisma.ticketLink.count({ where: { ticketId } })).toBe(0);
    expect(await prisma.fleetJob.count({ where: { id: jobId } })).toBe(1);
    await request(server).delete(url('WEB-1', jobId)).set(auth('dev')).expect(404);
    expect(data<unknown[]>(await request(server).get(url('WEB-1')).set(auth('viewer')).expect(200))).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it**

Run: `cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-api.integration.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/fleet/tickets apps/api/src/i18n apps/api/test/integration/fleet/fleet-tickets-api.integration.spec.ts
git commit -m "feat(fleet): list and unlink a ticket's fleet jobs (C9 1a)"
```

---

### Task 7: Contract regeneration and CLI

**Files:**
- Modify (generated): `openapi.json`, `apps/cli/src/generated/*`
- Modify: `apps/cli/src/commands/fleet-dispatch.ts:19-57,73-90`, `apps/cli/src/commands/fleet-dispatch.spec.ts`
- Modify: `apps/cli/src/commands/ticket.ts` (`show <ref>` action)
- Create: `apps/cli/src/commands/ticket-fleet-runs.spec.ts`

**Interfaces:**
- Consumes: Task 3 `ticketRefs`; Task 6 `ticketFleetJobsControllerList` (generated name: confirm in `apps/cli/src/generated/sdk.gen.ts` after Step 1 and use the name it shows).
- Produces: `koda fleet dispatch --ticket <REF>` (repeatable); `koda ticket show <REF>` prints a "Fleet runs" section; `--json` output of `ticket show` gains `fleetJobs`. Existing `ticket show` specs mock `../generated` without the new function, so the lookup must fall back to `[]` (they keep passing unchanged).

- [ ] **Step 1: Regenerate the contract**

Run: `bun run generate` (repo root)
Expected: `openapi.json` and `apps/cli/src/generated/` change (new `ticketRefs`, `tickets`, `TicketFleetJobDto`, the two new operations). Run `grep -n "ticketFleetJobsController" apps/cli/src/generated/sdk.gen.ts` and note the exported names.

- [ ] **Step 2: Write the failing CLI tests**

Append inside `describe('koda fleet dispatch', ...)` in `apps/cli/src/commands/fleet-dispatch.spec.ts` (it already mocks `fleetJobsControllerDispatch` and defines `run`, `job`, `repo`):

```ts
  it('sends repeated --ticket values as ticketRefs', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job(), placement: { assigned: false, runnerId: null, misfits: [] } } });
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5', '--ticket', 'web-1', '--ticket', 'WEB-2');
    expect(fleetJobsControllerDispatch).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ ticketRefs: ['web-1', 'WEB-2'] }),
    }));
  });

  it('omits ticketRefs without --ticket', async () => {
    (fleetJobsControllerDispatch as jest.Mock).mockResolvedValue({ ret: 0, data: { job: job(), placement: { assigned: false, runnerId: null, misfits: [] } } });
    await run('--repo', 'acme/app', '--feature', 'login', '--max-cost', '5');
    expect((fleetJobsControllerDispatch as jest.Mock).mock.calls[0][0].body).not.toHaveProperty('ticketRefs');
  });
```

Create `apps/cli/src/commands/ticket-fleet-runs.spec.ts` (replace `ticketFleetJobsControllerList` with the generated name from Step 1 if it differs):

```ts
jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s }, gray: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
}));
const mockStore = { get: jest.fn(() => ''), set: jest.fn() };
jest.mock('conf', () => jest.fn(() => mockStore));
jest.mock('../generated', () => ({
  ticketsControllerFindByRef: jest.fn(),
  ticketFleetJobsControllerList: jest.fn(),
}));
jest.mock('../config', () => ({ resolveContext: jest.fn() }));

import { Command } from 'commander';
import { ticketCommand } from './ticket';
import { ticketFleetJobsControllerList, ticketsControllerFindByRef } from '../generated';
import { resolveContext } from '../config';

const TICKET = { id: 't1', number: 1, ref: 'WEB-1', type: 'TASK', title: 'T', status: 'IN_PROGRESS', createdAt: '', updatedAt: '', links: [] };
const FLEET_JOB = {
  id: 'j1', command: 'RUN', feature: 'f', state: 'ESCALATED', escalationReason: 'review blocked', stateReason: null,
  resultBranch: 'feat/f', resultSha: 'abcdef1234', resultPrUrl: 'https://github.com/acme/app/pull/7',
  costUsd: '0.75', queuedAt: '2026-10-06T00:00:00.000Z', finishedAt: null,
};

describe('koda ticket show: fleet runs (C9 §5)', () => {
  let program: Command;
  let logSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  const show = (...a: string[]) =>
    program.commands.find((c) => c.name() === 'ticket')?.commands.find((c) => c.name() === 'show')?.parseAsync(['node', 'test', ...a]);
  const out = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

  beforeEach(() => {
    program = new Command();
    ticketCommand(program);
    (resolveContext as jest.Mock).mockResolvedValue({ projectSlug: 'web', apiKey: 'sk-test-key123', apiUrl: 'http://localhost/api' });
    (ticketsControllerFindByRef as jest.Mock).mockResolvedValue({ ret: 0, data: TICKET });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('prints a Fleet runs section', async () => {
    (ticketFleetJobsControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: [FLEET_JOB] });
    await show('WEB-1');
    expect(ticketFleetJobsControllerList).toHaveBeenCalledWith({ path: { slug: 'web', ref: 'WEB-1' } });
    expect(out()).toContain('Fleet runs:');
    expect(out()).toContain('  - RUN f ESCALATED j1 $0.75');
    expect(out()).toContain('    branch feat/f @ abcdef1');
    expect(out()).toContain('    PR https://github.com/acme/app/pull/7');
    expect(out()).toContain('    reason: review blocked');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('adds fleetJobs to --json output', async () => {
    (ticketFleetJobsControllerList as jest.Mock).mockResolvedValue({ ret: 0, data: [FLEET_JOB] });
    await show('--json', 'WEB-1');
    expect(JSON.parse(out()).fleetJobs).toEqual([FLEET_JOB]);
  });

  it('still shows the ticket when the fleet runs lookup fails', async () => {
    (ticketFleetJobsControllerList as jest.Mock).mockRejectedValue(new Error('boom'));
    await show('WEB-1');
    expect(out()).not.toContain('Fleet runs:');
    expect(out()).toContain('Title: T');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `cd apps/cli && bunx jest src/commands/fleet-dispatch.spec.ts src/commands/ticket-fleet-runs.spec.ts`
Expected: FAIL (commander rejects unknown option `--ticket`; no "Fleet runs:" output).

- [ ] **Step 4: Implement `--ticket`**

In `fleet-dispatch.ts`: add `ticket: string[];` to `DispatchOptions`; add the option after `--pin`:

```ts
    .option('--ticket <ref>', 'Ticket this job works on (KEY-N), repeatable; a RUN moves CREATED/VERIFIED tickets to IN_PROGRESS', collect, [] as string[])
```

and in `buildBody`'s returned object:

```ts
    ...(o.ticket.length > 0 ? { ticketRefs: o.ticket } : {}),
```

- [ ] **Step 5: Implement "Fleet runs" in `ticket show`**

In `ticket.ts`, add `ticketFleetJobsControllerList` to the existing `../generated` import and `TicketFleetJobDto` to the type import. Add above `ticketCommand`:

```ts
const FAILED_STATES = new Set(['FAILED', 'ESCALATED', 'CRASHED']);

/**
 * Fleet C9 §5: the ticket's fleet jobs. A courtesy section: any failure (an older API without the
 * endpoint, a network error) shows the ticket without it rather than failing `ticket show`.
 */
async function fleetJobsOf(slug: string, ref: string): Promise<TicketFleetJobDto[]> {
  try {
    return unwrap<TicketFleetJobDto[]>(await ticketFleetJobsControllerList({ path: { slug, ref } })) ?? [];
  } catch {
    return [];
  }
}

function printFleetRuns(jobs: readonly TicketFleetJobDto[]): void {
  if (jobs.length === 0) return;
  console.log(`\nFleet runs:`);
  for (const job of jobs) {
    console.log(`  - ${job.command} ${job.feature} ${job.state} ${job.id} $${job.costUsd}`);
    if (job.resultBranch) console.log(`    branch ${job.resultBranch}${job.resultSha ? ` @ ${job.resultSha.slice(0, 7)}` : ''}`);
    if (job.resultPrUrl) console.log(`    PR ${job.resultPrUrl}`);
    const reason = job.escalationReason ?? job.stateReason;
    if (reason && FAILED_STATES.has(job.state)) console.log(`    reason: ${reason}`);
  }
}
```

In the `show <ref>` action, after `const ticketData = unwrap<TicketDetail>(response);` add `const fleetJobs = await fleetJobsOf(ctx.projectSlug, ref);`, change the JSON branch to `console.log(JSON.stringify({ ...ticketData, fleetJobs }, null, 2));`, and call `printFleetRuns(fleetJobs);` as the last statement of the human-readable branch.

- [ ] **Step 6: Run the CLI tests and the contract check**

```bash
cd apps/cli && bunx jest src/commands
cd ../.. && git add openapi.json apps/cli/src/generated && bun run generate && git diff --exit-code -- openapi.json apps/cli/src/generated
```

Expected: CLI tests PASS (the existing `ticket show` specs included); the second `generate` leaves no unstaged diff.

- [ ] **Step 7: Commit**

```bash
git add openapi.json apps/cli
git commit -m "feat(cli): fleet dispatch --ticket and fleet runs in ticket show (C9 1a)"
```

---

### Task 8: Repo-wide verification and PR

**Files:** none new.

- [ ] **Step 1: Repo-wide gates**

```bash
bun run type-check && bun run lint && bun run test
cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet
```

Expected: all green. Fix any failure in the task that owns the file, then re-run.

- [ ] **Step 2: Whitespace and contract**

```bash
git diff --check main...HEAD
bun run generate && git diff --exit-code
```

Expected: no output; no diff.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/fleet-c9-ticket-work-products
gh pr create --title "feat(fleet): C9 slice 1a — ticket links, dispatch and lifecycle" --body "$(cat <<'EOF'
## What

Fleet C9 slice 1a (spec `docs/superpowers/specs/2026-10-06-fleet-c9-ticket-work-products-design.md`, plan `docs/superpowers/plans/2026-10-06-fleet-c9-slice-1a-ticket-links.md`): a fleet job can be dispatched for one or more tickets.

## How

- Migration `20261006120000_fleet_ticket_work_products`: `FleetJobTicket(jobId, ticketId, notifiedEpoch)`, `TicketLink.source` (default `vcs`) + `jobId`.
- Dispatch takes `ticketRefs` (max 20, 400 naming a bad ref), linked in the dispatch transaction; job detail returns `tickets` (null on lists).
- A RUN dispatch moves linked CREATED/VERIFIED tickets to IN_PROGRESS as the requester; PLAN moves none.
- FAILED / ESCALATED / CRASHED jobs leave one system comment per attempt on each linked ticket (claimed by `notifiedEpoch`), from sync and the sweeper.
- `GET/DELETE /projects/:slug/tickets/:ref/fleet-jobs`; unlink also drops that job's fleet PR links.
- CLI `koda fleet dispatch --ticket`, `koda ticket show` "Fleet runs".

Slice 1b (fleet PR links, PR-state refresher, repo-scoped VCS matching) and slice 2 (web) follow.

## Verification

- type-check, lint, unit tests, fleet integration suite (PG) green; `bun run generate` clean.
EOF
)"
```

Do not merge; the user reviews the PR.
