import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { RagService } from '../../../src/rag/rag.service';
import { PrismaRagRepository } from '../../../src/rag/prisma-rag.repository';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { VectorStore } from '../../../src/rag/vector-store.service';
import { AUDIT_STORAGE, type IAuditStorage } from '@nathapp/nestjs-audit';
import { ApprovalRequestEvents } from '../../../src/approvals/approval-request-events';
import { ApprovalExecutionService } from '../../../src/approvals/approval-execution.service';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
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
  it('F2: keeps the creator recheck and replacement under the shared write lock', async () => {
    const id = await open();
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const original = rag.findSourceCreators.bind(rag);
    const spy = vi.spyOn(rag, 'findSourceCreators').mockImplementationOnce(async (...args) => {
      const rows = await original(...args); entered(); await resume; return rows;
    });
    const approval = approve(id);
    await reading;
    const rootWrite = rag.indexDocument(world.projectId, { source: 'manual', sourceId, content: 'root wins later', metadata: {}, createdBy: { type: 'USER', id: world.ids.root } });
    try {
      expect(await Promise.race([rootWrite.then(() => 'written'), new Promise(resolve => setTimeout(() => resolve('blocked'), 50))])).toBe('blocked');
    } finally { release(); spy.mockRestore(); expect(await approval).toMatchObject({ status: 'executed' }); await rootWrite; }
    expect(await creators()).toEqual([{ type: 'USER', id: world.ids.root }]);
  });
  it.each(['audit', 'settlement'] as const)('F3: restores the replaced row when %s fails after the LanceDB write', async failure => {
    const previousId = await rag.indexDocument(world.projectId, { source: 'manual', sourceId, content: 'previous content', metadata: {}, createdBy: { type: 'AGENT', id: agent.id } });
    const id = await open();
    const storage = app.get<IAuditStorage>(AUDIT_STORAGE);
    const events = app.get(ApprovalRequestEvents);
    const recordAudit = storage.record.bind(storage);
    const recordEvent = events.record.bind(events);
    let injected = false;
    const indexed = vi.spyOn(rag, 'indexDocument');
    const spy = failure === 'audit'
      ? vi.spyOn(storage, 'record').mockImplementation(async entry => { if (entry.action === 'kb.document.add') { injected = true; throw new Error('injected audit failure'); } return recordAudit(entry); })
      : vi.spyOn(events, 'record').mockImplementation(async row => { if (row.id === id && row.status === 'executed') { injected = true; throw new Error('injected settlement failure'); } return recordEvent(row); });
    try {
      expect(await approve(id)).toMatchObject({ status: 'failed' });
      expect(injected).toBe(true);
      expect(indexed).toHaveBeenCalledTimes(1);
      expect(await indexed.mock.results[0]?.value).toEqual(expect.any(String));
      const rows = (await rag.listDocuments(world.projectId)).filter(row => row.sourceId === sourceId);
      expect(rows).toEqual([expect.objectContaining({ id: previousId, content: 'previous content' })]);
      expect(await db.auditEntry.count({ where: { key: 'kb.document.add', approvalRequestId: id } })).toBe(0);
    } finally { spy.mockRestore(); indexed.mockRestore(); }
  });
  it('F3: transaction-owner rollback restores the old row and leaves approval safely retryable', async () => {
    const previousId = await rag.indexDocument(world.projectId, { source: 'manual', sourceId, content: 'previous content', metadata: {}, createdBy: { type: 'AGENT', id: agent.id } });
    const id = await open();
    const manager = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    const run = manager.run.bind(manager);
    let injected = false;
    const spy = vi.spyOn(manager, 'run').mockImplementation(async work => run(async () => {
      const value = await work();
      if (typeof value === 'object' && value !== null && 'id' in value && value.id === id && 'status' in value && value.status === 'executed') {
        injected = true;
        throw new Error('transaction owner rejects after callback returns');
      }
      return value;
    }));
    try {
      await request(app.getHttpServer()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(500);
      expect(injected).toBe(true);
      expect(await db.approvalRequest.findUnique({ where: { id } })).toMatchObject({ status: 'approved' });
      expect((await rag.listDocuments(world.projectId)).filter(row => row.sourceId === sourceId)).toEqual([expect.objectContaining({ id: previousId, content: 'previous content' })]);
      expect(await db.auditEntry.count({ where: { key: 'kb.document.add', approvalRequestId: id } })).toBe(0);
    } finally { spy.mockRestore(); }
    expect(await app.get(ApprovalExecutionService).execute(id)).toMatchObject({ status: 'executed' });
    expect(await db.auditEntry.count({ where: { key: 'kb.document.add', approvalRequestId: id } })).toBe(1);
  });
  it('F3: commit proof waits for an in-flight owner instead of observing an uncommitted audit as absent', async () => {
    const repository = app.get(PrismaRagRepository);
    const manager = app.get<ITransactionManager>(TRANSACTION_MANAGER);
    const audit = app.get(AuditRecorder);
    const id = `proof-${sourceId}`;
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const owner = withTestActor({ type: 'USER', id: world.ids.root }, () => manager.run(async () => {
      await repository.lockAdditionIntent(id);
      await audit.record({ id, key: 'kb.document.add', projectId: world.projectId, resourceType: 'kb-document', resourceId: `manual:${sourceId}` });
      entered(); await resume;
    }));
    await Promise.race([locked, owner]);
    let resolved = false;
    const proof = repository.withAdditionCommitProof(id, async committed => { resolved = true; expect(committed).toBe(true); });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(resolved).toBe(false);
    } finally { release(); await owner; await proof; }
    expect(resolved).toBe(true);
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
