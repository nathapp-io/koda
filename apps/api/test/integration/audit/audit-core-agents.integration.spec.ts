import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { PrismaAgentRepository } from '../../../src/agents/prisma-agent.repository';
import { MembershipService } from '../../../src/permissions/membership.service';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
type Created = { apiKey: string; agent: { id: string; slug: string } };

describeIntegration('audited agent writes', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let adminToken: string;
  let adminId: string;
  let memberToken: string;
  let projectId: string;
  let serial = 0;
  const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
  const rows = (key: string, id: string) => db.auditEntry.findMany({ where: { key, resourceId: id }, take: 10 });
  const create = async (capabilities = ['old']) => {
    const slug = `audit-agent-${++serial}`;
    const res = await request(server).post('/api/agents').set(auth()).send({ slug, name: slug, capabilities }).expect(201);
    return data<Created>(res);
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const root = await request(server).post('/api/auth/register').send({ email: 'agent-audit-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    adminToken = data<{ accessToken: string }>(root).accessToken;
    const admin = await request(server).post('/api/admin/users').set(auth()).send({ email: 'agent-audit-admin@koda.test', name: 'Admin', password: TEST_PASSWORD }).expect(201);
    adminId = data<{ id: string }>(admin).id;
    await grantRole(db, { type: 'USER', id: adminId }, 'admin', null);
    await app.get(MembershipService).invalidatePermissions();
    adminToken = await loginToken(server, 'agent-audit-admin@koda.test');
    await request(server).post('/api/admin/users').set(auth()).send({ email: 'agent-audit-member@koda.test', name: 'Member', password: TEST_PASSWORD }).expect(201);
    memberToken = await loginToken(server, 'agent-audit-member@koda.test');
    const project = await request(server).post('/api/projects').set(auth()).send({ slug: 'agent-audit', name: 'Audit', key: 'AGAU' }).expect(201);
    projectId = data<{ id: string }>(project).id;
  }, 60_000);
  beforeEach(() => { resetThrottle(app); });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await app?.close(); });

  it('AC-1/2/3: admin create succeeds and attributes one safe global entry to the admin', async () => {
    const result = await create();
    const entries = await rows('agent.create', result.agent.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'agent.create', resourceType: 'agent', resourceId: result.agent.id, projectId: null, actorType: 'USER', actorId: adminId, summary: `created ${result.agent.slug}` });
    expect(entries[0].summary).not.toContain(result.apiKey);
  });

  it('AC-4/5: rotation attributes a safe entry to the acting admin, not the agent', async () => {
    const result = await create();
    const rotated = await request(server).post(`/api/agents/${result.agent.slug}/rotate-key`).set(auth()).expect(200);
    const entries = await rows('agent.key.rotate', result.agent.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorId: adminId, summary: 'key rotated' });
    expect(entries[0].actorId).not.toBe(result.agent.id);
    expect(entries[0].summary).not.toContain(data<Created>(rotated).apiKey);
  });

  it.each([['AC-6', false], ['AC-7', true]])('%s: either update route audits the global agent row', async (_ac, projectRoute) => {
    const result = await create();
    if (projectRoute) {
      await grantRole(db, { type: 'AGENT', id: result.agent.id }, 'viewer', projectId);
      await app.get(MembershipService).invalidatePermissions();
    }
    const path = projectRoute ? `/api/projects/agent-audit/agents/${result.agent.slug}` : `/api/agents/${result.agent.slug}`;
    await request(server).patch(path).set(auth()).send({ name: 'Renamed' }).expect(200);
    const entries = await rows('agent.update', result.agent.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'agent.update', projectId: null, summary: 'fields: name' });
  });

  it('AC-8: capabilities count is audited without values', async () => {
    const result = await create();
    await request(server).patch(`/api/agents/${result.agent.slug}/update-capabilities`).set(auth()).send({ capabilities: ['a', 'b', 'c'] }).expect(200);
    const entries = await rows('agent.capabilities.update', result.agent.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe('capabilities: 3');
  });

  it.each(['record', 'write'] as const)('AC-11/12/19: %s failure preserves old capabilities and commits no entry', async (failure) => {
    const result = await create();
    if (failure === 'record') {
      vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    } else {
      // Fail after the destructive delete and successful inserts, proving both roll back.
      const repo = app.get(PrismaAgentRepository);
      const replace = repo.replaceCapabilities.bind(repo);
      vi.spyOn(repo, 'replaceCapabilities').mockImplementationOnce(async (id, capabilities) => {
        await replace(id, capabilities);
        throw new Error('capability write failed');
      });
    }
    const response = await request(server).patch(`/api/agents/${result.agent.slug}/update-capabilities`).set(auth()).send({ capabilities: ['a', 'b', 'c'] });
    expect(response.status).toBe(500);
    const stored = await db.agentCapabilityEntry.findMany({ where: { agentId: result.agent.id }, take: 10 });
    expect(stored.map(row => row.capability)).toEqual(['old']);
    expect(await rows('agent.capabilities.update', result.agent.id)).toHaveLength(0);
  });

  it('AC-13/14: delete removes agent and bindings with one audit entry', async () => {
    const result = await create();
    await grantRole(db, { type: 'AGENT', id: result.agent.id }, 'viewer', projectId);
    await request(server).delete(`/api/agents/${result.agent.slug}`).set(auth()).expect(200);
    expect(await db.agent.findUnique({ where: { id: result.agent.id } })).toBeNull();
    expect(await db.roleBinding.count({ where: { principalType: 'AGENT', principalId: result.agent.id } })).toBe(0);
    const entries = await rows('agent.delete', result.agent.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe(`deleted ${result.agent.slug}`);
  });

  it('AC-17/18: refused delete returns 403 without an entry or deletion', async () => {
    const result = await create();
    await request(server).delete(`/api/agents/${result.agent.slug}`).set(auth(memberToken)).expect(403);
    expect(await rows('agent.delete', result.agent.id)).toHaveLength(0);
    expect(await db.agent.count({ where: { id: result.agent.id } })).toBe(1);
  });
});
