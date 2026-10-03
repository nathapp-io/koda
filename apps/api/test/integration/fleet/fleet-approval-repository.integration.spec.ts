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
import type { ApprovalResolution, NewFleetApproval } from '../../../src/fleet/approvals/domain/approval.domain';

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
    // A second pending approval on another policy, so "the pending one per policy" is a real reading:
    // `findPendingForPolicy` has to filter by policy, not just find any pending row.
    const other = await budget({ policyId: 'other' });
    expect((await repo.findPendingForPolicy('other'))?.id).toBe(other.id);
    expect((await repo.findPendingForPolicy('pol'))?.id).toBe(a.id);
    const resolved = await tx.run(async () => {
      expect((await repo.lockById(a.id))?.id).toBe(a.id);
      return repo.resolve(a.id, { status: 'rejected', resolvedBy: 'user', decidedAt: T0, decision: 'keep_paused', decidedById: world.ids.root, comment: 'no' });
    });
    expect(resolved).toEqual(expect.objectContaining({ status: 'rejected', decision: 'keep_paused', resolvedBy: 'user', comment: 'no' }));
    expect(resolved.outcome).toBeNull();
    expect(await repo.findPendingForPolicy('pol')).toBeNull();
    // The other policy's approval is untouched by pol's resolution.
    expect((await repo.findPendingForPolicy('other'))?.id).toBe(other.id);
    expect((await repo.setOutcome(a.id, { requeueResults: [] })).outcome).toEqual({ requeueResults: [] });
    expect(await tx.run(() => repo.lockById('missing'))).toBeNull();
  });

  it('resolve: outcome omitted keeps it, an object writes it, an explicit null clears it', async () => {
    const decided: ApprovalResolution = { status: 'approved', resolvedBy: 'user', decidedAt: T0 };

    // Omitted outcome leaves the column alone (ApprovalCloser.closeForPolicy relies on this).
    const kept = await budget({ policyId: 'k' });
    await repo.setOutcome(kept.id, { resumedAmountUsd: '5' });
    expect((await repo.resolve(kept.id, {
      ...decided, decision: 'raise_budget_and_resume', decidedById: world.ids.root, comment: 'ok',
    })).outcome).toEqual({ resumedAmountUsd: '5' });

    // Omitted decision fields zero the columns rather than being left as they were.
    expect(await repo.resolve(kept.id, decided)).toEqual(expect.objectContaining({
      outcome: { resumedAmountUsd: '5' }, decision: null, decidedById: null, comment: null,
    }));

    const cleared = await budget({ policyId: 'j' });
    await repo.setOutcome(cleared.id, { resumedAmountUsd: '5' });
    expect((await repo.resolve(cleared.id, { ...decided, outcome: null })).outcome).toBeNull();

    const stamped = await budget({ policyId: 'i' });
    expect((await repo.resolve(stamped.id, {
      ...decided, outcome: { resumedAmountUsd: '7', requeueResults: [] },
    })).outcome).toEqual({ resumedAmountUsd: '7', requeueResults: [] });
  });

  it('pages newest first with filters', async () => {
    const old = await budget({ policyId: 'a', requestedAt: T0 });
    const recent = await budget({ policyId: 'b', requestedAt: new Date(T0.getTime() + 60_000) });
    await budget({ policyId: 'c', projectId: null });
    const page = await repo.findPage({ projectId: world.projectId }, { current: 1, size: 10 });
    expect(page.records.map((r) => r.id)).toEqual([recent.id, old.id]);
    expect((await repo.findPage({ status: 'pending' }, { current: 1, size: 10 })).total).toBe(3);
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
    await job({ state: 'QUEUED' });                                       // already requeued: `state` alone excludes it
    const rows = await repo.findRequeueCandidates('pol', T0, 10);
    expect(rows.map((r) => r.jobId)).toEqual([a.id, b.id]);
    expect(rows[1]).toEqual(expect.objectContaining({ projectId: world.opsProjectId, feature: b.feature }));
    expect(await repo.findRequeueCandidates('pol', T0, 1)).toHaveLength(1);

    // A queuedAt tie falls back to ascending id; the ids are sorted here, so no cuid order is assumed.
    const tie = await job({ queuedAt: a.queuedAt });
    expect((await repo.findRequeueCandidates('pol', T0, 10)).map((r) => r.jobId))
      .toEqual([...([a.id, tie.id].sort()), b.id]);
  });

  it('finds a project slug', async () => {
    expect(await repo.findProjectSlug(world.projectId)).toBe('web');
    expect(await repo.findProjectSlug('missing')).toBeNull();
  });
});

describe('bash lookups (S1.5 2a)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let repo: PrismaApprovalRepository;
  let n = 0;
  const T0 = new Date('2026-10-02T10:00:00.000Z');
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `rp${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'CANCELLED',
      cancelReason: 'budget:pol', startedAt: null, finishedAt: new Date(T0.getTime() + 1_000), queuedAt: new Date(T0.getTime() + n), ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    repo = app.get(PrismaApprovalRepository);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  let projectId!: string;
  let jobId!: string;
  beforeEach(async () => { projectId = world.projectId; jobId = (await job()).id; });
  const bash = (over: Partial<NewFleetApproval> = {}): NewFleetApproval => ({
    type: 'nax_bash_escalate', projectId, policyId: null, jobId, leaseEpoch: 1, naxAskId: 'ask-a', payload: {},
    requestedAt: new Date('2026-10-04T10:00:00Z'), expiresAt: new Date('2026-10-04T10:10:00Z'), ...over,
  });

  it('finds by ask, lists pending for a job, finds expired, counts by job', async () => {
    const a = await repo.create(bash());
    await repo.create(bash({ naxAskId: 'ask-b', expiresAt: new Date('2026-10-04T10:01:00Z') }));
    const c = await repo.create(bash({ naxAskId: 'ask-c' }));
    await repo.resolve(c.id, { status: 'cancelled', resolvedBy: 'job_ended', decidedAt: new Date() });

    expect((await repo.findByAsk(jobId, 1, 'ask-a'))?.id).toBe(a.id);
    expect(await repo.findByAsk(jobId, 2, 'ask-a')).toBeNull();
    expect((await repo.findPendingForJob(jobId)).map((r) => r.naxAskId)).toEqual(['ask-a', 'ask-b']);
    expect((await repo.findExpiredPending(new Date('2026-10-04T10:05:00Z'), 10)).map((r) => r.naxAskId)).toEqual(['ask-b']);
    expect(await repo.countPendingByJob([jobId, 'nope'])).toEqual(new Map([[jobId, 2]]));
    expect(await repo.countPendingByJob([])).toEqual(new Map());
  });
});
