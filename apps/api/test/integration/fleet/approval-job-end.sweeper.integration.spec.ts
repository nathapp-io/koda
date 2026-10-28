import { randomUUID } from 'node:crypto';
import { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { ApprovalRequestExpirySweeper } from '../../../src/approvals/approval-request-expiry.sweeper';
import { PrismaApprovalRequestRepository } from '../../../src/approvals/prisma-approval-request.repository';
import { ApprovalCloser } from '../../../src/fleet/approvals/approval-closer';
import { ApprovalJobEndSweeper, MAX_ASKS_PER_TICK } from '../../../src/fleet/approvals/approval-job-end.sweeper';
import { ApprovalLivePublisher } from '../../../src/fleet/approvals/approval-live.publisher';
import { FleetApprovalAskStore } from '../../../src/fleet/approvals/fleet-approval-ask.store';
import { FLEET_JOB_REPOSITORY } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { fixtureDb } from '../../helpers/action-context';
import { seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('job-end continuation, expiry coordination and atomic audit (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  const due = new Date(Date.now() + 60_000);
  const get = <T>(token: Parameters<NathApplication['get']>[0]): T => app.get(token, { strict: false }) as T;
  const sweeper = () => get<ApprovalJobEndSweeper>(ApprovalJobEndSweeper);
  const expiry = () => get<ApprovalRequestExpirySweeper>(ApprovalRequestExpirySweeper);
  const status = (ids: string[]) => db.approvalRequest.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.fleetApprovalAsk.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetJob.deleteMany();
    await db.auditEntry.deleteMany();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function pending(count: number, state: 'COMPLETED' | 'RUNNING' = 'COMPLETED'): Promise<{ jobId: string; ids: string[] }> {
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: randomUUID(),
      profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev,
      requestedByType: 'USER', state, leaseEpoch: 1, bashMode: 'escalate', approvalTimeoutSec: 600,
    } });
    const ids = Array.from({ length: count }, () => randomUUID()).sort();
    await db.approvalRequest.createMany({ data: ids.map((id) => ({
      id, projectId: world.projectId, permissionKey: 'fleet.job.shell.escalate', actorType: 'SYSTEM', actorId: 'runner',
      origin: 'runner', correlationId: randomUUID(), input: {}, inputHash: randomUUID(), requiredMode: 'human',
      onTimeout: 'reject', approverMustHoldAction: true, requireDistinctApprover: false, status: 'pending', expiresAt: due,
    })) });
    await db.fleetApprovalAsk.createMany({ data: ids.map((requestId) => ({
      requestId, jobId: job.id, projectId: world.projectId, kind: 'bash', leaseEpoch: 1, naxAskId: requestId,
    })) });
    return { jobId: job.id, ids };
  }

  async function held(ids: string[], fn: () => Promise<void>): Promise<void> {
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id" IN (${Prisma.join(ids)}) FOR UPDATE`;
      ready();
      await released;
    }, { timeout: 60_000 });
    await locked;
    try { await fn(); } finally { release(); await holder; }
  }

  it('F1 round 5: expiry cannot consume an ended-job backlog larger than a tick at its deadline', async () => {
    const { jobId, ids } = await pending(MAX_ASKS_PER_TICK * 2 + 5);
    const running = await pending(1, 'RUNNING');
    const atDeadline = new Date(due.getTime());
    // Older ended-job requests must not consume expiry's LIMIT and starve a live job's timeout.
    await db.approvalRequest.updateMany({ where: { id: { in: ids } }, data: { expiresAt: new Date(due.getTime() - 1) } });
    expect(await expiry().tick(atDeadline)).toEqual({ expired: 1, approved: 0, failed: 0 });
    expect((await status(running.ids))[0]?.status).toBe('expired');
    expect((await status(ids)).every((row) => row.status === 'pending')).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      expect(await sweeper().tick(atDeadline)).toMatchObject({ closed: i < 2 ? MAX_ASKS_PER_TICK : 5, failed: 0 });
      expect(await expiry().tick(atDeadline)).toEqual({ expired: 0, approved: 0, failed: 0 });
    }
    expect((await status(ids)).every((row) => row.status === 'cancelled' &&
      (row.result as { closedBy?: string })?.closedBy === 'job_ended')).toBe(true);
    expect(await db.fleetApprovalAsk.count({ where: { jobId, resolvedBy: 'job_ended' } })).toBe(ids.length);
    expect(await db.fleetActivity.count({ where: { jobId, action: 'approval.cancelled' } })).toBe(ids.length);
  }, 120_000);

  it('F1 round 5: expiry rechecks a scanned ask after its job ends before settlement', async () => {
    const { ids } = await pending(1);
    const requests = get<PrismaApprovalRequestRepository>(PrismaApprovalRequestRepository);
    // Model a due scan performed while the job was RUNNING; it has since committed its end.
    const id = ids[0];
    if (id === undefined) throw new Error('fixture did not create an ask');
    const scanned = await requests.findById(id);
    if (scanned === null) throw new Error('fixture request is missing');
    vi.spyOn(requests, 'findDue').mockResolvedValue([scanned]);
    expect(await expiry().tick(due)).toEqual({ expired: 0, approved: 0, failed: 0 });
    expect((await status(ids))[0]?.status).toBe('pending');
    await sweeper().tick(due);
    expect((await status(ids))[0]?.status).toBe('cancelled');
  });

  it('F1 round 5: expiry preserves budget, unlinked and deleted-job timeout behaviour', async () => {
    const budget = await pending(1);
    const unlinked = await pending(1);
    const orphan = await pending(1);
    await db.fleetApprovalAsk.update({ where: { requestId: budget.ids[0] }, data: { kind: 'budget', jobId: null } });
    await db.approvalRequest.update({ where: { id: budget.ids[0] }, data: { permissionKey: 'fleet.budget.override' } });
    await db.fleetApprovalAsk.delete({ where: { requestId: unlinked.ids[0] } });
    await db.fleetJob.delete({ where: { id: orphan.jobId } });
    expect(await expiry().tick(due)).toEqual({ expired: 3, approved: 0, failed: 0 });
    expect((await status([...budget.ids, ...unlinked.ids, ...orphan.ids])).every((row) => row.status === 'expired')).toBe(true);
  });

  it('F1 round 5: timeout recheck waits for an in-flight job end and observes its committed state', async () => {
    const { jobId, ids } = await pending(1, 'RUNNING');
    const requests = get<PrismaApprovalRequestRepository>(PrismaApprovalRequestRepository);
    let release!: () => void;
    let ready!: () => void;
    let checked!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const checking = new Promise<void>((resolve) => { checked = resolve; });
    const original = requests.canSettleTimeout.bind(requests);
    vi.spyOn(requests, 'canSettleTimeout').mockImplementation((id) => { checked(); return original(id); });
    const holder = db.$transaction(async (tx) => {
      // Fixture simulates the job-held half of a transition whose request close was skipped.
      await tx.fleetJob.update({ where: { id: jobId }, data: { state: 'COMPLETED' } });
      ready();
      await released;
    });
    await locked;
    const ticking = expiry().tick(due);
    try {
      await Promise.race([checking, ticking.then(() => { throw new Error('expiry never rechecked the job'); })]);
    } finally { release(); await holder; }
    expect(await ticking).toEqual({ expired: 0, approved: 0, failed: 0 });
    expect((await status(ids))[0]?.status).toBe('pending');
    await sweeper().tick(due);
    expect((await status(ids))[0]?.status).toBe('cancelled');
  });

  it('F1: 100 held requests do not hide later unlocked asks from job-end cancellation or expiry', async () => {
    const { ids } = await pending(102);
    const running = await pending(1, 'RUNNING');
    await held(ids.slice(0, 100), async () => {
      await sweeper().tick();
      expect((await status(ids.slice(100))).map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
      expect((await status(ids.slice(0, 100))).every((row) => row.status === 'pending')).toBe(true);
      // Due expiry must neither wait for these held ended-job requests nor convert them to expired.
      expect(await expiry().tick(due)).toMatchObject({ expired: 1, failed: 0 });
    });
    await sweeper().tick();
    expect(await expiry().tick(new Date(due.getTime() + 1))).toMatchObject({ expired: 0, failed: 0 });
    expect((await status(running.ids))[0]?.status).toBe('expired');
    expect((await status(ids)).every((row) => row.status === 'cancelled' &&
      (row.result as { closedBy?: string })?.closedBy === 'job_ended')).toBe(true);
  }, 60_000);

  it('F1: ten held jobs cannot monopolize the backlog ahead of an eleventh job', async () => {
    const blocked = [];
    for (let i = 0; i < 10; i += 1) blocked.push(await pending(10));
    const healthy = await pending(1);
    const heldIds = blocked.flatMap((job) => job.ids);
    await held(heldIds, async () => {
      expect(await sweeper().tick()).toMatchObject({ jobs: 1, closed: 1, failed: 0 });
      expect((await status(healthy.ids))[0]?.status).toBe('cancelled');
      expect((await status(heldIds)).every((row) => row.status === 'pending')).toBe(true);
    });
    await sweeper().tick();
    await expiry().tick(new Date(due.getTime() + 1));
    expect((await status([...heldIds, ...healthy.ids])).every((row) => row.status === 'cancelled')).toBe(true);
  }, 60_000);

  it('F1/F2: ten repeatedly failing jobs rotate durably past a full batch, even after a restart', async () => {
    const broken = [];
    for (let i = 0; i < 10; i += 1) broken.push(await pending(10));
    const healthy = await pending(1);
    const audit = get<AuditRecorder>(AuditRecorder);
    const original = audit.record.bind(audit);
    const badJobs = new Set(broken.map((job) => job.jobId));
    const failure = vi.spyOn(audit, 'record').mockImplementation(async (entry) => {
      if (badJobs.has(entry.resourceId ?? '') && entry.summary?.startsWith('job-ended close:')) throw new Error('audit unavailable');
      return original(entry);
    });
    await sweeper().tick();
    expect((await status(broken.flatMap((job) => job.ids))).every((row) => row.status === 'pending')).toBe(true);
    expect((await status(healthy.ids))[0]?.status).toBe('pending'); // the first batch was entirely failing work
    expect(await expiry().tick(due)).toEqual({ expired: 0, approved: 0, failed: 0 });
    // A new instance has no in-memory cursor; the database must carry the rotation past failed attempts.
    const restarted = new ApprovalJobEndSweeper(
      get(FleetApprovalAskStore), get(FLEET_JOB_REPOSITORY), get(ApprovalCloser), get(ApprovalLivePublisher),
      get(TRANSACTION_MANAGER), { sweepEnabled: false, approvalSweepMs: 15_000 }, audit,
    );
    await restarted.tick();
    expect((await status(healthy.ids))[0]?.status).toBe('cancelled');
    failure.mockRestore();
    for (let i = 0; i < 3; i += 1) await restarted.tick();
    await expiry().tick(new Date(due.getTime() + 1));
    const all = await status([...broken.flatMap((job) => job.ids), ...healthy.ids]);
    expect(all.every((row) => row.status === 'cancelled' && (row.result as { closedBy?: string })?.closedBy === 'job_ended')).toBe(true);
  }, 120_000);

  it('F2: a failed close audit rolls back request, link, activity and outbox, publishes nothing, and retries', async () => {
    const { jobId, ids } = await pending(1);
    const audit = get<AuditRecorder>(AuditRecorder);
    const original = audit.record.bind(audit);
    const publish = vi.spyOn(get<ApprovalLivePublisher>(ApprovalLivePublisher), 'publish');
    const failure = vi.spyOn(audit, 'record').mockImplementation(async (entry) => {
      if (entry.summary?.startsWith('job-ended close:')) throw new Error('audit unavailable');
      return original(entry);
    });
    const outboxBefore = await db.outboxEvent.count();
    expect(await sweeper().tick()).toMatchObject({ closed: 0, failed: 1 });
    expect((await status(ids))[0]?.status).toBe('pending');
    expect((await db.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: ids[0] } })).resolvedBy).toBeNull();
    expect(await db.fleetActivity.count({ where: { jobId, action: 'approval.cancelled' } })).toBe(0);
    expect(await db.outboxEvent.count()).toBe(outboxBefore);
    expect(publish).not.toHaveBeenCalled();
    failure.mockRestore();
    await sweeper().tick();
    expect((await status(ids))[0]?.status).toBe('cancelled');
    expect(await db.auditEntry.count({ where: { resourceId: jobId, summary: { startsWith: 'job-ended close:' } } })).toBe(1);
    expect(await db.fleetActivity.count({ where: { jobId, action: 'approval.cancelled' } })).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
