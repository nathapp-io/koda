import request from 'supertest';
import permissions from '../../../src/i18n/en/permissions.json';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { INGEST_PARSER_VERSION } from '../../../src/fleet/ingest/domain/bundle-ingest.domain';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string | null }
describeIntegration('gated fleet ingest routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let stranger: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let jobId: string;
  let artifactId: string;
  let kick: ReturnType<typeof vi.spyOn<BundleIngestService, 'kick'>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (path: string, token = agent.apiKey) => request(server()).post(`/api/fleet/ingest/${path}`).set(auth(token));
  const pending = async (path = 'backfill', key = 'fleet.ingest.backfill') => {
    const res = await post(path).expect(202);
    const summary = data<Pending>(res);
    expect(summary).toMatchObject({ permissionKey: key, projectId: null });
    return summary;
  };
  const approve = async (id: string) => data<{ status: string; result: unknown }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    stranger = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['fleet.ingest.backfill', 'fleet.ingest.rerun'], null);
    await grantKeys(db, { type: 'AGENT', id: stranger.id }, ['project.read'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    kick = vi.spyOn(BundleIngestService.prototype, 'kick').mockImplementation(() => undefined);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.fleetJob.deleteMany();
    await seedWaitPolicy(db, 'fleet.ingest.backfill', null);
    await seedWaitPolicy(db, 'fleet.ingest.rerun', null);
    const job = await db.fleetJob.create({ data: { projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: 'ingest', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1 } });
    jobId = job.id;
    const artifact = await db.fleetJobArtifact.create({ data: { jobId, leaseEpoch: 1, kind: 'bundle', storageKey: `jobs/${jobId}/1/a.tar.gz`, sizeBytes: BigInt(1), sha256: 'a'.repeat(64) } });
    artifactId = artifact.id;
  });
  afterEach(() => { vi.restoreAllMocks(); });
  it('AC-1: global backfill waits', async () => { await pending(); });
  it('AC-2: waiting backfill writes nothing and does not wake', async () => {
    await pending();
    expect(await db.fleetBundleIngest.count({ where: { artifactId } })).toBe(0);
    expect(kick).not.toHaveBeenCalled();
  });
  it('AC-3: approved backfill writes one row and saves the result', async () => {
    const summary = await pending();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { queued: 1 } });
    expect(await db.fleetBundleIngest.count({ where: { artifactId } })).toBe(1);
  });
  it('AC-4: approved backfill wakes once after commit', async () => {
    const summary = await pending();
    let visible: Promise<number> | undefined;
    kick.mockImplementation(() => { visible = db.fleetBundleIngest.count({ where: { artifactId } }); });
    expect((await approve(summary.id)).status).toBe('executed');
    expect(kick).toHaveBeenCalledOnce();
    expect(await visible).toBe(1);
  });
  it('AC-5: job rerun waits globally', async () => { await pending(`jobs/${jobId}/rerun`, 'fleet.ingest.rerun'); });
  it('AC-6: deleted pending target fails at execution', async () => {
    const summary = await pending(`jobs/${jobId}/rerun`, 'fleet.ingest.rerun');
    await db.fleetJob.delete({ where: { id: jobId } });
    expect((await approve(summary.id)).status).toBe('failed');
    expect(kick).not.toHaveBeenCalled();
  });
  it('AC-7: outdated rerun executes the frozen global command', async () => {
    await db.fleetBundleIngest.create({ data: { artifactId, jobId, leaseEpoch: 1, status: 'done', parserVersion: INGEST_PARSER_VERSION - 1 } });
    const summary = await pending('rerun-outdated', 'fleet.ingest.rerun');
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { queued: 1 } });
  });
  it('AC-8: root and no-policy agent execute immediately without requests', async () => {
    expect(data(await post('backfill', world.tokens.root).expect(201))).toEqual({ queued: 1 });
    expect(await db.approvalRequest.count()).toBe(0);
    await db.approvalPolicy.deleteMany();
    expect(data(await post('backfill').expect(201))).toEqual({ queued: 0 });
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-9: a read-only agent cannot open a request', async () => {
    const res = await post('backfill', stranger.apiKey).expect(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(permissions['40003']);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
