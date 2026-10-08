/**
 * Fleet S4a §1: the notifications migration backfills watchers from reporters, user assignees and user
 * commenters of live tickets.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notifications-backfill-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TARGET = '20261009090000_notifications_core';

interface WatchRow { ticketId: string; userId: string; reason: string; muted: boolean }

describeIntegration('notifications core migration backfill (S4a §1)', () => {
  jest.setTimeout(60000);
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'notifications_core_migration', TARGET);
    const { db } = scratch;
    await db.$executeRawUnsafe(`
      INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt") VALUES
        ('u-rep', 'rep@k.t', 'x', CURRENT_TIMESTAMP),
        ('u-asg', 'asg@k.t', 'x', CURRENT_TIMESTAMP),
        ('u-com', 'com@k.t', 'x', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Agent" ("id", "name", "slug", "apiKeyHash", "updatedAt") VALUES ('a-1', 'Bot', 'bot', 'h', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Ticket" ("id", "projectId", "number", "type", "title", "createdByUserId", "assignedToUserId", "assignedToAgentId", "deletedAt", "updatedAt") VALUES
        ('t-live',    'p1', 1, 'TASK', 'a', 'u-rep', 'u-asg', NULL,  NULL,              CURRENT_TIMESTAMP),
        ('t-self',    'p1', 2, 'TASK', 'b', 'u-rep', 'u-rep', NULL,  NULL,              CURRENT_TIMESTAMP),
        ('t-agent',   'p1', 3, 'TASK', 'c', NULL,    NULL,    'a-1', NULL,              CURRENT_TIMESTAMP),
        ('t-deleted', 'p1', 4, 'TASK', 'd', 'u-rep', 'u-asg', NULL,  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Comment" ("id", "ticketId", "body", "authorUserId", "authorAgentId", "updatedAt") VALUES
        ('c1', 't-live',    'x', 'u-com', NULL,  CURRENT_TIMESTAMP),
        ('c2', 't-live',    'y', 'u-com', NULL,  CURRENT_TIMESTAMP),
        ('c3', 't-live',    'z', 'u-asg', NULL,  CURRENT_TIMESTAMP),
        ('c4', 't-agent',   'w', NULL,    'a-1', CURRENT_TIMESTAMP),
        ('c5', 't-deleted', 'v', 'u-com', NULL,  CURRENT_TIMESTAMP)
    `);
    await applyMigration(db, TARGET);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  const watchers = (ticketId: string): Promise<WatchRow[]> => scratch.db.$queryRawUnsafe<WatchRow[]>(
    `SELECT "ticketId", "userId", "reason", "muted" FROM "TicketWatcher" WHERE "ticketId" = '${ticketId}' ORDER BY "userId"`,
  );

  it('adds reporter, user assignee and each distinct user commenter once, first reason wins', async () => {
    expect(await watchers('t-live')).toEqual([
      { ticketId: 't-live', userId: 'u-asg', reason: 'ASSIGNEE', muted: false },
      { ticketId: 't-live', userId: 'u-com', reason: 'COMMENTER', muted: false },
      { ticketId: 't-live', userId: 'u-rep', reason: 'REPORTER', muted: false },
    ]);
  });

  it('keeps one row when the reporter is also the assignee', async () => {
    expect(await watchers('t-self')).toEqual([{ ticketId: 't-self', userId: 'u-rep', reason: 'REPORTER', muted: false }]);
  });

  it('adds no watcher for agents or deleted tickets', async () => {
    expect(await watchers('t-agent')).toEqual([]);
    expect(await watchers('t-deleted')).toEqual([]);
  });

  it('creates the notification and preference tables empty with their unique keys', async () => {
    const rows = await scratch.db.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('Notification', 'NotificationPreference', 'TicketWatcher') ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(expect.arrayContaining([
      'Notification_userId_sourceType_sourceId_kind_key',
      'Notification_userId_readAt_createdAt_idx',
      'Notification_userId_createdAt_idx',
      'NotificationPreference_pkey',
      'TicketWatcher_pkey',
      'TicketWatcher_userId_idx',
    ]));
  });
});
