/**
 * Fleet S1 slice 2 — silence sweep (spec §5.3, plan D11) on PG with an explicit clock.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-sweep.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { FleetSweeper } from '../../../src/fleet/sync/fleet-sweeper';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet silence sweep (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
  });
  afterAll(async () => {
    await app.close();
  });

  it('crashes held jobs of a silent runner only, bumping the epoch and withdrawing commands', async () => {
    const base = await seedFleetBase(prisma);
    const now = new Date('2026-10-01T12:00:00.000Z');
    const silent = await insertRunner(prisma, { lastSeenAt: new Date(now.getTime() - 301_000), capacity: 3 });
    const alive = await insertRunner(prisma, { lastSeenAt: new Date(now.getTime() - 10_000) });
    const job = (feature: string, state: string, runnerId: string | null) => prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: base.adminId, state, runnerId, leaseEpoch: 1,
      },
    });
    const running = await job('a', 'RUNNING', silent.id);
    const uploading = await job('b', 'UPLOADING', silent.id);
    const queued = await job('c', 'QUEUED', null);
    const healthy = await job('d', 'RUNNING', alive.id);
    await prisma.fleetCommand.create({ data: { runnerId: silent.id, jobId: running.id, type: 'CANCEL', leaseEpoch: 1, payload: {} } });

    expect(await app.get(FleetSweeper).sweep(now)).toBe(2);
    const after = await prisma.fleetJob.findMany({ where: { id: { in: [running.id, uploading.id, queued.id, healthy.id] } }, orderBy: { feature: 'asc' } });
    expect(after.map((j) => [j.feature, j.state, j.leaseEpoch])).toEqual([['a', 'CRASHED', 2], ['b', 'CRASHED', 2], ['c', 'QUEUED', 1], ['d', 'RUNNING', 1]]);
    expect(after[0].stateReason).toBe('runner silent');
    expect((await prisma.fleetCommand.findFirstOrThrow({ where: { jobId: running.id } })).ackResult).toBe('withdrawn');
    expect(await app.get(FleetSweeper).sweep(now)).toBe(0);
  });
});
