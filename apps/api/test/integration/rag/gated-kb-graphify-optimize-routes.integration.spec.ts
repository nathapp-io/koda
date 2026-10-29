import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { RagService } from '../../../src/rag/rag.service';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('gated KB graphify import and optimize', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let nodeId: string;
  let serial = 0;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const graph = () => ({ nodes: [{ id: nodeId, label: `Node ${nodeId}` }], links: [] });
  const post = (route: string, token = agent.apiKey) => request(app.getHttpServer()).post(`/api/projects/web/kb/${route}`).set(auth(token)).send(route === 'import/graphify' ? graph() : {});
  const open = async (route = 'import/graphify') => {
    const res = await post(route);
    expect(res.status).toBe(202);
    expect(data(res)).toMatchObject({ permissionKey: route === 'optimize' ? 'kb.optimize' : 'kb.graphify.import', projectId: world.projectId });
    return data<{ id: string }>(res).id;
  };
  const approve = async (id: string) => data<{ status: string; result: unknown }>(await request(app.getHttpServer()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  beforeAll(async () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'fake');
    try { await resetDb(); app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null }); }
    finally { vi.unstubAllEnvs(); }
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'kb.graphify.import', 'kb.optimize'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 120_000);
  afterAll(async () => { await app?.close(); });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    resetThrottle(app); nodeId = `graphify-gated-${++serial}`;
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    await db.project.update({ where: { id: world.projectId }, data: { graphifyEnabled: true } });
    await db.auditEntry.deleteMany({ where: { projectId: world.projectId, key: { in: ['kb.graphify.import', 'kb.optimize'] } } });
    await seedWaitPolicy(db, 'kb.graphify.import', world.projectId);
    await seedWaitPolicy(db, 'kb.optimize', world.projectId);
  });
  it('AC-1: graphify waits without importing', async () => {
    const spy = vi.spyOn(RagService.prototype, 'importGraphify');
    await open(); expect(spy).not.toHaveBeenCalled();
  });
  it('AC-2: approval stores the document and imported count', async () => {
    const id = await open();
    expect(await approve(id)).toMatchObject({ status: 'executed', result: { imported: 1 } });
    expect(await db.approvalRequest.findUnique({ where: { id } })).toMatchObject({ status: 'executed', result: { imported: 1 } });
    expect(await app.get(RagService).listDocuments(world.projectId)).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: nodeId, source: 'code' })]));
  });
  it('AC-3: approval records exactly one graphify audit', async () => {
    const id = await open(); expect(await approve(id)).toMatchObject({ status: 'executed' });
    expect(await db.auditEntry.count({ where: { key: 'kb.graphify.import', projectId: world.projectId } })).toBe(1);
    expect(await db.auditEntry.count({ where: { key: 'kb.graphify.import', projectId: world.projectId, approvalRequestId: id, actorId: agent.id } })).toBe(1);
  });
  it('AC-4: disabled graphify is rejected before opening a request', async () => {
    await db.project.update({ where: { id: world.projectId }, data: { graphifyEnabled: false } });
    const res = await post('import/graphify');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: 'rag.graphifyDisabled.-2' });
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-5: approved optimize settles executed with its result', async () => {
    const id = await open('optimize');
    expect(await approve(id)).toMatchObject({ status: 'executed', result: { optimized: true } });
    expect(await db.approvalRequest.findUnique({ where: { id } })).toMatchObject({ status: 'executed', result: { optimized: true } });
    expect(await db.auditEntry.count({ where: { key: 'kb.optimize', approvalRequestId: id } })).toBe(1);
  });
  it('AC-6: optimize failure produces no audit', async () => {
    const id = await open('optimize');
    vi.spyOn(RagService.prototype, 'optimizeTable').mockRejectedValue(new TypeError('store unavailable'));
    expect(await approve(id)).toMatchObject({ status: 'failed' });
    expect(await db.auditEntry.count({ where: { key: 'kb.optimize', approvalRequestId: id } })).toBe(0);
  });
  it.each([['import/graphify', 'importGraphify', 'kb.graphify.import'], ['optimize', 'optimizeTable', 'kb.optimize']] as const)('AC-11: %s prepare failure stores the error name', async (route, method, key) => {
    const id = await open(route);
    vi.spyOn(RagService.prototype, method).mockRejectedValue(new RangeError('injected prepare failure'));
    expect(await approve(id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'RangeError' } });
    expect(await db.approvalRequest.findUnique({ where: { id } })).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'RangeError' } });
    expect(await db.auditEntry.count({ where: { key, approvalRequestId: id } })).toBe(0);
  });
  it.each(['import/graphify', 'optimize'])('immediate %s keeps its result and one audit', async route => {
    await db.approvalPolicy.deleteMany();
    const key = route === 'optimize' ? 'kb.optimize' : 'kb.graphify.import';
    const res = await post(route); expect(res.status).toBe(200);
    expect(data(res)).toMatchObject(route === 'optimize' ? { optimized: true } : { imported: 1 });
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.auditEntry.count({ where: { key, projectId: world.projectId, approvalRequestId: null, actorId: agent.id } })).toBe(1);
  });
});
