import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P3 (US-002) — the fleet ask read model on PG: the typed store facade over
 * `ApprovalRequest` + `FleetApprovalAsk`, its status predicate, its pending groupings and the
 * re-queue candidates it moved off the legacy repository.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ask-read-model.integration.spec.ts
 */
import { Logger } from '@nestjs/common';
import { NathApplication } from '@nathapp/nestjs-app';
import type { Mock } from 'vitest';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FleetJobState } from '../../../src/common/enums';
import { budgetReason } from '../../../src/fleet/budgets/budget-rules';
import { FleetApprovalAskStore } from '../../../src/fleet/approvals/fleet-approval-ask.store';
import { MAX_COUNTED_PROJECTS } from '../../../src/fleet/approvals/domain/fleet-approval-ask.domain';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedFleetAsk, type SeedFleetAskSpec } from '../../helpers/fleet-ask-fixtures';
import { fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeDb = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 20_000 });

describeDb('fleet ask read model (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let store: FleetApprovalAskStore;
  let n = 0;
  const T0 = new Date('2026-10-04T10:00:00.000Z');
  const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);
  const POLICY_15 = 'policy-15';

  /** The bash ask input US-003 parses. */
  const bashInput = (jobId: string, naxAskId: string, payload: Record<string, unknown> = { command: 'ls', options: ['allow'] }) =>
    ({ jobId, leaseEpoch: 1, naxAskId, payload });
  /** The budget ask input US-005 parses. */
  const budgetInput = (policyId: string, projectId: string | null) => ({
    policyId, scopeType: projectId === null ? 'global' : 'project', scopeId: projectId, windowKind: 'day',
    windowStart: '2026-10-04T00:00:00.000Z', spentUsd: '10.5', amountUsd: '20', requestedAt: '2026-10-04T09:00:00.000Z',
  });

  const bashAsk = (over: Partial<SeedFleetAskSpec> = {}) => {
    const jobId = over.link?.jobId ?? `job-${++n}`;
    const naxAskId = over.link?.naxAskId ?? `ask-${n}`;
    return seedFleetAsk(prisma, {
      ...over,
      kind: 'bash',
      projectId: over.projectId === undefined ? world.projectId : over.projectId,
      input: over.input ?? bashInput(jobId, naxAskId),
      link: { jobId, leaseEpoch: 1, naxAskId, ...over.link },
    });
  };
  const budgetAsk = (over: Partial<SeedFleetAskSpec> = {}) => {
    const projectId = over.projectId === undefined ? world.projectId : over.projectId;
    const policyId = over.link?.budgetPolicyId ?? `policy-${++n}`;
    return seedFleetAsk(prisma, {
      ...over,
      kind: 'budget',
      projectId,
      input: over.input ?? budgetInput(policyId, projectId),
      link: { budgetPolicyId: policyId, ...over.link },
    });
  };
  /** A link the fleet resumed by hand: the user who did it rides in the outcome. */
  const resumeLink = () => ({ resolvedBy: 'manual_resume' as const, outcome: { resumedById: world.ids.root } });

  /** A cancelled-before-start job the policy may offer back for re-queue. */
  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `ask${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: FleetJobState.CANCELLED,
      cancelReason: budgetReason(POLICY_15), startedAt: null, finishedAt: at(100), queuedAt: at(n), ...over,
    },
  });
  /** A request the fleet readers must ignore: a fleet key, but no link. */
  const linklessAsk = async (): Promise<string> => {
    const { requestId } = await bashAsk();
    await prisma.fleetApprovalAsk.delete({ where: { requestId } });
    return requestId;
  };
  /** A non-fleet request in the project: it is not a fleet ask, whatever its status. */
  const ticketDeleteRequest = (correlationId: string) => prisma.approvalRequest.create({
    data: {
      permissionKey: 'ticket.delete', projectId: world.projectId, actorType: 'USER', actorId: world.ids.dev, origin: 'rest',
      correlationId, input: { ticketId: 'ticket-1' }, inputHash: `hash-${correlationId}`, requiredMode: 'human', onTimeout: 'reject',
      approverMustHoldAction: true, requireDistinctApprover: false, status: 'pending', expiresAt: at(3_600), createdAt: at(50),
    },
    select: { id: true },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    store = app.get(FleetApprovalAskStore);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('AC-9: findPage approved answers exactly the executed user-resolved bash ask and the manual-resume budget ask', async () => {
    const executed = await bashAsk({
      status: 'executed', createdAt: at(10), settledAt: at(200),
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'approve', params: { choice: 'allow' }, decidedAt: at(150) }],
    });
    const resumed = await budgetAsk({ status: 'cancelled', createdAt: at(20), link: resumeLink() });
    // Not approved: pending, a job-ended close of an executed ask, a plain rejection, and a link-less ask.
    await bashAsk({ createdAt: at(30) });
    await bashAsk({
      status: 'executed', createdAt: at(40), link: { resolvedBy: 'job_ended' },
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'approve' }],
    });
    await bashAsk({ status: 'rejected', createdAt: at(50), decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'reject' }] });
    const linkless = await linklessAsk();

    const page = await store.findPage({ status: 'approved' }, { current: 1, size: 10 });

    expect(page.records.map((r) => r.id)).toEqual([resumed.requestId, executed.requestId]);
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.status)).toEqual(['approved', 'approved']);
    expect(page.records.map((r) => r.id)).not.toContain(linkless);
  });

  it('AC-10: findPage cancelled answers exactly the two job-ended asks, the failed ask and the superseded ask', async () => {
    const jobEndedExecuted = await bashAsk({
      status: 'executed', createdAt: at(10), link: { resolvedBy: 'job_ended' },
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'approve' }],
    });
    const jobEndedRejected = await bashAsk({
      status: 'rejected', createdAt: at(20), link: { resolvedBy: 'job_ended' },
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'reject' }],
    });
    const failed = await bashAsk({ status: 'failed', createdAt: at(30), settledAt: at(300) });
    const superseded = await budgetAsk({ status: 'approved', createdAt: at(40), link: { resolvedBy: 'superseded' } });
    // Not cancelled: the pending ask and the manual-resume budget ask.
    await bashAsk({ createdAt: at(50) });
    await budgetAsk({ status: 'cancelled', createdAt: at(60), link: resumeLink() });

    const page = await store.findPage({ status: 'cancelled' }, { current: 1, size: 10 });

    expect(page.records.map((r) => r.id)).toEqual([
      superseded.requestId, failed.requestId, jobEndedRejected.requestId, jobEndedExecuted.requestId,
    ]);
    expect(page.records.map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    expect(page.total).toBe(4);
  });

  it('AC-11: findPage by type and job answers that job\'s two bash asks newest first, and no other request', async () => {
    const older = await bashAsk({ createdAt: at(10), link: { jobId: 'job-11', naxAskId: 'ask-11-old' } });
    const newer = await bashAsk({ createdAt: at(20), link: { jobId: 'job-11', naxAskId: 'ask-11-new' } });
    await bashAsk({ createdAt: at(30), link: { jobId: 'job-11-other', naxAskId: 'ask-11-other' } });
    const budget = await budgetAsk({ createdAt: at(40) });
    await linklessAsk();
    const ticketDelete = await ticketDeleteRequest('corr-11');

    const page = await store.findPage({ type: 'nax_bash_escalate', jobId: 'job-11' }, { current: 1, size: 10 });

    expect(page.records.map((r) => r.id)).toEqual([newer.requestId, older.requestId]);
    expect(page.total).toBe(2);
    const ids = page.records.map((r) => r.id);
    expect(ids).not.toContain(ticketDelete.id);
    expect(ids).not.toContain(budget.requestId);
    expect(page.records[0]).toEqual(expect.objectContaining({
      type: 'nax_bash_escalate', jobId: 'job-11', leaseEpoch: 1, naxAskId: 'ask-11-new',
    }));
  });

  it('AC-12: countPending answers each project\'s pending fleet asks in slug order, settled ones uncounted', async () => {
    await bashAsk();
    await budgetAsk();
    await bashAsk({ projectId: world.opsProjectId });
    await bashAsk({
      projectId: world.opsProjectId, status: 'executed',
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'approve' }],
    });
    await linklessAsk();

    expect(await store.countPending([world.projectId, world.opsProjectId])).toEqual([
      { projectId: world.opsProjectId, slug: 'ops', pending: 1 },
      { projectId: world.projectId, slug: 'web', pending: 2 },
    ]);
    expect(await store.countPending([])).toEqual([]);
    expect(await store.countPending(['missing'])).toEqual([]);
  });

  it('AC-13: countPendingByJob groups the pending links of the job ids it is given', async () => {
    await bashAsk({ link: { jobId: 'job-13-a', naxAskId: 'ask-13-a' } });
    await bashAsk({ link: { jobId: 'job-13-a', naxAskId: 'ask-13-b' } });
    await bashAsk({
      status: 'rejected', link: { jobId: 'job-13-b', naxAskId: 'ask-13-c' },
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'reject' }],
    });
    await bashAsk({ link: { jobId: 'job-13-c', naxAskId: 'ask-13-d' } });

    expect(await store.countPendingByJob(['job-13-a', 'job-13-b'])).toEqual(new Map([['job-13-a', 2]]));
    expect(await store.countPendingByJob(['job-13-c'])).toEqual(new Map([['job-13-c', 1]]));
    expect(await store.countPendingByJob([])).toEqual(new Map());
  });

  it('AC-14: countPendingUnscoped counts the pending asks no project owns', async () => {
    await budgetAsk({ projectId: null });
    await budgetAsk();

    expect(await store.countPendingUnscoped()).toBe(1);
  });

  it('AC-15: findRequeueCandidates offers the policy\'s cancelled-before-start jobs since the ask, oldest first', async () => {
    const oldest = await job({ queuedAt: at(10) });
    const next = await job({ projectId: world.opsProjectId, repoId: world.foreignRepoId, queuedAt: at(20) });
    await job({ startedAt: at(30) });                                         // was running: not offered
    await job({ cancelReason: budgetReason('policy-other') });                 // another policy
    await job({ cancelReason: null });                                         // a user cancel
    await job({ finishedAt: at(-1) });                                         // before this ask
    await job({ state: FleetJobState.QUEUED });                                // already re-queued

    const rows = await store.findRequeueCandidates(POLICY_15, T0, 10);

    expect(rows.map((r) => r.jobId)).toEqual([oldest.id, next.id]);
    expect(rows[1]).toEqual(expect.objectContaining({ projectId: world.opsProjectId, feature: next.feature, queuedAt: at(20) }));
    expect(await store.findRequeueCandidates(POLICY_15, T0, 1)).toHaveLength(1);
  });

  it('every status filter answers exactly the rows the mapper gives that status, over every combination', async () => {
    const requestStatuses = ['pending', 'approved', 'executed', 'rejected', 'expired', 'cancelled', 'failed'] as const;
    const resolutions = [null, 'user', 'timeout', 'manual_resume', 'job_ended', 'superseded', 'policy_deleted', 'window_reset'] as const;
    let seconds = 0;
    for (const status of requestStatuses) {
      for (const resolvedBy of resolutions) {
        await bashAsk({ status, createdAt: at(++seconds), settledAt: at(seconds + 1_000), link: { resolvedBy } });
      }
    }
    const everyAsk = await store.findPage({}, { current: 1, size: 100 });
    expect(everyAsk.total).toBe(requestStatuses.length * resolutions.length);

    // What the mapper says, per status, is the only expectation the filters may answer.
    const byStatus = new Map<string, string[]>();
    for (const row of everyAsk.records) byStatus.set(row.status, [...(byStatus.get(row.status) ?? []), row.id]);

    let counted = 0;
    for (const status of ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const) {
      const page = await store.findPage({ status }, { current: 1, size: 100 });
      counted += page.total;
      expect({ status, ids: page.records.map((r) => r.id).sort() })
        .toEqual({ status, ids: (byStatus.get(status) ?? []).sort() });
    }
    // The five filters partition the asks: a row is in exactly one of them, whatever the link resolved.
    expect(counted).toBe(everyAsk.total);
  });

  it('findApproval answers the mapped view of one ask, and null for a request that is not a fleet ask', async () => {
    const created = await bashAsk({
      input: bashInput('job-16', 'ask-16', { command: 'make deploy', options: ['allow'] }),
      link: { jobId: 'job-16', naxAskId: 'ask-16' },
    });
    const linkless = await linklessAsk();
    const ticketDelete = await ticketDeleteRequest('corr-16');

    expect(await store.findApproval(created.requestId)).toEqual(expect.objectContaining({
      id: created.requestId, type: 'nax_bash_escalate', status: 'pending', jobId: 'job-16', naxAskId: 'ask-16',
      payload: { command: 'make deploy', options: ['allow'] }, projectId: world.projectId,
    }));
    expect(await store.findApproval(linkless)).toBeNull();
    expect(await store.findApproval(ticketDelete.id)).toBeNull();
    expect(await store.findApproval('missing')).toBeNull();
  });

  it('countPendingAllProjects answers every live project, leaving a soft-deleted one out', async () => {
    const live = await prisma.project.create({ data: { name: 'live', slug: `live${++n}`, key: `L${n}` }, select: { id: true, slug: true } });
    const gone = await prisma.project.create({ data: { name: 'gone', slug: `gone${++n}`, key: `G${n}` }, select: { id: true } });
    await bashAsk();
    await bashAsk({ projectId: live.id });
    await bashAsk({ projectId: gone.id });
    await prisma.project.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const counts = await store.countPendingAllProjects();

    expect(counts).toEqual([
      { projectId: live.id, slug: live.slug, pending: 1 },
      { projectId: world.projectId, slug: 'web', pending: 1 },
    ]);
    expect(await store.findProjectSlug(world.projectId)).toBe('web');
    expect(await store.findProjectSlug('missing')).toBeNull();
  });

  it('countPendingAllProjects stays bounded on a larger installation, keeping a stable prefix of projects', async () => {
    const total = MAX_COUNTED_PROJECTS + 2;
    const projects = Array.from({ length: total }, (_, index) => ({
      id: `cap-project-${String(index).padStart(4, '0')}`,
      name: `cap${index}`,
      slug: `cap-${String(index).padStart(4, '0')}`,
      key: `C${index}`,
    }));
    await prisma.project.createMany({ data: projects });
    await prisma.approvalRequest.createMany({
      data: projects.map((project, index) => ({
        id: `cap-request-${index}`, permissionKey: 'fleet.job.shell.escalate', projectId: project.id,
        actorType: 'SYSTEM', actorId: 'runner', origin: 'runner', correlationId: `corr-cap-${index}`,
        input: {}, inputHash: `hash-cap-${index}`, requiredMode: 'agent', onTimeout: 'reject',
        approverMustHoldAction: true, requireDistinctApprover: false, status: 'pending', expiresAt: at(3_600),
      })),
    });
    await prisma.fleetApprovalAsk.createMany({
      data: projects.map((project, index) => ({
        requestId: `cap-request-${index}`, kind: 'bash', projectId: project.id,
        jobId: `cap-job-${index}`, leaseEpoch: 1, naxAskId: `cap-ask-${index}`,
      })),
    });

    const warn = Logger.prototype.warn as unknown as Mock;
    warn.mockClear();
    const counts = await store.countPendingAllProjects();

    // Bounded, not exhaustive: one bounded group query, one bounded project lookup.
    expect(counts).toHaveLength(MAX_COUNTED_PROJECTS);
    expect(new Set(counts.map((c) => c.projectId)).size).toBe(MAX_COUNTED_PROJECTS);
    expect(counts.every((c) => c.pending === 1)).toBe(true);
    // A truncated read says so instead of quietly under-reporting the installation.
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toContain(`more than ${MAX_COUNTED_PROJECTS} projects`);
    // The bound is deterministic, so two reads of a growing installation answer the same rows.
    expect(await store.countPendingAllProjects()).toEqual(counts);
  });
});
