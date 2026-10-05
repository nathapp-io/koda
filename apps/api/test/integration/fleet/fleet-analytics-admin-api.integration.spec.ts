/**
 * Fleet S2b slice 1b — admin analytics routes (PG), spec §4.3, D370, D384.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-admin-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { insertAnalyticsJob, insertCostEvent, insertIngestRow } from '../../helpers/fleet-analytics-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet analytics admin API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let webJob: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const del = (query: string, confirm: unknown, who: keyof FleetHttpWorld['tokens'] = 'root') =>
    request(server).delete(`/api/fleet/analytics${query}`).set(auth(who)).send(confirm === undefined ? {} : { confirm });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    webJob = await insertAnalyticsJob(prisma, { projectId: world.projectId, repoId: world.repoId, requestedById: world.ids.dev });
    const opsJob = await insertAnalyticsJob(prisma, { projectId: world.opsProjectId, repoId: world.foreignRepoId, requestedById: world.ids.root });
    const web = { jobId: webJob, projectId: world.projectId, repoId: world.repoId };
    await insertCostEvent(prisma, web, { at: new Date('2026-10-01T00:00:00Z'), costUsd: '1.5' });
    await insertCostEvent(prisma, web, { at: new Date('2026-10-10T00:00:00Z'), costUsd: '0.5' });
    await insertCostEvent(prisma, { jobId: opsJob, projectId: world.opsProjectId, repoId: world.foreignRepoId }, { at: new Date('2026-10-01T00:00:00Z'), costUsd: '2.25' });
    await insertIngestRow(prisma, webJob, 1);
    await insertIngestRow(prisma, opsJob, 1);
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses non-admins', async () => {
    await request(server).get('/api/fleet/analytics/spend').set(auth('dev')).expect(403);
    await del('?before=2026-10-05T00:00:00Z', 'ALL', 'dev').expect(403);
  });

  it('groups spend across projects, labelled by slug', async () => {
    const s = data<{ totals: { costUsd: string; jobs: number }; series: Array<{ key: string; label: string; costUsd: string }> }>(
      await request(server).get('/api/fleet/analytics/spend?from=2026-09-28T00:00:00Z&to=2026-10-12T00:00:00Z&groupBy=project').set(auth('root')).expect(200),
    );
    expect(s.totals).toMatchObject({ costUsd: '4.2500', jobs: 2 });
    expect(s.series.map((x) => [x.key, x.label, x.costUsd])).toEqual([
      [world.opsProjectId, 'ops', '2.2500'],
      [world.projectId, 'web', '2.0000'],
    ]);
  });

  it('refuses a delete without before or with the wrong confirmation, deleting nothing', async () => {
    await del('', 'ALL').expect(400);
    await del('?before=2026-10-05T00:00:00Z', undefined).expect(400);
    await del('?before=2026-10-05T00:00:00Z', 'web').expect(400);
    await del('?before=2026-10-05T00:00:00', 'ALL').expect(400); // no Z
    await del(`?before=2026-10-05T00:00:00Z&projectId=${world.projectId}`, 'ALL').expect(400);
    await del('?before=2026-10-05T00:00:00Z&projectId=nope', 'nope').expect(404);
    expect(await prisma.fleetCostEvent.count()).toBe(3);
  });

  it('deletes one project before the cutoff, marks its ingest rows and records the activity', async () => {
    const res = data(await del(`?before=2026-10-05T00:00:00Z&projectId=${world.projectId}`, 'web').expect(200));
    expect(res).toEqual({ projectId: world.projectId, before: '2026-10-05T00:00:00.000Z', costEvents: 1, stories: 0, reviews: 0, ingestRowsMarked: 1 });
    expect(await prisma.fleetCostEvent.count({ where: { projectId: world.projectId } })).toBe(1);
    expect(await prisma.fleetCostEvent.count({ where: { projectId: world.opsProjectId } })).toBe(1);
    expect((await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: webJob } })).files).toMatchObject({ deleted: '2026-10-05T00:00:00.000Z' });
    const activity = await prisma.fleetActivity.findFirstOrThrow({ where: { action: 'analytics.deleted' } });
    expect(activity).toMatchObject({ entityType: 'analytics', entityId: world.projectId, actorId: world.ids.root });
  });

  it('deletes across projects with ALL', async () => {
    expect(data(await del('?before=2026-10-11T00:00:00Z', 'ALL').expect(200))).toMatchObject({ projectId: null, costEvents: 2 });
    expect(await prisma.fleetCostEvent.count()).toBe(0);
  });
});
