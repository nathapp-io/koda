import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { RagService } from '../../../src/rag/rag.service';
import { VectorStore } from '../../../src/rag/vector-store.service';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('gated KB addition', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let rag: RagService;
  let sourceId: string;
  let serial = 0;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const add = (token = agent.apiKey) => request(app.getHttpServer()).post('/api/projects/web/kb/documents').set(auth(token)).send({ source: 'manual', sourceId, content: 'hello', metadata: { kodaCreatedBy: { type: 'USER', id: 'spoof' } } });
  const open = async () => {
    const res = await add();
    expect(res.status).toBe(202);
    expect(data(res)).toMatchObject({ permissionKey: 'kb.document.add', projectId: world.projectId });
    return data<{ id: string }>(res).id;
  };
  const approve = async (id: string) => data<{ status: string }>(await request(app.getHttpServer()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const creators = () => rag.findSourceCreators(world.projectId, 'manual', sourceId);
  beforeAll(async () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'fake');
    try { await resetDb(); app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null }); }
    finally { vi.unstubAllEnvs(); }
    db = fixtureDb(app); rag = app.get(RagService);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'kb.document.add'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 120_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app); sourceId = `add-${++serial}`;
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await seedWaitPolicy(db, 'kb.document.add', world.projectId);
  });
  it('AC-1: waits with permission and project', async () => { await open(); });
  it('AC-2: pending has no indexed document', async () => {
    await open();
    expect((await rag.listDocuments(world.projectId)).filter(row => row.sourceId === sourceId)).toEqual([]);
    expect(await creators()).toEqual([]);
  });
  it('AC-3: approval writes one row attributed to the agent', async () => {
    const id = await open(); expect(await approve(id)).toMatchObject({ status: 'executed' });
    expect(await creators()).toEqual([{ type: 'AGENT', id: agent.id }]);
    expect(await db.auditEntry.count({ where: { key: 'kb.document.add', approvalRequestId: id, actorId: agent.id } })).toBe(1);
  });
  it('AC-4: approval embeds exactly once, not while pending', async () => {
    const spy = vi.spyOn(VectorStore.prototype, 'embedForIndex');
    try {
      const id = await open(); expect(spy).not.toHaveBeenCalled();
      expect(await approve(id)).toMatchObject({ status: 'executed' });
      expect(spy).toHaveBeenCalledExactlyOnceWith('hello');
    } finally { spy.mockRestore(); }
  });
  it('AC-5: root replacement during wait fails execution and survives', async () => {
    const id = await open(); await add(world.tokens.root).expect(201);
    expect(await approve(id)).toMatchObject({ status: 'failed' });
    expect(await creators()).toEqual([{ type: 'USER', id: world.ids.root }]);
  });
  it('AC-6: no policy executes immediately without a request', async () => {
    await db.approvalPolicy.deleteMany();
    const spy = vi.spyOn(VectorStore.prototype, 'embedForIndex');
    try {
      const res = await add();
      expect(res.status).toBe(201); expect(data(res)).toMatchObject({ indexed: true });
      expect(await db.approvalRequest.count()).toBe(0);
      expect(spy).toHaveBeenCalledExactlyOnceWith('hello');
    } finally { spy.mockRestore(); }
  });
});
