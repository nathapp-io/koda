/**
 * Fleet S2b slice 1a — admin ingest routes (PG), spec §2.6, D370.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet ingest admin API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let jobId: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
      },
    });
    jobId = job.id;
    await prisma.fleetJobArtifact.create({ data: { jobId, leaseEpoch: 1, kind: 'bundle', storageKey: 'jobs/x/1/a.tar.gz', sizeBytes: BigInt(1), sha256: 'a'.repeat(64) } });
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses non-admins', async () => {
    await request(server).get('/api/fleet/ingest').set(auth('dev')).expect(403);
    await request(server).post('/api/fleet/ingest/backfill').set(auth('dev')).expect(403);
  });

  it('backfills, lists, reruns one job and reruns outdated, recording activity', async () => {
    const ingest = app.get(BundleIngestService);
    const backfill = await request(server).post('/api/fleet/ingest/backfill').set(auth('root')).expect(201);
    expect(data(backfill)).toEqual({ queued: 1 });
    await ingest.idle(); // the route kicks a drain; let it settle or the row may be claimed (running) during the list
    const list = await request(server).get('/api/fleet/ingest?status=pending').set(auth('root')).expect(200);
    expect(data<{ records: Array<Record<string, unknown>> }>(list).records[0]).toMatchObject({ jobId, leaseEpoch: 1, status: 'pending', projectId: world.projectId });
    const rerun = await request(server).post(`/api/fleet/ingest/jobs/${jobId}/rerun`).set(auth('root')).expect(201);
    expect(data(rerun)).toEqual({ queued: 1 });
    await ingest.idle();
    await request(server).post('/api/fleet/ingest/jobs/nope/rerun').set(auth('root')).expect(404);
    const outdated = await request(server).post('/api/fleet/ingest/rerun-outdated').set(auth('root')).expect(201);
    expect(data(outdated)).toEqual({ queued: 0 });
    await ingest.idle();
    expect(await prisma.fleetActivity.count({ where: { action: { in: ['ingest.backfill', 'ingest.rerun', 'ingest.rerun_outdated'] } } })).toBe(3);
  });

  it('rejects an unknown status filter', async () => {
    await request(server).get('/api/fleet/ingest?status=bogus').set(auth('root')).expect(400);
  });
});
