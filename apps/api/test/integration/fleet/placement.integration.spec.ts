/**
 * Fleet S1 slice 2 — placement on PG: exactly one assignment under races (spec §6.1).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/placement.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet placement (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let placement: PlacementService;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;

  const queue = (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature, profiles: ['fast'],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    placement = app.get(PlacementService);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.runner.deleteMany();
  });

  it('assigns to the best runner and queues one ASSIGN carrying no secret', async () => {
    const busy = await insertRunner(prisma, { capacity: 2 });
    const idle = await insertRunner(prisma, { capacity: 2 });
    const other = await queue('other', { state: 'RUNNING', runnerId: busy.id, leaseEpoch: 1 });
    const job = await queue('feat');
    const outcome = await placement.placeJob(job.id);
    expect(outcome).toEqual(expect.objectContaining({ assigned: true, runnerId: idle.id, leaseEpoch: 1 }));
    const commands = await prisma.fleetCommand.findMany({ where: { jobId: job.id } });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(expect.objectContaining({ type: 'ASSIGN', runnerId: idle.id, leaseEpoch: 1 }));
    expect(commands[0].payload).toEqual(expect.objectContaining({
      jobId: job.id, feature: 'feat', maxCostUsd: '5', bashMode: 'raw',
      repo: expect.objectContaining({ provider: 'github', owner: 'acme', cloneUrl: expect.stringMatching(/\.git$/) }),
    }));
    expect(JSON.stringify(commands[0].payload)).not.toMatch(/token|ghs_/i);
    expect(other.id).toBeDefined();
  });

  it('keeps a job QUEUED and reports every runner with its first failing rule', async () => {
    const off = await insertRunner(prisma, { enabled: false });
    const mac = await insertRunner(prisma, { labels: ['mac'] });
    const job = await queue('lonely', { selectorLabels: ['linux'] });
    const outcome = await placement.placeJob(job.id);
    expect(outcome.assigned).toBe(false);
    expect(outcome.misfits).toEqual(expect.arrayContaining([
      expect.objectContaining({ runnerId: off.id, reason: 'disabled' }),
      expect.objectContaining({ runnerId: mac.id, reason: 'labels' }),
    ]));
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe('QUEUED');
  });

  it('never assigns one job twice when dispatch placement and a sync fill race', async () => {
    const r = await insertRunner(prisma, { capacity: 3 });
    for (let i = 0; i < 5; i += 1) {
      const job = await queue(`race-${i}`);
      await Promise.all([placement.placeJob(job.id), placement.fillRunner(r.id, 3), placement.placeJob(job.id)]);
      const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(after.leaseEpoch).toBeLessThanOrEqual(1);
      expect(await prisma.fleetCommand.count({ where: { jobId: job.id, type: 'ASSIGN' } })).toBe(after.state === 'ASSIGNED' ? 1 : 0);
      await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'COMPLETED' } });
    }
  });

  it('fills a runner up to min(freeSlots, capacity - active), oldest first, one job per repo', async () => {
    const r = await insertRunner(prisma, { capacity: 2 });
    const first = await queue('a');
    await queue('b'); // same repo as `a`: busy_repo once `a` is assigned
    expect(await placement.fillRunner(r.id, 5)).toBe(1);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('ASSIGNED');
  });

  it('skips a disabled runner on fill and honours pins', async () => {
    const disabled = await insertRunner(prisma, { enabled: false });
    const pinnedTo = await insertRunner(prisma);
    const other = await insertRunner(prisma);
    await queue('p', { pinnedRunnerId: pinnedTo.id });
    expect(await placement.fillRunner(disabled.id, 1)).toBe(0);
    expect(await placement.fillRunner(other.id, 1)).toBe(0);
    expect(await placement.fillRunner(pinnedTo.id, 1)).toBe(1);
  });
});
