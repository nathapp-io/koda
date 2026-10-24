/**
 * Fleet S1b slice 3a — dispatch with a scheduleId, and the job list filter (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-jobs-schedule-link.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { toDispatchDto } from '../../../src/fleet/schedules/schedule-template';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

interface JobRow { id: string; scheduleId: string | null; coalescedCount: number }

describeIntegration('fleet jobs schedule link (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const template = (feature: string) => toDispatchDto({
    repoId: world.repoId, feature, ref: 'trunk', profiles: [], maxCostUsd: '5', selectorLabels: [],
    bashMode: 'raw', approvalTimeoutSec: 600, pinnedRunnerId: null,
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
  });
  afterAll(async () => {
    await app.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('links the job to the schedule, notes it in the dispatch activity, and the list filters on it', async () => {
    const schedule = await prisma.jobSchedule.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, name: 'link', cron: '0 * * * *', timezone: 'UTC', feature: 'linked', ref: 'trunk',
        profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: new Date(), createdById: world.ids.dev, updatedById: world.ids.dev,
      },
    });
    const jobs = app.get(FleetJobsService);
    // The scheduled dispatch is the ticker's, which production runs as the schedule component;
    // the manual one is the dispatch route, run by the developer who posts it.
    const scheduled = await withTestActor({ type: 'SYSTEM', id: 'schedule' }, () =>
      jobs.dispatch(world.ids.dev, world.projectId, template('linked'), { scheduleId: schedule.id }));
    const manual = await withTestActor({ type: 'USER', id: world.ids.dev }, () =>
      jobs.dispatch(world.ids.dev, world.projectId, template('manual')));

    expect(scheduled.job).toEqual(expect.objectContaining({ scheduleId: schedule.id, coalescedCount: 0 }));
    expect(manual.job.scheduleId).toBeNull();
    const row = await prisma.fleetActivity.findFirstOrThrow({ where: { action: 'job.dispatched', jobId: scheduled.job.id } });
    expect(row.payload).toEqual(expect.objectContaining({ scheduleId: schedule.id, feature: 'linked' }));

    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${world.tokens.dev}` };
    const page = data<{ records: JobRow[] }>(await request(server).get(`/api/projects/web/fleet/jobs?scheduleId=${schedule.id}`).set(auth).expect(200));
    expect(page.records.map((r) => r.id)).toEqual([scheduled.job.id]);
    expect(page.records[0]).toEqual(expect.objectContaining({ scheduleId: schedule.id, coalescedCount: 0 }));
    const none = data<{ records: JobRow[] }>(await request(server).get('/api/projects/web/fleet/jobs?scheduleId=nope').set(auth).expect(200));
    expect(none.records).toEqual([]);
  });
});
