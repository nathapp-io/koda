import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const slug = 'audit-labels-projects';
const timeout = 30_000;

describeIntegration('US-005 audited label definitions and project writes', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let projectId: string;
  let rootToken: string;
  let memberToken: string;
  let memberId: string;

  const auth = (token = rootToken) => ({ Authorization: `Bearer ${token}` });
  const rows = (key: string, resourceId: string) => db.auditEntry.findMany({ where: { key, resourceId }, orderBy: { createdAt: 'asc' } });
  const createLabel = async (name: string) => {
    const response = await request(server).post(`/api/projects/${slug}/labels`).set(auth()).send({ name, color: '#123456' }).expect(201);
    return data<{ id: string; name: string }>(response);
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'audit-us005-root@koda.test', name: 'Audit root', password: TEST_PASSWORD,
    }).expect(201);
    rootToken = data<{ accessToken: string }>(registered).accessToken;
    const project = await request(server).post('/api/projects').set(auth()).send({
      name: 'Audit labels projects', slug, key: 'ALP',
    }).expect(201);
    projectId = data<{ id: string }>(project).id;
    const user = await request(server).post('/api/admin/users').set(auth()).send({
      email: 'audit-us005-member@koda.test', name: 'Member', password: TEST_PASSWORD,
    }).expect(201);
    memberId = data<{ id: string }>(user).id;
    await grantRole(db, { type: 'USER', id: memberId }, 'viewer', projectId);
    memberToken = await loginToken(server, 'audit-us005-member@koda.test');
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  it('AC-1: label create returns 201', async () => {
    const response = await request(server).post(`/api/projects/${slug}/labels`).set(auth()).send({ name: 'secret-name', color: '#123456' }).expect(201);
    expect(data<{ name: string }>(response).name).toBe('secret-name');
  }, timeout);

  it('AC-2: label create persists the expected audit row', async () => {
    const label = await createLabel('secret-name-ac2');
    const entries = await rows('label.create', label.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'label.create', resourceType: 'label', resourceId: label.id, projectId, summary: 'created' });
  }, timeout);

  it("AC-3: label update records only 'fields: name'", async () => {
    const label = await createLabel('before');
    await request(server).patch(`/api/projects/${slug}/labels/${label.id}`).set(auth()).send({ name: 'renamed' }).expect(200);
    const entries = await rows('label.update', label.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'label.update', resourceType: 'label', resourceId: label.id, projectId, summary: 'fields: name' });
  }, timeout);

  it("AC-4: label delete records 'deleted'", async () => {
    const label = await createLabel('to-delete');
    await request(server).delete(`/api/projects/${slug}/labels/${label.id}`).set(auth()).expect(204);
    const entries = await rows('label.delete', label.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'label.delete', resourceType: 'label', resourceId: label.id, projectId, summary: 'deleted' });
  }, timeout);

  it('AC-5: label create/update summaries do not expose names', async () => {
    const label = await createLabel('secret-name-ac5');
    await request(server).patch(`/api/projects/${slug}/labels/${label.id}`).set(auth()).send({ name: 'renamed-ac5' }).expect(200);
    const summaries = [...await rows('label.create', label.id), ...await rows('label.update', label.id)].map((entry) => entry.summary ?? '');
    expect(summaries).toEqual(['created', 'fields: name']);
    expect(summaries.join(' ')).not.toContain('secret-name');
    expect(summaries.join(' ')).not.toContain('renamed');
  }, timeout);

  it('AC-6: project.create permission holder receives 201', async () => {
    await request(server).post('/api/projects').set(auth()).send({ name: 'Create AC6', slug: 'audit-ac6', key: 'ACSS' }).expect(201);
  }, timeout);

  it('AC-7: project create persists the keyed audit row', async () => {
    const response = await request(server).post('/api/projects').set(auth()).send({ name: 'Create AC7', slug: 'audit-ac7', key: 'ACSE' }).expect(201);
    const project = data<{ id: string }>(response);
    const entries = await rows('project.create', project.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'project.create', resourceType: 'project', resourceId: project.id, projectId: project.id, summary: 'created ACSE' });
  }, timeout);

  it("AC-8: project patch summarizes sorted fields", async () => {
    await request(server).patch(`/api/projects/${slug}`).set(auth()).send({ name: 'Renamed', description: 'd' }).expect(200);
    const entries = await rows('project.update', projectId);
    expect(entries.at(-1)).toMatchObject({ key: 'project.update', resourceType: 'project', resourceId: projectId, projectId, summary: 'fields: description, name' });
  }, timeout);

  it('AC-9: CI webhook token patch never exposes token value', async () => {
    const token = 'us005-secret-token-value-that-is-long-enough';
    await request(server).patch(`/api/projects/${slug}`).set(auth()).send({ ciWebhookToken: token }).expect(200);
    const entries = await rows('project.update', projectId);
    expect(entries.at(-1)?.summary).toBe('fields: ciWebhookToken');
    expect(entries.at(-1)?.summary).not.toContain(token);
  }, timeout);

  it("AC-10: project delete persists 'deleted <KEY>'", async () => {
    const response = await request(server).post('/api/projects').set(auth()).send({ name: 'Delete AC10', slug: 'audit-ac10', key: 'ACTN' }).expect(201);
    const project = data<{ id: string }>(response);
    await request(server).delete('/api/projects/audit-ac10').set(auth()).expect(204);
    const entries = await rows('project.delete', project.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'project.delete', resourceType: 'project', resourceId: project.id, projectId: project.id, summary: 'deleted ACTN' });
  }, timeout);

  it('AC-11: member without project.delete is refused', async () => {
    await request(server).delete(`/api/projects/${slug}`).set(auth(memberToken)).expect(403);
  }, timeout);

  it('AC-12: refused project delete produces no project.delete row', async () => {
    await request(server).delete(`/api/projects/${slug}`).set(auth(memberToken)).expect(403);
    expect(await rows('project.delete', projectId)).toHaveLength(0);
  }, timeout);
});
