/**
 * Fleet S4b US-002: a notification written for a project member is scheduled, then delivered once by the
 * dispatcher (unless the member reads it first). AC28-AC30.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/email/email-dispatcher.integration.spec.ts
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NOTIFY_SERVICE } from '@nathapp/nestjs-notify';
import { AppModule } from '../../../src/app.module';
import { EmailDispatcher } from '../../../src/email/email-dispatcher';
import { NotificationWriter } from '../../../src/notifications/notification-writer';
import { MeNotificationsService } from '../../../src/notifications/me-notifications.service';
import type { NotificationDraft } from '../../../src/notifications/notification.types';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

const DELAY_MS = 300_000;

describeIntegration('EmailDispatcher end-to-end (PG) (S4b US-002)', () => {
  let nest: TestingModule;
  let app: INestApplication;
  let prisma: PrismaClient;
  let writer: NotificationWriter;
  let dispatcher: EmailDispatcher;
  let me: MeNotificationsService;
  const ids = { b: '', bEmail: '', actor: '', project: '' };

  const draft = (over: Partial<NotificationDraft> = {}): NotificationDraft => ({
    userId: ids.b, projectId: ids.project, category: 'ASSIGNED', kind: 'ticket_assigned', title: 'Assigned',
    body: null, link: '/p/tickets/PP-1', params: {}, sourceType: 'ticket_event', sourceId: `evt-${randomUUID()}`,
    actorId: ids.actor, ...over,
  });

  beforeAll(async () => {
    process.env.SMTP_URL = 'smtp://127.0.0.1:2525';
    process.env.EMAIL_FROM = 'koda@example.com';
    process.env.WEB_PUBLIC_URL = 'https://koda.example.com';
    await resetDb();
    nest = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = nest.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService).client as PrismaClient;
    writer = app.get(NotificationWriter);
    dispatcher = app.get(EmailDispatcher);
    me = app.get(MeNotificationsService);

    const unique = randomUUID();
    ids.bEmail = `b-${unique}@k.t`;
    ids.b = (await prisma.user.create({ data: { email: ids.bEmail, name: 'B', passwordHash: 'x' } })).id;
    ids.actor = (await prisma.user.create({ data: { email: `actor-${unique}@k.t`, name: 'Actor', passwordHash: 'x' } })).id;
    ids.project = (await prisma.project.create({ data: { name: 'P', slug: `p-${unique}`, key: 'PP' } })).id;
    await prisma.projectMember.create({ data: { projectId: ids.project, userId: ids.b, role: 'DEVELOPER' } });
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('US-002 AC28: an assigned notification is scheduled at createdAt + EMAIL_DELAY_SEC and sent once to the member address', async () => {
    await writer.deliver([draft()]);
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: ids.b, kind: 'ticket_assigned' } });
    const row = await prisma.emailSchedule.findUniqueOrThrow({ where: { notificationId: note.id } });
    expect(row.dueAt).toEqual(new Date(note.createdAt.getTime() + DELAY_MS));

    const send = vi.spyOn(app.get(NOTIFY_SERVICE), 'send').mockResolvedValue({} as never);
    await dispatcher.tick(new Date(row.dueAt.getTime() + 1000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(expect.objectContaining({ recipient: ids.bEmail }));
    expect(await prisma.emailSchedule.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'SENT' });
  });

  it('US-002 AC29: a second tick after the send never calls the channel again', async () => {
    await writer.deliver([draft()]);
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: ids.b, kind: 'ticket_assigned' } });
    const row = await prisma.emailSchedule.findUniqueOrThrow({ where: { notificationId: note.id } });

    const send = vi.spyOn(app.get(NOTIFY_SERVICE), 'send').mockResolvedValue({} as never);
    await dispatcher.tick(new Date(row.dueAt.getTime() + 1000));
    expect(send).toHaveBeenCalledTimes(1);
    await dispatcher.tick(new Date(row.dueAt.getTime() + 61_000));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('US-002 AC30: reading the notification before its due time skips the email with reason READ', async () => {
    const target = draft({ sourceId: `evt-read-${randomUUID()}` });
    await writer.deliver([target]);
    const note = await prisma.notification.findFirstOrThrow({ where: { sourceId: target.sourceId } });
    const row = await prisma.emailSchedule.findUniqueOrThrow({ where: { notificationId: note.id } });

    await me.markRead(ids.b, note.id);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: note.id } })).readAt).not.toBeNull();

    const send = vi.spyOn(app.get(NOTIFY_SERVICE), 'send').mockResolvedValue({} as never);
    await dispatcher.tick(new Date(row.dueAt.getTime() + 1000));
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.emailSchedule.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'SKIPPED', skipReason: 'READ' });
  });
});
