/**
 * Permissions P3 (US-005) — the budget command through the engine: raise and resume, then re-queue.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-budget-override-command.integration.spec.ts
 */
import { canRunDbTests } from '../../helpers/test-environment';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { budgetReason } from '../../../src/fleet/budgets/budget-rules';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';

const integration = canRunDbTests() ? describe : describe.skip;
const now = new Date('2026-11-10T09:00:00Z');
/** The ask opened a minute before the decide; the candidate's `finishedAt` is inside that window. */
const requestedAt = new Date(now.getTime() - 60_000);

integration('fleet budget override command through ApprovalDecisionService', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let service: ApprovalDecisionService;
  let projectId: string;
  let repoId: string;
  let policyId: string;
  let candidateId: string;
  let requestId: string;
  let n = 0;
  const userId = 'budget-approver';

  const policy = () => db.budgetPolicy.create({
    data: {
      scopeType: 'project', scopeId: projectId, scopeKey: `project:${projectId}`, projectId,
      windowKind: 'lifetime', amountUsd: new Prisma.Decimal(10), warnPercent: null,
      pausedAt: new Date('2026-11-01T00:00:00Z'), pausedWindowStart: new Date(0),
      createdById: userId, updatedById: userId,
    },
  });
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => db.fleetJob.create({
    data: {
      projectId, repoId, ref: 'main', command: 'RUN', feature: `bo${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: userId, ...over,
    },
  });

  /** One paused policy with 10 spent, one cancelled candidate and its pending budget ask. */
  const seedWorld = async () => {
    const created = await policy();
    policyId = created.id;
    await job({ state: 'COMPLETED', costSpentUsd: new Prisma.Decimal(10), startedAt: requestedAt, finishedAt: requestedAt, firstStartedAt: requestedAt });
    candidateId = (await job({
      state: 'CANCELLED', cancelReason: budgetReason(policyId), startedAt: null, finishedAt: requestedAt,
    })).id;
    requestId = (await seedFleetAsk(db, {
      kind: 'budget', projectId, expiresAt: new Date('2030-01-01T00:00:00Z'),
      input: {
        policyId, scopeType: 'project', scopeId: projectId, windowKind: 'lifetime',
        windowStart: '1970-01-01T00:00:00.000Z', spentUsd: '10', amountUsd: '10', requestedAt: requestedAt.toISOString(),
      },
      link: { budgetPolicyId: policyId },
    })).requestId;
  };
  const approve = (params: unknown) =>
    withTestActor({ type: 'USER', id: userId }, () => service.decide(requestId, 'approve', null, now, params));
  const link = () => db.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } });
  const policyRow = () => db.budgetPolicy.findUniqueOrThrow({ where: { id: policyId } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    await db.user.create({ data: { id: userId, email: `${userId}@koda.test`, passwordHash: 'x' } });
    const project = await db.project.create({ data: { name: 'Budget overrides', slug: 'budget-overrides', key: 'BOV' } });
    projectId = project.id;
    repoId = (await db.fleetRepo.create({ data: {
      projectId, provider: 'github', owner: 'acme', name: 'budget', defaultBranch: 'main', createdById: userId,
    } })).id;
    await grantKeys(db, { type: 'USER', id: userId }, ['fleet.budget.override', 'approval.decide@fleet.budget.override'], projectId);
    service = app.get(ApprovalDecisionService, { strict: false });
  });

  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.fleetJob.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.budgetPolicy.deleteMany();
    await db.auditEntry.deleteMany();
    await seedWorld();
  });

  it('AC-8/9/15: raises and resumes the policy, stamps the incident, audits and stores the result', async () => {
    const settled = await approve({ amountUsd: 20 });

    const after = await policyRow();
    expect({ amountUsd: after.amountUsd.toString(), pausedAt: after.pausedAt }).toEqual({ amountUsd: '20', pausedAt: null });
    // AC-9 says one incident: nothing in the schema (no unique index on policyId + kind) stops a second,
    // so this asserts the resume wrote exactly one rather than merely that one matching row exists.
    const resumed = await db.budgetIncident.findMany({ where: { policyId, kind: 'resumed' } });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ actorId: userId, approvalId: requestId });
    const audited = await db.auditEntry.findMany({ where: { key: 'fleet.budget.override', resourceId: requestId } });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ key: 'fleet.budget.override', summary: 'raised to 20 and resumed', approvalRequestId: requestId });
    expect(settled).toMatchObject({ status: 'executed', result: { resumedAmountUsd: '20' } });
  });

  it('AC-10: re-queues the named candidate and records it in the link outcome', async () => {
    await approve({ amountUsd: 20, requeueJobIds: [candidateId] });

    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: candidateId } })).state).toBe('QUEUED');
    expect((await link()).outcome).toEqual({ resumedAmountUsd: '20', requeueResults: [{ jobId: candidateId, ok: true }] });
  });

  it('AC-11: an id that is not a candidate is refused and nothing is re-queued', async () => {
    await approve({ amountUsd: 20, requeueJobIds: ['not-a-job'] });

    expect((await link()).outcome).toEqual({
      resumedAmountUsd: '20',
      requeueResults: [{ jobId: 'not-a-job', ok: false, error: 'not a re-queue candidate' }],
    });
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: candidateId } })).state).toBe('CANCELLED');
  });

  it('AC-12: an amount not above the window spend fails the request and leaves the policy paused', async () => {
    const settled = await approve({ amountUsd: 5 });

    // The spend refusal is what failed it: `BudgetsService.resume`'s ValidationAppException, not a missing command.
    expect(settled).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'ValidationAppException' } });
    const after = await policyRow();
    expect({ amountUsd: after.amountUsd.toString(), pausedAt: after.pausedAt === null }).toEqual({ amountUsd: '10', pausedAt: false });
    expect(await db.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } })).toMatchObject({ outcome: null });
  });

  it('AC-13: approving after the policy was deleted fails the request', async () => {
    await db.budgetPolicy.delete({ where: { id: policyId } });

    expect(await approve({ amountUsd: 20 }))
      .toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'ConflictAppException' } });
  });
});
