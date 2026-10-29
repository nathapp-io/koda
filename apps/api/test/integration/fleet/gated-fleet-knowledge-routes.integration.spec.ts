import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import knowledge from '../../../src/i18n/en/knowledge.json';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { KnowledgeIndexQueue } from '../../../src/fleet/knowledge/knowledge-index.queue';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
describeIntegration('gated fleet knowledge routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let enabledBefore: boolean;
  let enqueue: ReturnType<typeof vi.spyOn<KnowledgeIndexQueue, 'enqueue'>>;
  const config = () => app.get<IFleetConfig>(FLEET_CFG);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const reindex = (token = agent.apiKey) => request(app.getHttpServer()).post(`/api/projects/web/knowledge/repos/${world.repoId}/reindex`).set(auth(token));
  const patterns = (value: unknown) => request(app.getHttpServer()).put('/api/projects/web/knowledge/patterns').set(auth(agent.apiKey)).send({ patterns: value });
  const pendingReindex = async () => {
    const summary = data<Pending>(await reindex().expect(202));
    expect(summary).toMatchObject({ permissionKey: 'fleet.knowledge.repo.reindex', projectId: world.projectId });
    return summary;
  };
  const approve = async (id: string) => data<{ status: string; result: { patterns?: string[] } }>(await request(app.getHttpServer()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'fleet.knowledge.patterns.update', 'fleet.knowledge.repo.reindex'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    enabledBefore = config().knowledgeIndexEnabled;
    config().knowledgeIndexEnabled = true;
    enqueue = vi.spyOn(app.get(KnowledgeIndexQueue), 'enqueue').mockImplementation(() => undefined);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.auditEntry.deleteMany();
    await seedWaitPolicy(db, 'fleet.knowledge.repo.reindex', world.projectId);
    await seedWaitPolicy(db, 'fleet.knowledge.patterns.update', world.projectId);
  });
  afterEach(() => { config().knowledgeIndexEnabled = enabledBefore; vi.restoreAllMocks(); });
  it('AC-1: agent reindex waits in the project without waking', async () => {
    await pendingReindex();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('AC-3: approval records exactly one reindex audit for the repository', async () => {
    const summary = await pendingReindex();
    expect((await approve(summary.id)).status).toBe('executed');
    expect(await db.auditEntry.count({ where: { key: 'fleet.knowledge.repo.reindex', resourceId: world.repoId } })).toBe(1);
  });
  it('AC-4: approval enqueues once after commit', async () => {
    const summary = await pendingReindex();
    let visible: Promise<number> | undefined;
    enqueue.mockImplementation(() => { visible = db.auditEntry.count({ where: { key: 'fleet.knowledge.repo.reindex', resourceId: world.repoId } }); });
    expect((await approve(summary.id)).status).toBe('executed');
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(world.repoId, 'admin');
    expect(await visible).toBe(1);
  });
  it('AC-5: disabled indexing refuses before opening a request', async () => {
    config().knowledgeIndexEnabled = false;
    const res = await reindex().expect(409);
    expect(res.body.message).toBe(knowledge.disabled['409']);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-6: agent patterns save waits', async () => {
    expect(data<Pending>(await patterns(['docs/**/*.md']).expect(202))).toMatchObject({ permissionKey: 'fleet.knowledge.patterns.update', projectId: world.projectId });
  });
  it('AC-7: approval persists and returns frozen patterns', async () => {
    const summary = data<Pending>(await patterns(['docs/**/*.md']).expect(202));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: { patterns: ['docs/**/*.md'] } });
    expect((await db.knowledgeProjectPatterns.findUniqueOrThrow({ where: { projectId: world.projectId } })).patterns).toEqual(['docs/**/*.md']);
  });
  it('AC-8: invalid patterns refuse before opening a request', async () => {
    const res = await patterns(['']).expect(400);
    expect(res.body.message).toBe(knowledge.input['400'].replace('{reason}', 'patterns[0]'));
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-9: developer reindex executes immediately without a request', async () => {
    expect(data(await reindex(world.tokens.dev).expect(202))).toEqual({ queued: true });
    expect(await db.approvalRequest.count()).toBe(0);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(world.repoId, 'admin');
  });
  it('fails approval if indexing was disabled while waiting', async () => {
    const summary = await pendingReindex();
    config().knowledgeIndexEnabled = false;
    expect((await approve(summary.id)).status).toBe('failed');
    expect(enqueue).not.toHaveBeenCalled();
    expect(await db.auditEntry.count({ where: { key: 'fleet.knowledge.repo.reindex', resourceId: world.repoId } })).toBe(0);
  });
});
