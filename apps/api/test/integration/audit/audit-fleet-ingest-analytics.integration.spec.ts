import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { insertAnalyticsJob, insertCostEvent, insertIngestRow } from '../../helpers/fleet-analytics-fixtures';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeIntegration('fleet ingest and analytics audit (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const entries = (key: string, resourceId?: string) => prisma.auditEntry.findMany({ where: { key, ...(resourceId ? { resourceId } : {}) } });
  const job = () => prisma.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `audit-ingest-${++seq}`,
    profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
  } });
  const artifact = (jobId: string) => prisma.fleetJobArtifact.create({ data: {
    jobId, leaseEpoch: 1, kind: 'bundle', storageKey: `jobs/${jobId}/1/a.tar.gz`, sizeBytes: BigInt(1), sha256: 'a'.repeat(64),
  } });
  const queueIdle = async () => app.get(BundleIngestService).idle();

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.auditEntry.deleteMany();
    await prisma.fleetActivity.deleteMany();
    await prisma.fleetBundleIngest.deleteMany();
    await prisma.fleetJobArtifact.deleteMany();
    await prisma.fleetCostEvent.deleteMany();
    await prisma.fleetStoryResult.deleteMany();
    await prisma.fleetReviewResult.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('AC-1/2/5: audits only a successful backfill and no refused or empty backfill', async () => {
    const j = await job();
    await artifact(j.id);
    const response = await request(server).post('/api/fleet/ingest/backfill').set(auth('root')).expect(201);
    expect(data(response)).toEqual({ queued: 1 });
    await queueIdle();
    expect(await entries('fleet.ingest.backfill', 'all')).toMatchObject([{
      key: 'fleet.ingest.backfill', resourceType: 'fleet-ingest', resourceId: 'all', projectId: null,
      actorType: 'USER', actorId: world.ids.root, summary: 'backfill queued 1',
    }]);
    const before = await entries('fleet.ingest.backfill', 'all');
    expect(data(await request(server).post('/api/fleet/ingest/backfill').set(auth('root')).expect(201))).toEqual({ queued: 0 });
    await queueIdle();
    expect(await entries('fleet.ingest.backfill', 'all')).toHaveLength(before.length);
    await request(server).post('/api/fleet/ingest/backfill').set(auth('dev')).expect(403);
    expect(await prisma.auditEntry.count({ where: { key: 'fleet.ingest.backfill', actorId: world.ids.dev } })).toBe(0);
  });

  it('AC-3/6/13: audits a job rerun with its project, rolls back a rejected record, and ignores unknown jobs', async () => {
    const j = await job();
    await insertIngestRow(prisma, j.id, 1, { status: 'done' });
    await prisma.fleetBundleIngest.updateMany({ where: { jobId: j.id }, data: { parserVersion: 3 } });
    expect(data(await request(server).post(`/api/fleet/ingest/jobs/${j.id}/rerun`).set(auth('root')).expect(201))).toEqual({ queued: 1 });
    await queueIdle();
    expect(await entries('fleet.ingest.rerun', j.id)).toMatchObject([{
      key: 'fleet.ingest.rerun', resourceType: 'fleet-job', resourceId: j.id, projectId: world.projectId, summary: 'rerun queued 1',
    }]);

    await prisma.auditEntry.deleteMany({ where: { key: 'fleet.ingest.rerun', resourceId: j.id } });
    await prisma.fleetBundleIngest.updateMany({ where: { jobId: j.id }, data: { status: 'done', parserVersion: 3 } });
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await request(server).post(`/api/fleet/ingest/jobs/${j.id}/rerun`).set(auth('root')).expect(500);
    expect(await prisma.fleetBundleIngest.findMany({ where: { jobId: j.id }, select: { status: true } })).toEqual([{ status: 'done' }]);
    expect(await entries('fleet.ingest.rerun', j.id)).toHaveLength(0);
    vi.restoreAllMocks();

    await request(server).post('/api/fleet/ingest/jobs/unknown-job/rerun').set(auth('root')).expect(404);
    expect(await entries('fleet.ingest.rerun', 'unknown-job')).toHaveLength(0);
  });

  it('AC-4/7: audits only a non-empty outdated rerun', async () => {
    const j = await job();
    await insertIngestRow(prisma, j.id, 1, { status: 'done' });
    await prisma.fleetBundleIngest.updateMany({ where: { jobId: j.id }, data: { parserVersion: 2 } });
    expect(data(await request(server).post('/api/fleet/ingest/rerun-outdated').set(auth('root')).expect(201))).toEqual({ queued: 1 });
    await queueIdle();
    expect(await entries('fleet.ingest.rerun', 'all')).toMatchObject([{
      key: 'fleet.ingest.rerun', resourceType: 'fleet-ingest', resourceId: 'all', summary: 'rerun outdated queued 1',
    }]);
    const before = await entries('fleet.ingest.rerun', 'all');
    expect(data(await request(server).post('/api/fleet/ingest/rerun-outdated').set(auth('root')).expect(201))).toEqual({ queued: 0 });
    await queueIdle();
    expect(await entries('fleet.ingest.rerun', 'all')).toHaveLength(before.length);
  });

  it('AC-8/9/10/11: audits nonzero scoped and global deletes only', async () => {
    const j = await insertAnalyticsJob(prisma, { projectId: world.projectId, repoId: world.repoId, requestedById: world.ids.dev });
    await insertCostEvent(prisma, { jobId: j, projectId: world.projectId, repoId: world.repoId }, { at: new Date('2026-10-01T00:00:00Z') });
    const cutoff = '2026-10-05T00:00:00Z';
    const scoped = await request(server).delete(`/api/fleet/analytics?before=${cutoff}&projectId=${world.projectId}`).set(auth('root')).send({ confirm: 'web' }).expect(200);
    expect(data(scoped)).toMatchObject({ costEvents: 1, stories: 0, reviews: 0, ingestRowsMarked: 0 });
    expect(await entries('fleet.analytics.delete', world.projectId)).toMatchObject([{
      key: 'fleet.analytics.delete', resourceType: 'fleet-analytics', resourceId: world.projectId, projectId: world.projectId,
      summary: 'deleted 1 cost events, 0 stories, 0 reviews, 0 ingest rows marked',
    }]);

    await prisma.auditEntry.deleteMany({ where: { key: 'fleet.analytics.delete' } });
    const globalJob = await insertAnalyticsJob(prisma, { projectId: world.projectId, repoId: world.repoId, requestedById: world.ids.dev });
    await insertCostEvent(prisma, { jobId: globalJob, projectId: world.projectId, repoId: world.repoId }, { at: new Date('2026-10-01T00:00:00Z') });
    await request(server).delete(`/api/fleet/analytics?before=${cutoff}`).set(auth('root')).send({ confirm: 'ALL' }).expect(200);
    expect(await entries('fleet.analytics.delete', 'all')).toMatchObject([{ resourceType: 'fleet-analytics', resourceId: 'all', projectId: null }]);

    await prisma.auditEntry.deleteMany({ where: { key: 'fleet.analytics.delete', projectId: world.projectId } });
    await request(server).delete(`/api/fleet/analytics?before=${cutoff}&projectId=${world.projectId}`).set(auth('root')).send({ confirm: 'wrong' }).expect(400);
    expect(await entries('fleet.analytics.delete', world.projectId)).toHaveLength(0);
    const empty = await request(server).delete(`/api/fleet/analytics?before=2026-10-20T00:00:00Z&projectId=${world.projectId}`).set(auth('root')).send({ confirm: 'web' }).expect(200);
    expect(data(empty)).toMatchObject({ costEvents: 0, stories: 0, reviews: 0, ingestRowsMarked: 0 });
    expect(await entries('fleet.analytics.delete', world.projectId)).toHaveLength(0);
  });
});
