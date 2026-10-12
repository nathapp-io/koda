/**
 * Fleet S5a US-007 — the dashboard does not count held THREAD jobs as runner load (PG).
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-dashboard-thread-load.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV = ['FLEET_JOB_QUEUED_WARN_SEC'] as const;

interface Item { key: string; kind: string; subjectId: string; verdict?: string }
interface Snapshot {
  runners: Array<{ id: string; name: string; activeJobs: number }>;
  attention: Item[];
}

describeIntegration('fleet dashboard counts held THREAD jobs as no runner load (PG, US-007)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    // The unplaceable rule only reports a job queued for longer than this.
    process.env.FLEET_JOB_QUEUED_WARN_SEC = '60';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const admin = async () => data<Snapshot>(await request(server).get('/api/fleet/dashboard')
    .set('Authorization', `Bearer ${world.tokens.root}`).expect(200));

  /** A runner with its own name so each case reads only its own activeJobs count. */
  const runner = async (name: string) => (await insertRunner(prisma, { name, capacity: 1, labels: [] })).id;

  const job = (over: Partial<Prisma.FleetJobUncheckedCreateInput>) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', profiles: [], maxCostUsd: new Prisma.Decimal(2),
      selectorLabels: [], requestedById: world.ids.root, feature: `f-${Math.random().toString(36).slice(2, 8)}`, ...over,
    },
  });

  it('US-007 AC7: a runner holding only a RUNNING THREAD job has activeJobs 0', async () => {
    const id = await runner('thread-only');
    await job({ command: 'THREAD', state: 'RUNNING', runnerId: id, leaseEpoch: 1 });
    const row = (await admin()).runners.find((r) => r.id === id);
    expect(row?.activeJobs).toBe(0);
  });

  it('US-007 AC8: a runner holding a RUNNING RUN job and a RUNNING THREAD job has activeJobs 1', async () => {
    const id = await runner('run-and-thread');
    await job({ command: 'THREAD', state: 'RUNNING', runnerId: id, leaseEpoch: 1 });
    await job({ command: 'RUN', state: 'RUNNING', runnerId: id, leaseEpoch: 1 });
    const row = (await admin()).runners.find((r) => r.id === id);
    expect(row?.activeJobs).toBe(1);
  });

  it('US-007 AC9: a RUN job queued on a repo held only by a THREAD job is not reported as busy or at capacity', async () => {
    // Its own repo, so the runners of the earlier cases (which hold the shared repo) cannot make it busy.
    const repoA = (await prisma.fleetRepo.create({ data: {
      projectId: world.projectId, provider: 'github', owner: 'acme', name: 'thread-load-rA', defaultBranch: 'main', createdById: world.ids.root,
    } })).id;
    const id = await runner('thread-free-rA');
    await job({ command: 'THREAD', state: 'RUNNING', runnerId: id, leaseEpoch: 1, repoId: repoA });
    // Pinned to R, so the pool is R alone: the earlier cases' runners are not candidates and cannot raise a misfit.
    const queued = await job({ command: 'RUN', state: 'QUEUED', repoId: repoA, pinnedRunnerId: id, queuedAt: new Date(Date.now() - 10 * 60_000) });
    const snapshot = await admin();
    const item = snapshot.attention.find((a) => a.kind === 'job_unplaceable' && a.subjectId === queued.id);
    // R fits the job: the held THREAD job is not load, so no busy_repo or capacity misfit is reported for R.
    expect(item).toMatchObject({ verdict: 'fits_not_placed', reasons: [], reasonsTotal: 0 });
  });
});
