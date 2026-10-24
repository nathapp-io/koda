import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { Prisma } from '../../../src/generated/prisma/client';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const describeTimeout = 30_000;

describeIntegration('US-002 audited ticket route writes', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let projectId: string;
  let userId: string;
  let rootToken: string;
  let viewerId: string;
  let agentId: string;
  let agentToken: string;
  let token: string;
  const slug = 'audit-tickets';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'audit-root@koda.test', name: 'Audit root', password: TEST_PASSWORD,
    }).expect(201);
    token = data<{ accessToken: string }>(registered).accessToken;
    rootToken = token;
    const project = await request(server).post('/api/projects').set(auth()).send({ name: 'Audit', slug, key: 'AUD' }).expect(201);
    projectId = data<{ id: string }>(project).id;
    const user = await request(server).post('/api/admin/users').set(auth()).send({
      email: 'audit-user@koda.test', name: 'Audit user', password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    userId = data<{ id: string }>(user).id;
    await grantRole(db, { type: 'USER', id: userId }, 'developer', projectId);
    await grantRole(db, { type: 'USER', id: userId }, 'project-admin', projectId);
    const viewer = await request(server).post('/api/admin/users').set({ Authorization: `Bearer ${rootToken}` }).send({
      email: 'audit-viewer@koda.test', name: 'Audit viewer', password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    viewerId = data<{ id: string }>(viewer).id;
    await grantRole(db, { type: 'USER', id: viewerId }, 'viewer', projectId);
    const agent = await request(server).post('/api/agents').set({ Authorization: `Bearer ${rootToken}` }).send({ name: 'Audit agent', slug: 'audit-agent' }).expect(201);
    const agentData = data<{ apiKey: string; agent: { id: string } }>(agent);
    agentId = agentData.agent.id;
    agentToken = agentData.apiKey;
    await grantRole(db, { type: 'AGENT', id: agentId }, 'developer', projectId);
    token = await loginToken(server, 'audit-user@koda.test');
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  const auditRows = (key: string, resourceId?: string) => db.auditEntry.findMany({
    where: { key, projectId, ...(resourceId ? { resourceId } : {}) }, orderBy: { createdAt: 'asc' },
  });
  const createTicket = async (authHeader: Record<string, string> = auth()) => {
    const response = await request(server).post(`/api/projects/${slug}/tickets`).set(authHeader).send({ type: 'BUG', title: 'ticket fixture' }).expect(201);
    return data<{ id: string; ref: string }>(response);
  };

  it('AC-1..3: POST creates a ticket and an actor-bound audit row with its ref summary', async () => {
    const response = await request(server).post(`/api/projects/${slug}/tickets`).set(auth()).send({ type: 'BUG', title: 'private title' }).expect(201);
    const created = data<{ id: string; ref: string }>(response);
    const entries = await auditRows('ticket.create', created.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resourceType: 'ticket', actorType: 'USER', actorId: userId, origin: 'rest', summary: `created ${created.ref}` });
  }, describeTimeout);

  it('AC-4: an agent create records its actor identity', async () => {
    const response = await request(server).post(`/api/projects/${slug}/tickets`).set({ Authorization: `Bearer ${agentToken}` }).send({ type: 'BUG', title: 'agent ticket' }).expect(201);
    const created = data<{ id: string; ref: string }>(response);
    const rows = await auditRows('ticket.create', created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'AGENT', actorId: agentId, origin: 'rest', summary: `created ${created.ref}` });
  }, describeTimeout);

  it('AC-5..6: a viewer create is refused and writes no create audit row', async () => {
    const before = await auditRows('ticket.create');
    const viewerToken = await loginToken(server, 'audit-viewer@koda.test');
    await request(server).post(`/api/projects/${slug}/tickets`).set({ Authorization: `Bearer ${viewerToken}` }).send({ type: 'BUG', title: 'refused' }).expect(403);
    expect(await auditRows('ticket.create')).toHaveLength(before.length);
  }, describeTimeout);

  it('AC-7..9: PATCH records field names only', async () => {
    const target = await createTicket();
    await request(server).patch(`/api/projects/${slug}/tickets/${target.ref}`).set(auth()).send({ title: 'New title', priority: 'HIGH' }).expect(200);
    const rows = await auditRows('ticket.update', target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('fields: priority, title');
    expect(rows[0].summary).not.toContain('New title');
  }, describeTimeout);

  it('AC-19: rolls back the first attempt audit row and commits one on ticket-number retry', async () => {
    const projectCreateCount = await db.auditEntry.count({ where: { key: 'ticket.create', projectId } });
    const recorder = app.get(AuditRecorder);
    const record = recorder.record.bind(recorder);
    const conflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['projectId', 'number'] },
    });
    let attempts = 0;
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      await record(input);
      attempts += 1;
      if (attempts === 1) throw conflict;
    });
    try {
      const response = await request(server).post(`/api/projects/${slug}/tickets`).set(auth()).send({ type: 'BUG', title: 'retry audit' }).expect(201);
      const created = data<{ id: string }>(response);
      const rows = await auditRows('ticket.create', created.id);
      expect(attempts).toBe(2);
      expect(rows).toHaveLength(1);
      expect(await db.auditEntry.count({ where: { key: 'ticket.create', projectId } })).toBe(projectCreateCount + 1);
    } finally {
      spy.mockRestore();
    }
  }, describeTimeout);

  it('AC-12..16: assignment audits user, agent, and none; invalid dual assignment writes nothing', async () => {
    const createdResponse = await request(server).post(`/api/projects/${slug}/tickets`).set(auth()).send({ type: 'BUG', title: 'assign target' }).expect(201);
    const target = data<{ id: string; ref: string }>(createdResponse);
    const endpoint = `/api/projects/${slug}/tickets/${target.ref}/assign`;

    await request(server).post(endpoint).set(auth()).send({ userId }).expect(200);
    expect((await auditRows('ticket.assign', target.id)).at(-1)?.summary).toBe(`assignee: USER ${userId}`);

    await request(server).post(endpoint).set(auth()).send({ agentId }).expect(200);
    expect((await auditRows('ticket.assign', target.id)).at(-1)?.summary).toBe(`assignee: AGENT ${agentId}`);

    await request(server).post(endpoint).set(auth()).send({}).expect(200);
    expect((await auditRows('ticket.assign', target.id)).at(-1)?.summary).toBe('assignee: none');

    const beforeInvalid = (await auditRows('ticket.assign', target.id)).length;
    await request(server).post(endpoint).set(auth()).send({ userId, agentId }).expect(400);
    expect((await auditRows('ticket.assign', target.id)).length).toBe(beforeInvalid);
  }, describeTimeout);

  it('AC-10..11: DELETE records ticket ref summary', async () => {
    const target = await createTicket();
    await request(server).delete(`/api/projects/${slug}/tickets/${target.ref}`).set(auth()).expect(200);
    const rows = await auditRows('ticket.delete', target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe(`deleted ${target.ref}`);
  }, describeTimeout);
});
