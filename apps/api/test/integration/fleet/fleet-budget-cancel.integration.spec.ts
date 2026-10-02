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
