import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('preferences, watch and outbox audit (real AppModule)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  const entry = (key: string, resourceId: string) => db.auditEntry.findFirstOrThrow({ where: { key, resourceId }, orderBy: { createdAt: 'desc' } });
  const count = (key: string, resourceId?: string) => db.auditEntry.count({ where: { key, ...(resourceId ? { resourceId } : {}) } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({ email: 'audit-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(registered).accessToken;
    ids.root = (await db.user.findUniqueOrThrow({ where: { email: 'audit-root@koda.test' } })).id;
    await grantBaseline(db, { type: 'USER', id: ids.root });
    await request(server).post('/api/projects').set(auth('root')).send({ name: 'Audit', slug: 'nt-audit', key: 'NTA' }).expect(201);
    ids.project = (await db.project.findUniqueOrThrow({ where: { slug: 'nt-audit' } })).id;
    const dev = await request(server).post('/api/admin/users').set(auth('root')).send({ email: 'audit-dev@koda.test', name: 'Dev', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    ids.dev = data<{ id: string }>(dev).id;
    tokens.dev = await loginToken(server, 'audit-dev@koda.test');
    await grantBaseline(db, { type: 'USER', id: ids.dev });
    await request(server).post('/api/projects/nt-audit/members').set(auth('root')).send({ email: 'audit-dev@koda.test', roleKey: 'developer' }).expect(201);
    for (const title of ['First', 'Second']) await request(server).post('/api/projects/nt-audit/tickets').set(auth('root')).send({ type: 'TASK', title }).expect(201);
  }, 60_000);

  beforeEach(async () => resetThrottle(app));
  afterAll(async () => { await app?.close(); });

  it('AC-1–4, AC-14: audits only supplied preferences and rolls category updates back on audit failure', async () => {
    await request(server).put('/api/me/notification-preferences').set(auth('dev')).send({ items: [{ category: 'MENTIONED', email: false }, { category: 'ASSIGNED', inApp: false }] }).expect(200);
    let row = await entry('notification.preference.update', ids.dev);
    expect(row).toMatchObject({ resourceType: 'user', projectId: null, actorId: ids.dev, origin: 'rest', summary: 'fields: ASSIGNED.inApp, MENTIONED.email' });
    await request(server).put('/api/me/notification-preferences').set(auth('dev')).send({ emailEnabled: false }).expect(200);
    row = await entry('notification.preference.update', ids.dev);
    expect(row.summary).toBe('fields: emailEnabled');
    const beforeEmpty = await count('notification.preference.update', ids.dev);
    await request(server).put('/api/me/notification-preferences').set(auth('dev')).send({}).expect(200);
    expect(await count('notification.preference.update', ids.dev)).toBe(beforeEmpty);
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'notification.preference.update') throw new Error('audit down');
      return original(input);
    });
    const rejected = await request(server).put('/api/me/notification-preferences').set(auth('dev')).send({ items: [{ category: 'WATCHED_ACTIVITY', inApp: false }] });
    expect(rejected.status).toBeGreaterThanOrEqual(500);
    spy.mockRestore();
    const prefs = data<{ items: Array<{ category: string; inApp: boolean }> }>(await request(server).get('/api/me/notification-preferences').set(auth('dev')).expect(200));
    expect(prefs.items.find((item) => item.category === 'WATCHED_ACTIVITY')?.inApp).toBe(true);
    await request(server).put('/api/me/notification-preferences').set(auth('dev')).send({ emailEnabled: true, items: [{ category: 'MENTIONED', email: true }] }).expect(200);
    expect((await entry('notification.preference.update', ids.dev)).summary).toBe('fields: MENTIONED.email, emailEnabled');
  });

  it('AC-5–8: audits ticket watch settings, not missing tickets, and rolls back a rejected audit', async () => {
    await request(server).put('/api/projects/nt-audit/tickets/NTA-1/watch').set(auth('dev')).expect(200);
    const ticketId = (await db.ticket.findFirstOrThrow({ where: { projectId: ids.project, number: 1 } })).id;
    expect(await entry('ticket.watch.set', ticketId)).toMatchObject({ resourceType: 'ticket', projectId: ids.project, actorId: ids.dev, summary: 'watching' });
    await request(server).delete('/api/projects/nt-audit/tickets/NTA-1/watch').set(auth('dev')).expect(200);
    expect((await entry('ticket.watch.unset', ticketId)).summary).toBe('muted');
    const before = await count('ticket.watch.set');
    await request(server).put('/api/projects/nt-audit/tickets/NTA-999/watch').set(auth('dev')).expect(404);
    expect(await count('ticket.watch.set')).toBe(before);
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'ticket.watch.set') throw new Error('audit down');
      return original(input);
    });
    const failed = await request(server).put('/api/projects/nt-audit/tickets/NTA-2/watch').set(auth('dev'));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    spy.mockRestore();
    const state = data<{ watching: boolean }>(await request(server).get('/api/projects/nt-audit/tickets/NTA-2/watchers').set(auth('dev')).expect(200));
    expect(state.watching).toBe(false);
  });

  it('AC-9–13: audits successful retries only and keeps inbox read-all bookkeeping unaudited', async () => {
    const createEvent = async (status: string) => db.outboxEvent.create({ data: {
      type: 'ticket_event', eventId: `us003-${crypto.randomUUID()}`, projectId: ids.project, payload: '{}', status,
    } });
    const dead = await createEvent('dead');
    await request(server).post(`/api/admin/outbox/${dead.id}/retry`).set(auth('root')).expect(200);
    expect(await entry('outbox.retry', dead.id)).toMatchObject({ resourceType: 'outbox-event', projectId: ids.project, actorId: ids.root, summary: 'retried ticket_event, was dead' });
    const published = await createEvent('published');
    await request(server).post(`/api/admin/outbox/${published.id}/retry`).set(auth('root')).expect(409);
    expect(await count('outbox.retry', published.id)).toBe(0);
    const failing = await createEvent('dead');
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'outbox.retry') throw new Error('audit down');
      return original(input);
    });
    const response = await request(server).post(`/api/admin/outbox/${failing.id}/retry`).set(auth('root'));
    expect(response.status).toBeGreaterThanOrEqual(500);
    spy.mockRestore();
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: failing.id } })).status).toBe('dead');
    await request(server).post('/api/admin/outbox/missing-event/retry').set(auth('root')).expect(404);
    expect(await count('outbox.retry', 'missing-event')).toBe(0);
    const beforeReads = await db.auditEntry.count({ where: { actorId: ids.dev } });
    await db.notification.create({ data: { userId: ids.dev, category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', link: '/', sourceType: 'ticket_event', sourceId: `us003-${crypto.randomUUID()}` } });
    await request(server).post('/api/me/notifications/read-all').set(auth('dev')).expect(204);
    expect(await db.auditEntry.count({ where: { actorId: ids.dev } })).toBe(beforeReads);
  });
});
