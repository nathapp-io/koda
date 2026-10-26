import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ALLOWED = 'https://93.184.215.14/hook';
const OTHER_ALLOWED = 'https://93.184.215.15/hook';
const SECRET = 'Private-secret-1-0123456789abcdef';
const UPDATED_SECRET = 'Private-secret-2-0123456789abcdef';

describeIntegration('webhook configuration audit (real AppModule)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  let token: string;
  let rootId: string;
  let auditProjectId: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const projectPath = '/api/projects/wh-audit/webhooks';

  async function createWebhook(url = ALLOWED, secret?: string, slug = 'wh-audit'): Promise<string> {
    const response = await request(server).post(`/api/projects/${slug}/webhooks`).set(auth()).send({
      url, events: ['STATUS_CHANGE'], ...(secret ? { secret } : {}),
    }).expect(201);
    return data<{ id: string }>(response).id;
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'webhook-audit-root@koda.test', name: 'Root', password: TEST_PASSWORD,
    }).expect(201);
    token = data<{ accessToken: string }>(registered).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'webhook-audit-root@koda.test' } })).id;
    await request(server).post('/api/projects').set(auth()).send({
      name: 'Webhook Audit', slug: 'wh-audit', key: 'WHA',
    }).expect(201);
    await request(server).post('/api/projects').set(auth()).send({
      name: 'Webhook Other', slug: 'wh-other', key: 'WHO',
    }).expect(201);
    auditProjectId = (await db.project.findUniqueOrThrow({ where: { slug: 'wh-audit' } })).id;
  }, 60_000);

  beforeEach(() => resetThrottle(app));
  afterAll(async () => { await app?.close(); });

  it('AC-1–AC-12: persists webhook audit entries and rolls back refused writes', async () => {
    const createResponse = await request(server).post(projectPath).set(auth()).send({
      url: ALLOWED, events: ['STATUS_CHANGE'], secret: SECRET,
    }).expect(201);
    const createdId = data<{ id: string }>(createResponse).id;
    const createdEntry = await db.auditEntry.findFirstOrThrow({
      where: { key: 'webhook.create', resourceId: createdId },
    });
    expect(createdEntry).toMatchObject({
      resourceType: 'webhook', projectId: auditProjectId, actorType: 'USER', actorId: rootId,
      origin: 'rest', summary: 'created',
    });
    expect(createdEntry.summary).not.toContain(SECRET);
    expect(createdEntry.summary).not.toContain('93.184.215.14');

    const createCount = await db.auditEntry.count({ where: { key: 'webhook.create' } });
    await request(server).post(projectPath).set(auth()).send({
      url: 'https://10.0.0.5/hook', events: ['STATUS_CHANGE'],
    }).expect(400);
    expect(await db.auditEntry.count({ where: { key: 'webhook.create' } })).toBe(createCount);

    const recorder = app.get(AuditRecorder);
    const originalRecord = recorder.record.bind(recorder);
    const rejectNext = (key: string) => vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === key) throw new Error('audit down');
      await originalRecord(input);
    });

    const failedCreateSpy = rejectNext('webhook.create');
    const failedCreate = await request(server).post(projectPath).set(auth()).send({
      url: OTHER_ALLOWED, events: ['STATUS_CHANGE'],
    });
    expect(failedCreate.status).toBeGreaterThanOrEqual(500);
    expect(await db.webhook.count({ where: { projectId: auditProjectId, url: OTHER_ALLOWED } })).toBe(0);
    failedCreateSpy.mockRestore();

    await request(server).patch(`${projectPath}/${createdId}`).set(auth()).send({
      secret: UPDATED_SECRET, active: false,
    }).expect(200);
    let updateEntry = await db.auditEntry.findFirstOrThrow({
      where: { key: 'webhook.update', resourceId: createdId },
    });
    expect(updateEntry.summary).toBe('fields: active, secret');
    expect(updateEntry.summary).not.toContain(UPDATED_SECRET);

    const failedUpdateSpy = rejectNext('webhook.update');
    const failedUpdate = await request(server).patch(`${projectPath}/${createdId}`).set(auth()).send({ active: true });
    expect(failedUpdate.status).toBeGreaterThanOrEqual(500);
    expect((await db.webhook.findUniqueOrThrow({ where: { id: createdId } })).active).toBe(false);
    failedUpdateSpy.mockRestore();

    const foreignId = await createWebhook(OTHER_ALLOWED, undefined, 'wh-other');
    await request(server).patch(`${projectPath}/${foreignId}`).set(auth()).send({ active: false }).expect(404);
    expect(await db.auditEntry.count({ where: { key: 'webhook.update', resourceId: foreignId } })).toBe(0);

    const projectDeleteId = await createWebhook();
    await request(server).delete(`${projectPath}/${projectDeleteId}`).set(auth()).expect(204);
    expect(await db.auditEntry.findFirstOrThrow({ where: { key: 'webhook.delete', resourceId: projectDeleteId } }))
      .toMatchObject({ projectId: auditProjectId, summary: 'deleted' });

    const globalDeleteId = await createWebhook(OTHER_ALLOWED);
    await request(server).delete(`/api/webhooks/${globalDeleteId}`).set(auth()).expect(204);
    expect(await db.auditEntry.findFirstOrThrow({ where: { key: 'webhook.delete', resourceId: globalDeleteId } }))
      .toMatchObject({ projectId: auditProjectId, summary: 'deleted' });

    const retainedId = await createWebhook();
    const failedDeleteSpy = rejectNext('webhook.delete');
    const failedDelete = await request(server).delete(`${projectPath}/${retainedId}`).set(auth());
    expect(failedDelete.status).toBeGreaterThanOrEqual(500);
    expect(await db.webhook.findUnique({ where: { id: retainedId } })).not.toBeNull();
    failedDeleteSpy.mockRestore();

    await request(server).delete('/api/webhooks/missing-webhook').set(auth()).expect(404);
    expect(await db.auditEntry.count({ where: { key: 'webhook.delete', resourceId: 'missing-webhook' } })).toBe(0);

    await request(server).patch(`${projectPath}/${createdId}`).set(auth()).send({}).expect(200);
    updateEntry = await db.auditEntry.findFirstOrThrow({
      where: { key: 'webhook.update', resourceId: createdId }, orderBy: { createdAt: 'desc' },
    });
    expect(updateEntry.summary).toBeNull();
  });
});
