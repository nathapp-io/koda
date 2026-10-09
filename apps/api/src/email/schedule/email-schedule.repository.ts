import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { EmailSchedule as EmailScheduleModel, Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  EmailKind, EmailScheduleRow, InviteSend, LAST_ERROR_MAX, LOCK_MS, MemberAddedEmail, NewNotificationEmail, SkipReason,
} from './email-schedule.types';

/**
 * Fleet S4b §2.2: module-private persistence for `EmailSchedule`.
 *
 * `claimDue` is one SQL statement using `FOR UPDATE SKIP LOCKED` (Prisma has no SKIP LOCKED), so two
 * concurrent claims never hand out the same row. INVITE rows are never claimed — they advance only
 * through `startInviteSend`/`closeAbandonedInvites`.
 */
@Injectable()
export class EmailScheduleRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  /**
   * One row per notification; the unique `notificationId` makes a redelivery a no-op (AC6). Returns the
   * number of notifications now on the schedule, so an idempotent re-delivery reports the same count.
   */
  async scheduleNotifications(rows: ReadonlyArray<NewNotificationEmail>): Promise<number> {
    if (rows.length === 0) return 0;
    await this.prisma.client.emailSchedule.createMany({
      data: rows.map((row) => ({
        kind: 'NOTIFICATION' satisfies EmailKind,
        notificationId: row.notificationId,
        userId: row.userId,
        toEmail: row.toEmail,
        locale: 'en',
        dueAt: row.dueAt,
      })),
      skipDuplicates: true,
    });
    return new Set(rows.map((row) => row.notificationId)).size;
  }

  async scheduleMemberAdded(input: MemberAddedEmail): Promise<void> {
    await this.prisma.client.emailSchedule.create({
      data: {
        kind: 'MEMBER_ADDED' satisfies EmailKind,
        userId: input.userId,
        projectId: input.projectId,
        toEmail: input.toEmail,
        locale: input.locale,
        dueAt: input.dueAt,
      },
    });
  }

  /**
   * An invite email sends once, immediately; the row starts SENDING under a fresh lock so a crash mid-send
   * leaves it recoverable by `closeAbandonedInvites`. INVITE rows are never returned by `claimDue`.
   */
  async startInviteSend(input: InviteSend): Promise<EmailScheduleRow> {
    const model = await this.prisma.client.emailSchedule.create({
      data: {
        kind: 'INVITE' satisfies EmailKind,
        inviteId: input.inviteId,
        toEmail: input.toEmail,
        locale: input.locale,
        status: 'SENDING',
        attempts: 1,
        dueAt: input.now,
        lockedUntil: new Date(input.now.getTime() + LOCK_MS),
      },
    });
    return this.toRow(model);
  }

  async claimDue(now: Date, limit: number): Promise<EmailScheduleRow[]> {
    const lockedUntil = new Date(now.getTime() + LOCK_MS);
    const rows = await this.prisma.client.$queryRaw<EmailScheduleModel[]>(Prisma.sql`
      UPDATE "EmailSchedule"
      SET "status" = 'SENDING', "lockedUntil" = ${lockedUntil}, "attempts" = "attempts" + 1, "updatedAt" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "EmailSchedule"
        WHERE "kind" IN ('NOTIFICATION', 'MEMBER_ADDED')
          AND (("status" = 'PENDING' AND "dueAt" <= ${now})
             OR ("status" = 'SENDING' AND "lockedUntil" < ${now}))
        ORDER BY "dueAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`);
    // RETURNING order is unspecified.
    return [...rows]
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .map((row) => this.toRow(row));
  }

  /** An INVITE row that stayed SENDING past its lock is terminal: only the token hash exists, so it cannot retry. */
  async closeAbandonedInvites(now: Date): Promise<number> {
    const result = await this.prisma.client.emailSchedule.updateMany({
      where: { kind: 'INVITE', status: 'SENDING', lockedUntil: { lt: now } },
      data: { status: 'FAILED', lastError: 'abandoned', lockedUntil: null },
    });
    return result.count;
  }

  async markSent(id: string, now: Date): Promise<void> {
    await this.prisma.client.emailSchedule.update({
      where: { id },
      data: { status: 'SENT', sentAt: now, lockedUntil: null, lastError: null },
    });
  }

  async markSkipped(id: string, reason: SkipReason): Promise<void> {
    await this.prisma.client.emailSchedule.update({
      where: { id },
      data: { status: 'SKIPPED', skipReason: reason, lockedUntil: null },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.client.emailSchedule.update({
      where: { id },
      data: { status: 'FAILED', lastError: this.cap(error), lockedUntil: null },
    });
  }

  /** Returns the row to PENDING with the next attempt; `lastError` is capped at 500 characters (AC7). */
  async retryAt(id: string, dueAt: Date, error: string): Promise<void> {
    await this.prisma.client.emailSchedule.update({
      where: { id },
      data: { status: 'PENDING', dueAt, lastError: this.cap(error), lockedUntil: null },
    });
  }

  private cap(error: string): string {
    return error.slice(0, LAST_ERROR_MAX);
  }

  private toRow(model: EmailScheduleModel): EmailScheduleRow {
    return {
      id: model.id,
      kind: model.kind as EmailKind,
      notificationId: model.notificationId,
      inviteId: model.inviteId,
      userId: model.userId,
      projectId: model.projectId,
      toEmail: model.toEmail,
      locale: model.locale,
      attempts: model.attempts,
      dueAt: model.dueAt,
    };
  }
}
