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
  let token: string;
  let ticketRef: string;
  let ticketId: string;
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
    const project = await request(server).post('/api/projects').set(auth()).send({ name: 'Audit', slug, key: 'AUD' }).expect(201);
    projectId = data<{ id: string }>(project).id;
    const user = await request(server).post('/api/admin/users').set(auth()).send({
      email: 'audit-user@koda.test', name: 'Audit user', password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    userId = data<{ id: string }>(user).id;
    await grantRole(db, { type: 'USER', id: userId }, 'developer', projectId);
    await grantRole(db, { type: 'USER', id: userId }, 'project-admin', projectId);
    token = await loginToken(server, 'audit-user@koda.test');
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  const auditRows = (key: string, resourceId?: string) => db.auditEntry.findMany({
    where: { key, projectId, ...(resourceId ? { resourceId } : {}) }, orderBy: { createdAt: 'asc' },
  });

  it('AC-1..3: POST creates a ticket and an actor-bound audit row with its ref summary', async () => {
    const response = await request(server).post(`/api/projects/${slug}/tickets`).set(auth()).send({ type: 'BUG', title: 'private title' }).expect(201);
    const created = data<{ id: string; ref: string }>(response);
    ticketId = created.id;
    ticketRef = created.ref;
    const entries = await auditRows('ticket.create', ticketId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ resourceType: 'ticket', actorType: 'USER', actorId: userId, origin: 'rest', summary: `created ${ticketRef}` });
  }, describeTimeout);

  it('AC-7..9: PATCH records field names only', async () => {
    await request(server).patch(`/api/projects/${slug}/tickets/${ticketRef}`).set(auth()).send({ title: 'New title', priority: 'HIGH' }).expect(200);
    const rows = await auditRows('ticket.update', ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('fields: priority, title');
    expect(rows[0].summary).not.toContain('New title');
  }, describeTimeout);

  it('AC-19: rolls back the first attempt audit row and commits one on ticket-number retry', async () => {
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
    } finally {
      spy.mockRestore();
    }
  }, describeTimeout);

  it('AC-10..11: DELETE records ticket ref summary', async () => {
    await request(server).delete(`/api/projects/${slug}/tickets/${ticketRef}`).set(auth()).expect(200);
    const rows = await auditRows('ticket.delete', ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe(`deleted ${ticketRef}`);
  }, describeTimeout);
});
