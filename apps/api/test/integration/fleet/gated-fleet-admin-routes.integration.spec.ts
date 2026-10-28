import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { insertRunner, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { insertAnalyticsJob, insertCostEvent, insertStoryResult, insertReviewResult } from '../../helpers/fleet-analytics-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const keys = ['fleet.repo.create', 'fleet.repo.delete', 'fleet.repo.check', 'fleet.runner.update', 'fleet.runner.delete', 'fleet.analytics.delete'];
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Decided { status: string; result: unknown }

describeIntegration('gated fleet admin routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let stranger: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let forge: ReturnType<typeof vi.spyOn<GitHubAppClient, 'verifyRepo'>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const body = { projectSlug: 'web', provider: 'github', owner: 'acme', name: 'new-repo' };
  const pending = (res: request.Response, permissionKey: string) => {
    expect(res.status).toBe(202);
    const summary = data<Pending>(res);
    expect(summary).toMatchObject({ permissionKey, projectId: null });
    return summary;
  };
  const approve = async (id: string) => data<Decided>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const fixtureRepo = () => db.fleetRepo.create({ data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'target', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root } });
  const analyticsFixture = async () => {
    const jobId = await insertAnalyticsJob(db, { projectId: world.projectId, repoId: world.repoId, requestedById: world.ids.root }, { finishedAt: new Date('2025-01-01T00:00:00Z') });
    const owner = { projectId: world.projectId, repoId: world.repoId, jobId };
    await insertCostEvent(db, owner, { at: new Date('2025-01-01T00:00:00Z') });
    await insertCostEvent(db, owner, { at: new Date('2027-01-01T00:00:00Z') });
    await insertStoryResult(db, owner, { completedAt: new Date('2025-01-01T00:00:00Z') });
    await insertReviewResult(db, owner, { at: new Date('2025-01-01T00:00:00Z') });
    return jobId;
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    stranger = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, keys, null);
    await app.get(PermissionCache).invalidate();
    forge = vi.spyOn(app.get(GitHubAppClient), 'verifyRepo');
  }, 60_000);
  afterAll(async () => { forge?.mockRestore(); await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    forge.mockReset().mockResolvedValue({ owner: 'acme', name: 'new-repo', defaultBranch: 'main', installationId: BigInt(77) });
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.fleetCostEvent.deleteMany();
    await db.fleetStoryResult.deleteMany();
    await db.fleetReviewResult.deleteMany();
    await db.fleetJob.deleteMany();
    await db.fleetRepo.deleteMany({ where: { id: { notIn: [world.repoId, world.foreignRepoId] } } });
  });
  it('AC-1/AC-2: create waits without registering, then approval executes', async () => {
    const summary = pending(await request(server()).post('/api/fleet/repos').set(auth(agent.apiKey)).send(body), 'fleet.repo.create');
    expect(await db.fleetRepo.count({ where: { name: body.name } })).toBe(0);
    expect(forge).not.toHaveBeenCalled();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { name: body.name } });
    expect(await db.fleetRepo.count({ where: { name: body.name } })).toBe(1);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } })).status).toBe('executed');
  });
  it('AC-3: forge refusal at execution fails without registration', async () => {
    const summary = pending(await request(server()).post('/api/fleet/repos').set(auth(agent.apiKey)).send(body), 'fleet.repo.create');
    const forgeFailure = new Error('forge unavailable');
    forge.mockRejectedValue(forgeFailure);
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: forgeFailure.name } });
    expect(await db.fleetRepo.count({ where: { name: body.name } })).toBe(0);
  });
  it('AC-4: repo delete waits then unregisters', async () => {
    const repo = await fixtureRepo();
    const summary = pending(await request(server()).delete(`/api/fleet/repos/${repo.id}`).set(auth(agent.apiKey)), 'fleet.repo.delete');
    expect(await db.fleetRepo.findUnique({ where: { id: repo.id } })).not.toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: null });
    expect(await db.fleetRepo.findUnique({ where: { id: repo.id } })).toBeNull();
  });
  it('AC-5: repo check waits then stores its verdict', async () => {
    const summary = pending(await request(server()).post(`/api/fleet/repos/${world.repoId}/check`).set(auth(agent.apiKey)), 'fleet.repo.check');
    expect(forge).not.toHaveBeenCalled();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { repoId: world.repoId, reachable: expect.any(Boolean) } });
  });
  it('AC-6: runner update waits then disables', async () => {
    const runner = await insertRunner(db, { createdById: world.ids.root });
    const summary = pending(await request(server()).patch(`/api/fleet/runners/${runner.id}`).set(auth(agent.apiKey)).send({ enabled: false }), 'fleet.runner.update');
    expect((await db.runner.findUniqueOrThrow({ where: { id: runner.id } })).enabled).toBe(true);
    expect((await approve(summary.id)).status).toBe('executed');
    expect((await db.runner.findUniqueOrThrow({ where: { id: runner.id } })).enabled).toBe(false);
  });
  it('AC-7: runner delete waits then removes', async () => {
    const runner = await insertRunner(db, { createdById: world.ids.root });
    const summary = pending(await request(server()).delete(`/api/fleet/runners/${runner.id}`).set(auth(agent.apiKey)), 'fleet.runner.delete');
    expect(await db.runner.findUnique({ where: { id: runner.id } })).not.toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: null });
    expect(await db.runner.findUnique({ where: { id: runner.id } })).toBeNull();
  });
  it('AC-8: analytics delete waits then removes only rows before the cutoff', async () => {
    const jobId = await analyticsFixture();
    const summary = pending(await request(server()).delete('/api/fleet/analytics?before=2026-01-01T00:00:00Z').set(auth(agent.apiKey)).send({ confirm: 'ALL' }), 'fleet.analytics.delete');
    expect(await db.fleetCostEvent.count({ where: { jobId } })).toBe(2);
    expect((await approve(summary.id)).status).toBe('executed');
    expect(await db.fleetCostEvent.count({ where: { jobId } })).toBe(1);
    expect(await db.fleetStoryResult.count({ where: { jobId } })).toBe(0);
    expect(await db.fleetReviewResult.count({ where: { jobId } })).toBe(0);
  });
  it('AC-9: missing or malformed before refuses before opening a request', async () => {
    for (const query of ['', '?before=bad']) await request(server()).delete(`/api/fleet/analytics${query}`).set(auth(agent.apiKey)).send({ confirm: 'ALL' }).expect(400);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-10: a mismatched project confirmation fails at execution and leaves rows', async () => {
    const jobId = await analyticsFixture();
    const summary = pending(await request(server()).delete(`/api/fleet/analytics?before=2026-01-01T00:00:00Z&projectId=${world.projectId}`).set(auth(agent.apiKey)).send({ confirm: 'wrong' }), 'fleet.analytics.delete');
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new ValidationAppException({ expected: 'web' }, 'fleet.analyticsDelete').name } });
    expect(await db.fleetCostEvent.count({ where: { jobId } })).toBe(2);
    expect(await db.fleetStoryResult.count({ where: { jobId } })).toBe(1);
    expect(await db.fleetReviewResult.count({ where: { jobId } })).toBe(1);
  });
  it('AC-11: root deletes immediately with 204 and no request', async () => {
    const runner = await insertRunner(db, { createdById: world.ids.root });
    await request(server()).delete(`/api/fleet/runners/${runner.id}`).set(auth(world.tokens.root)).expect(204);
    expect(await db.runner.findUnique({ where: { id: runner.id } })).toBeNull();
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('a keyless agent cannot mutate or open a request', async () => {
    await request(server()).delete(`/api/fleet/repos/${world.repoId}`).set(auth(stranger.apiKey)).expect(403);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.fleetRepo.findUnique({ where: { id: world.repoId } })).not.toBeNull();
  });
});
