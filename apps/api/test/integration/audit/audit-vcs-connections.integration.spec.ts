import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { VcsPollingService } from '../../../src/vcs/vcs-polling.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('VCS connection audit (real AppModule)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  let token: string;
  let viewerToken: string;
  let projectId: string;
  let rootId: string;
  const previousKey = process.env.VCS_ENCRYPTION_KEY;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const connectionPath = '/api/projects/vcs-audit/vcs';

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    app = await bootHttpApp({ registrationEnabled: true });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'vcs-audit-root@koda.test', name: 'Root', password: TEST_PASSWORD,
    }).expect(201);
    token = data<{ accessToken: string }>(registered).accessToken;
    const root = await db.user.findUniqueOrThrow({ where: { email: 'vcs-audit-root@koda.test' } });
    rootId = root.id;
    await request(server).post('/api/projects').set(auth())
      .send({ name: 'VCS Audit', slug: 'vcs-audit', key: 'VAU' }).expect(201);
    projectId = (await db.project.findUniqueOrThrow({ where: { slug: 'vcs-audit' } })).id;
    await request(server).post('/api/admin/users').set(auth()).send({
      email: 'vcs-audit-viewer@koda.test', name: 'Viewer', password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    viewerToken = await loginToken(server, 'vcs-audit-viewer@koda.test');
    await request(server).post('/api/projects/vcs-audit/members').set(auth())
      .send({ email: 'vcs-audit-viewer@koda.test', roleKey: 'viewer' }).expect(201);
  });

  beforeEach(() => resetThrottle(app));

  afterAll(async () => {
    await app?.close();
    if (previousKey === undefined) delete process.env.VCS_ENCRYPTION_KEY;
    else process.env.VCS_ENCRYPTION_KEY = previousKey;
  });

  it('audits create, update, legacy secret generation, rotation and delete transactionally', async () => {
    const recorder = app.get(AuditRecorder);
    const refreshSchedule = vi.spyOn(app.get(VcsPollingService), 'refreshConnectionSchedule');
    const originalRecord = recorder.record.bind(recorder);
    const rejectCreate = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'vcs.connection.create') throw new Error('audit down');
      await originalRecord(input);
    });

    const rejectedCreate = await request(server).post(connectionPath).set(auth()).send({
      provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_audit_token', syncMode: 'webhook',
    });
    expect(rejectedCreate.status).toBeGreaterThanOrEqual(500);
    expect(await db.vcsConnection.count({ where: { projectId } })).toBe(0);
    expect(await db.auditEntry.count({ where: { projectId, key: 'vcs.connection.create' } })).toBe(0);
    expect(refreshSchedule).not.toHaveBeenCalled();
    rejectCreate.mockRestore();
    refreshSchedule.mockRestore();

    const created = data<{ id: string; webhookSecret: string }>(await request(server).post(connectionPath).set(auth()).send({
      provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_audit_token', syncMode: 'webhook',
    }).expect(201));
    let rows = await db.auditEntry.findMany({ where: { resourceId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'vcs.connection.create', resourceType: 'vcs-connection', resourceId: created.id,
      actorType: 'USER', actorId: rootId, projectId, origin: 'rest',
      summary: 'github acme/app, sync webhook',
    });
    expect(JSON.stringify(rows.map((row) => row.summary))).not.toContain('ghp_audit_token');
    expect(JSON.stringify(rows.map((row) => row.summary))).not.toContain(created.webhookSecret);
    await request(server).post(connectionPath).set(auth()).send({
      provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_second', syncMode: 'webhook',
    }).expect(409);
    expect(await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.connection.create' } })).toBe(1);

    const existingUpdates = await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.connection.update' } });
    await request(server).patch(connectionPath).set(auth()).send({ token: 'ghp_rotated', syncMode: 'polling' }).expect(200);
    rows = await db.auditEntry.findMany({ where: { resourceId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.at(-1)?.summary).toBe('fields: syncMode, token');
    const updateCount = rows.filter((row) => row.key === 'vcs.connection.update').length;
    expect(updateCount).toBe(existingUpdates + 1);
    await request(server).patch(connectionPath).set({ Authorization: `Bearer ${viewerToken}` }).send({ syncMode: 'off' }).expect(403);
    expect(await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.connection.update' } })).toBe(updateCount);
    await request(server).patch(connectionPath).set(auth()).send({}).expect(200);
    expect(await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.connection.update' } })).toBe(updateCount);

    const beforeFailedUpdate = await db.vcsConnection.findUniqueOrThrow({ where: { id: created.id } });
    const rejectUpdate = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'vcs.connection.update') throw new Error('audit down');
      await originalRecord(input);
    });
    const failedUpdate = await request(server).patch(connectionPath).set(auth()).send({ pollingIntervalMs: 90000 });
    expect(failedUpdate.status).toBeGreaterThanOrEqual(500);
    expect(await db.vcsConnection.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      pollingIntervalMs: beforeFailedUpdate.pollingIntervalMs,
      encryptedToken: beforeFailedUpdate.encryptedToken,
      syncMode: beforeFailedUpdate.syncMode,
    });
    rejectUpdate.mockRestore();

    await db.vcsConnection.update({ where: { id: created.id }, data: { webhookSecret: null } });
    const updatesBeforeLegacySecret = await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.connection.update' } });
    await request(server).patch(connectionPath).set(auth()).send({ syncMode: 'webhook' }).expect(200);
    rows = await db.auditEntry.findMany({ where: { resourceId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.at(-1)?.summary).toBe('fields: syncMode, webhookSecret');
    expect(await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.connection.update' } })).toBe(updatesBeforeLegacySecret + 1);

    const beforeRotate = (await db.vcsConnection.findUniqueOrThrow({ where: { id: created.id } })).webhookSecret;
    const rotationsBefore = await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.webhook-secret.rotate' } });
    const rotateResponse = await request(server).post(`${connectionPath}/webhook-secret/rotate`).set(auth()).expect(200);
    const rotated = data<{ webhookSecret: string }>(rotateResponse).webhookSecret;
    expect(rotated).not.toBe(beforeRotate);
    rows = await db.auditEntry.findMany({ where: { resourceId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.at(-1)?.summary).toBe('webhook secret rotated');
    expect(await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.webhook-secret.rotate' } })).toBe(rotationsBefore + 1);
    expect(JSON.stringify(rows.map((row) => row.summary))).not.toContain(rotated);

    const rejectRotate = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'vcs.webhook-secret.rotate') throw new Error('audit down');
      await originalRecord(input);
    });
    const failedRotation = await request(server).post(`${connectionPath}/webhook-secret/rotate`).set(auth());
    expect(failedRotation.status).toBeGreaterThanOrEqual(500);
    expect((await db.vcsConnection.findUniqueOrThrow({ where: { id: created.id } })).webhookSecret).toBe(rotated);
    rejectRotate.mockRestore();

    const rejectDelete = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'vcs.connection.delete') throw new Error('audit down');
      await originalRecord(input);
    });
    const failedDelete = await request(server).delete(connectionPath).set(auth());
    expect(failedDelete.status).toBeGreaterThanOrEqual(500);
    expect(await db.vcsConnection.findUnique({ where: { id: created.id } })).not.toBeNull();
    rejectDelete.mockRestore();

    await request(server).delete(connectionPath).set(auth()).expect(204);
    rows = await db.auditEntry.findMany({ where: { resourceId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.at(-1)).toMatchObject({ key: 'vcs.connection.delete', summary: 'deleted github acme/app' });
    const deleteCount = rows.filter((row) => row.key === 'vcs.connection.delete').length;
    await request(server).delete(connectionPath).set(auth()).expect(404);
    expect(await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.connection.delete' } })).toBe(deleteCount);
    const rotateCount = await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.webhook-secret.rotate' } });
    await request(server).post(`${connectionPath}/webhook-secret/rotate`).set(auth()).expect(404);
    expect(await db.auditEntry.count({ where: { resourceId: created.id, key: 'vcs.webhook-secret.rotate' } })).toBe(rotateCount);
  });
});
