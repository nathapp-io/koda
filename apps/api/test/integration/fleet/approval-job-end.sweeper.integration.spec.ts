import { randomUUID } from 'node:crypto';
import { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { ApprovalRequestExpirySweeper } from '../../../src/approvals/approval-request-expiry.sweeper';
import { ApprovalCloser } from '../../../src/fleet/approvals/approval-closer';
import { ApprovalJobEndSweeper } from '../../../src/fleet/approvals/approval-job-end.sweeper';
import { ApprovalLivePublisher } from '../../../src/fleet/approvals/approval-live.publisher';
import { FleetApprovalAskStore } from '../../../src/fleet/approvals/fleet-approval-ask.store';
import { FLEET_JOB_REPOSITORY } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { fixtureDb } from '../../helpers/action-context';
import { seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('job-end continuation fairness and atomic audit (PG, fix round 4)', () => {
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

  it('F1: 100 held requests do not hide later unlocked asks from job-end cancellation or expiry', async () => {
    const { ids } = await pending(102);
    const running = await pending(1, 'RUNNING');
    await held(ids.slice(0, 100), async () => {
      await sweeper().tick();
      expect((await status(ids.slice(100))).map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
      expect((await status(ids.slice(0, 100))).every((row) => row.status === 'pending')).toBe(true);
    });
    await sweeper().tick();
    expect(await expiry().tick(new Date(due.getTime() + 1))).toMatchObject({ expired: 1, failed: 0 });
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
