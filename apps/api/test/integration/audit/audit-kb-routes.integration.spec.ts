import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { RagService } from '../../../src/rag/rag.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const slug = 'kb-audit';
const timeout = 30_000;

describeIntegration('US-001 audited KB routes', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let rag: RagService;
  let audit: AuditRecorder;
  let projectId: string;
  let rootToken: string;
  let devToken: string;
  let rootId: string;
  let devId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const kb = (path: string) => `/api/projects/${slug}/kb${path}`;
  const entries = (key: string, resourceId: string) => db.auditEntry.findMany({ where: { key, resourceId } });
  const add = (token: string, source: 'doc' | 'manual', sourceId: string, content = 'Private content') =>
    request(server).post(kb('/documents')).set(auth(token)).send({ source, sourceId, content });

  beforeAll(async () => {
    const previous = process.env['EMBEDDING_PROVIDER'];
    process.env['EMBEDDING_PROVIDER'] = 'fake';
    try {
      await resetDb();
      app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    } finally {
      if (previous === undefined) delete process.env['EMBEDDING_PROVIDER'];
      else process.env['EMBEDDING_PROVIDER'] = previous;
    }
    server = app.getHttpServer();
    db = fixtureDb(app);
    rag = app.get(RagService);
    audit = app.get(AuditRecorder);

    const root = await request(server).post('/api/auth/register').send({ email: 'kb-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string }>(root).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'kb-root@koda.test' } })).id;
    const project = await request(server).post('/api/projects').set(auth(rootToken)).send({ name: 'KB Audit', slug, key: 'KBA' }).expect(201);
    projectId = data<{ id: string }>(project).id;
    const created = await request(server).post('/api/admin/users').set(auth(rootToken)).send({ email: 'kb-dev@koda.test', name: 'Dev', password: TEST_PASSWORD }).expect(201);
    devId = data<{ id: string }>(created).id;
    await grantRole(db, { type: 'USER', id: devId }, 'developer', projectId);
    devToken = await loginToken(server, 'kb-dev@koda.test');
  }, 120_000);

  afterAll(async () => { await app?.close(); });
  beforeEach(() => resetThrottle(app));

  it('AC-1/2/3: add records actor, project, source identity and a content-free summary', async () => {
    await add(devToken, 'manual', 'runbook').expect(201);
    const row = await entries('kb.document.add', 'manual:runbook');
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ key: 'kb.document.add', resourceType: 'kb-document', projectId, actorType: 'USER', actorId: devId, origin: 'rest', summary: 'added manual document' });
    await add(devToken, 'doc', 'private-doc').expect(201);
    expect((await entries('kb.document.add', 'doc:private-doc'))[0]?.summary).not.toContain('Private content');
  }, timeout);

  it('AC-4/5/28/29: ownership refusals preserve rows and create no audit entry', async () => {
    await add(rootToken, 'manual', 'root-doc', 'root content').expect(201);
    const before = await rag.listDocuments(projectId, 500);
    const priorAdds = await entries('kb.document.add', 'manual:root-doc');
    await add(devToken, 'manual', 'root-doc', 'replacement').expect(403);
    expect(await entries('kb.document.add', 'manual:root-doc')).toHaveLength(priorAdds.length);
    await request(server).delete(kb('/documents/root-doc?source=manual')).set(auth(devToken)).expect(403);
    expect(await rag.listDocuments(projectId, 500)).toEqual(before);
    expect(await entries('kb.document.delete', 'manual:root-doc')).toHaveLength(0);
  }, timeout);

  it('AC-6/7: failed audit responds in error after preserving the completed KB store write', async () => {
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (input) => {
      if (input.key === 'kb.document.add') throw new Error('audit down');
    });
    try {
      const response = await add(devToken, 'manual', 'failing-add');
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await rag.listDocuments(projectId, 500)).some((row) => row.source === 'manual' && row.sourceId === 'failing-add')).toBe(true);
    } finally { spy.mockRestore(); }
  }, timeout);

  it('AC-8/9/10/11/12: deletes are audited only for nonempty sources, after each store delete', async () => {
    await add(rootToken, 'manual', 'del-1', 'one').expect(201);
    await request(server).delete(kb('/documents/del-1?source=manual')).set(auth(rootToken)).expect(200);
    expect(await entries('kb.document.delete', 'manual:del-1')).toMatchObject([{ actorId: rootId, summary: 'deleted 1 manual rows' }]);
    await add(rootToken, 'doc', 'both', 'doc').expect(201);
    await add(rootToken, 'manual', 'both', 'manual').expect(201);
    await request(server).delete(kb('/documents/both')).set(auth(rootToken)).expect(200);
    expect(await entries('kb.document.delete', 'doc:both')).toHaveLength(1);
    expect(await entries('kb.document.delete', 'manual:both')).toHaveLength(1);
    await request(server).delete(kb('/documents/nothing-here')).set(auth(rootToken)).expect(200);
    expect(await entries('kb.document.delete', 'doc:nothing-here')).toHaveLength(0);
    expect(await entries('kb.document.delete', 'manual:nothing-here')).toHaveLength(0);
  }, timeout);

  it('AC-15..21: graphify audits completed imports only', async () => {
    await db.project.update({ where: { id: projectId }, data: { graphifyEnabled: true } });
    const response = await request(server).post(kb('/import/graphify')).set(auth(rootToken)).send({ nodes: [{ id: 'n1', label: 'Private label', type: 'module' }, { id: 'n2', label: 'Other', type: 'module' }], links: [] }).expect(200);
    const result = data<{ cleared: number }>(response);
    const row = await entries('kb.graphify.import', projectId);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ resourceType: 'project', summary: `imported 2 nodes, cleared ${result.cleared}` });
    expect(row[0]?.summary).not.toContain('Private label');
    await request(server).post(kb('/import/graphify')).set(auth(rootToken)).send({ nodes: [], links: [] }).expect(200);
    expect(await entries('kb.graphify.import', projectId)).toHaveLength(1);
    await db.project.update({ where: { id: projectId }, data: { graphifyEnabled: false } });
    await request(server).post(kb('/import/graphify')).set(auth(rootToken)).send({ nodes: [{ id: 'n3', label: 'x' }], links: [] }).expect(400);
    expect(await entries('kb.graphify.import', projectId)).toHaveLength(1);
  }, timeout);

  it('AC-22..25: optimize records for its authorized actor only', async () => {
    await request(server).post(kb('/optimize')).set(auth(rootToken)).expect(200);
    const row = await entries('kb.optimize', projectId);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ resourceType: 'project', projectId, actorId: rootId, summary: 'kb table optimized' });
    await request(server).post(kb('/optimize')).set(auth(devToken)).expect(403);
    expect(await entries('kb.optimize', projectId)).toHaveLength(1);
  }, timeout);
});
