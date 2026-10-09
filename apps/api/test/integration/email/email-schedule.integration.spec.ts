/**
 * Fleet S4b US-001: the EmailSchedule store claim/state behavior on Postgres.
 * AC1-AC7 — exclusive claim under concurrency, no future/INVITE claims, lock recovery, abandonment,
 * idempotent scheduling and the 500-character error cap.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/email/email-schedule.integration.spec.ts
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { TestingModule, Test } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AppModule } from '../../../src/app.module';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { EmailScheduleService } from '../../../src/email/schedule/email-schedule.service';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30_000);

const T0 = new Date('2026-10-10T10:00:00Z');
const min = (n: number): Date => new Date(T0.getTime() + n * 60_000);

interface SeedRow {
  kind: 'NOTIFICATION' | 'INVITE' | 'MEMBER_ADDED';
  status: 'PENDING' | 'SENDING' | 'SENT' | 'SKIPPED' | 'FAILED';
  notificationId: string | null;
  inviteId: string | null;
  userId: string | null;
  projectId: string | null;
  toEmail: string;
  locale: string;
  attempts: number;
  dueAt: Date;
  lockedUntil: Date | null;
}

describeIntegration('EmailScheduleService (PG) (S4b US-001)', () => {
  let nest: TestingModule;
  let app: INestApplication;
  let prisma: PrismaClient;
  let service: EmailScheduleService;

  const seed = async (over: Partial<SeedRow> = {}): Promise<string> => {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "EmailSchedule"
         ("id", "kind", "notificationId", "inviteId", "userId", "projectId", "toEmail", "locale",
          "status", "attempts", "dueAt", "lockedUntil", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
      id,
      over.kind ?? 'MEMBER_ADDED',
      over.notificationId ?? null,
      over.inviteId ?? null,
      over.userId ?? null,
      over.projectId ?? null,
      over.toEmail ?? 'a@x.io',
      over.locale ?? 'en',
      over.status ?? 'PENDING',
      over.attempts ?? 0,
      over.dueAt ?? min(0),
      over.lockedUntil ?? null,
      T0,
    );
    return id;
  };

  const statusOf = async (id: string): Promise<string | undefined> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(`SELECT "status" FROM "EmailSchedule" WHERE "id" = $1`, id);
    return rows[0]?.status;
  };

  const lastErrorLengthOf = async (id: string): Promise<number | undefined> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ lastError: string | null }>>(`SELECT "lastError" FROM "EmailSchedule" WHERE "id" = $1`, id);
    const value = rows[0]?.lastError;
    return value === null || value === undefined ? undefined : value.length;
  };

  const scheduledCount = async (notificationId: string): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS "count" FROM "EmailSchedule" WHERE "notificationId" = $1`,
      notificationId,
    );
    return rows[0]?.count ?? 0;
  };

  beforeAll(async () => {
    await resetDb();
    nest = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const created = nest.createNestApplication();
    await created.init();
    app = created;
    prisma = created.get(PrismaService).client as PrismaClient;
    service = created.get(EmailScheduleService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "EmailSchedule"`);
  });

  it('US-001 AC1: two concurrent claimDue(now, 20) calls over 30 due rows never return a shared id', async () => {
    for (let i = 0; i < 30; i++) await seed({ toEmail: `u${i}@x.io` });
    const [a, b] = await Promise.all([service.claimDue(min(1), 20), service.claimDue(min(1), 20)]);
    const ids = [...a, ...b].map((row) => row.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('US-001 AC2: a PENDING row due after now is not claimed and stays PENDING', async () => {
    const future = await seed({ dueAt: min(10) });
    const claimed = await service.claimDue(min(1), 20);
    expect(claimed.map((row) => row.id)).not.toContain(future);
    expect(await statusOf(future)).toBe('PENDING');
  });

  it('US-001 AC3: an INVITE row is never claimed even when SENDING with an expired lock', async () => {
    const invite = await seed({ kind: 'INVITE', status: 'SENDING', lockedUntil: min(-5) });
    const claimed = await service.claimDue(min(1), 20);
    expect(claimed.map((row) => row.id)).not.toContain(invite);
    expect(await statusOf(invite)).toBe('SENDING');
  });

  it('US-001 AC4: a SENDING row past its lock is claimed with attempts increased by one', async () => {
    const stuck = await seed({ status: 'SENDING', lockedUntil: min(-1), attempts: 1 });
    const claimed = await service.claimDue(min(1), 20);
    const row = claimed.find((candidate) => candidate.id === stuck);
    expect(row).toBeDefined();
    expect(row?.attempts).toBe(2);
  });

  it('US-001 AC5: closeAbandonedInvites marks an INVITE SENDING past its lock FAILED', async () => {
    const invite = await seed({ kind: 'INVITE', status: 'SENDING', lockedUntil: min(-1) });
    const closed = await service.closeAbandonedInvites(min(0));
    expect(closed).toBe(1);
    expect(await statusOf(invite)).toBe('FAILED');
  });

  it('US-001 AC6: scheduleNotifications called twice with one notificationId leaves exactly one row', async () => {
    const user = await prisma.user.create({ data: { email: `sched-${randomUUID()}@k.t`, passwordHash: 'x' } });
    const notification = await prisma.notification.create({
      data: {
        userId: user.id, category: 'ASSIGNED', kind: 'ticket_assigned', title: 't', link: '/x',
        sourceType: 'ticket_event', sourceId: randomUUID(),
      },
    });
    const rows = [{ notificationId: notification.id, userId: user.id, toEmail: user.email, dueAt: min(5) }];
    await service.scheduleNotifications(rows);
    await service.scheduleNotifications(rows);
    expect(await scheduledCount(notification.id)).toBe(1);
  });

  it('US-001 AC7: retryAt stores a lastError of exactly 500 characters and returns the row to PENDING', async () => {
    const row = await seed({ status: 'SENDING', lockedUntil: min(1), attempts: 1 });
    await service.retryAt(row, min(4), 'x'.repeat(2000));
    expect(await statusOf(row)).toBe('PENDING');
    expect(await lastErrorLengthOf(row)).toBe(500);
  });
});
