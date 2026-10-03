/**
 * Fleet S1 slice 2 — job repository on PG: CAS assignment, the active-job error,
 * event sequencing, command lifecycle, row locks.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-repository.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';
import { DuplicateActiveJobError, NewFleetJob } from '../../../src/fleet/jobs/domain/fleet-job.domain';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const bind = (client: unknown) => new PrismaFleetJobRepository({ client } as unknown as PrismaService<PrismaClient>);

describeIntegration('PrismaFleetJobRepository (PG)', () => {
  const prisma = new PrismaClient();
  const repo = bind(prisma);
  let base: Omit<NewFleetJob, 'feature'>;
  let runnerId: string;

  beforeAll(async () => {
    await resetDb();
    const user = await prisma.user.create({ data: { email: 'u@koda.test', passwordHash: 'x', role: 'ADMIN' } });
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const fleetRepo = await prisma.fleetRepo.create({
      data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: BigInt(7), createdById: user.id },
    });
    const runner = await prisma.runner.create({
      data: {
        name: 'r1', apiKeyHash: 'h1', os: 'linux', arch: 'x64', labels: ['linux'], capabilities: { executors: ['host'] },
        daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-1', lastSeenAt: new Date(), createdById: user.id,
      },
    });
    runnerId = runner.id;
    base = {
      projectId: project.id, repoId: fleetRepo.id, ref: 'main', command: 'RUN', planFrom: null, profiles: ['fast'],
      maxCostUsd: '5.25', bashMode: 'raw', approvalTimeoutSec: 600, selectorLabels: [], pinnedRunnerId: null, requestedById: user.id,
    };
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates a job with decimal strings and refuses an active duplicate', async () => {
    const job = await repo.createJob({ ...base, feature: 'dup' });
    expect(job).toEqual(expect.objectContaining({ state: 'QUEUED', leaseEpoch: 0, maxCostUsd: '5.25', costSpentUsd: '0' }));
    await expect(repo.createJob({ ...base, feature: 'dup' })).rejects.toBeInstanceOf(DuplicateActiveJobError);
    await expect(repo.findActiveJobId(base.repoId, 'dup')).resolves.toBe(job.id);
  });

  it('assigns with compare-and-set: two racing assignments, one winner, epoch moves once', async () => {
    const job = await repo.createJob({ ...base, feature: 'race' });
    const now = new Date('2026-10-01T12:34:56.789Z');
    const results = await Promise.all([
      bind(new PrismaClient()).casAssign(job.id, runnerId, 'boot-1', now),
      bind(new PrismaClient()).casAssign(job.id, runnerId, 'boot-1', now),
    ]);
    expect(results.filter((r) => r === 1)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    const after = await repo.findById(job.id);
    expect(after).toEqual(expect.objectContaining({ state: 'ASSIGNED', runnerId, runnerBootId: 'boot-1', leaseEpoch: 1, ackedRunnerSeq: 0, assignedAt: now }));
  });

  it('numbers the timeline and finds runner events by (epoch, runnerSeq)', async () => {
    const job = await repo.createJob({ ...base, feature: 'events' });
    await repo.appendEvent(job.id, { leaseEpoch: 1, runnerSeq: null, type: 'state', payload: { to: 'ASSIGNED' } });
    await repo.appendEvent(job.id, { leaseEpoch: 1, runnerSeq: 2, type: 'log', payload: { text: 'b' } });
    await repo.appendEvent(job.id, { leaseEpoch: 1, runnerSeq: 1, type: 'log', payload: { text: 'a' } });
    const page = await repo.findEventPage(job.id, { current: 1, size: 10 });
    expect(page.records.map((e) => [e.seq, e.runnerSeq])).toEqual([[1, null], [2, 2], [3, 1]]);
    expect((await repo.findRunnerEvents(job.id, 1, [1, 5])).map((e) => e.runnerSeq)).toEqual([1]);
    expect((await repo.findRunnerEventsAfter(job.id, 1, 1)).map((e) => e.runnerSeq)).toEqual([2]);
    expect((await repo.findById(job.id))?.eventSeq).toBe(3);
  });

  it('returns pending commands until acked, and withdraws all but ABANDON', async () => {
    const job = await repo.createJob({ ...base, feature: 'cmds' });
    const assign = await repo.createCommand({ runnerId, jobId: job.id, type: 'ASSIGN', leaseEpoch: 1, payload: { a: 1 } });
    await repo.createCommand({ runnerId, jobId: job.id, type: 'ABANDON', leaseEpoch: 0, payload: { reason: 'stale_lease' } });
    await repo.markDelivered([assign.id], new Date());
    expect((await repo.findPendingCommands(runnerId)).map((c) => c.type).sort()).toEqual(['ABANDON', 'ASSIGN']);
    expect(await repo.withdrawPendingCommands(job.id, new Date())).toBe(1);
    expect((await repo.findPendingCommands(runnerId)).map((c) => c.type)).toEqual(['ABANDON']);
    expect((await repo.findCommand(assign.id))?.ackResult).toBe('withdrawn');
  });

  it('withdraws only the given command types when asked (plan D263)', async () => {
    const job = await repo.createJob({ ...base, feature: 'withdraw-types' });
    await repo.createCommand({ runnerId, jobId: job.id, type: 'CANCEL', leaseEpoch: 1, payload: {} });
    await repo.createCommand({ runnerId, jobId: job.id, type: 'APPROVAL_ANSWER', leaseEpoch: 1, payload: { approvalId: 'a', naxAskId: 'ask-1', choice: 'deny' } });
    expect(await repo.withdrawPendingCommands(job.id, new Date(), { types: ['APPROVAL_ANSWER'] })).toBe(1);
    expect((await repo.findPendingCommands(runnerId)).filter((c) => c.jobId === job.id).map((c) => c.type)).toEqual(['CANCEL']);
  });

  it('skips a job row another transaction holds when asked to', async () => {
    const job = await repo.createJob({ ...base, feature: 'locks' });
    await prisma.$transaction(async (tx) => {
      await expect(bind(tx).lockById(job.id)).resolves.toEqual(expect.objectContaining({ id: job.id }));
      await expect(bind(new PrismaClient()).lockById(job.id, { skipLocked: true })).resolves.toBeNull();
    });
  });

  it('reads runners and loads for placement', async () => {
    const [row] = await repo.findPlacementRunners([runnerId]);
    expect(row).toEqual(expect.objectContaining({ id: runnerId, name: 'r1', bootId: 'boot-1', enabled: true, capacity: 1 }));
    await expect(repo.lockRunners([runnerId])).resolves.toEqual([runnerId]);
    const loads = await repo.findActiveLoads([runnerId]);
    expect(loads.every((l) => l.runnerId === runnerId)).toBe(true);
  });
});
