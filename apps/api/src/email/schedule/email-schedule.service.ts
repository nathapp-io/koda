import { Injectable } from '@nestjs/common';
import { EmailScheduleRepository } from './email-schedule.repository';
import {
  EmailScheduleRow, InviteSend, MemberAddedEmail, NewNotificationEmail, SkipReason,
} from './email-schedule.types';

/**
 * Fleet S4b US-001: the public face of the `EmailSchedule` store. The repository is module-private; this
 * service is provided globally by `EmailCoreModule`. Every caller goes through this service.
 */
@Injectable()
export class EmailScheduleService {
  constructor(private readonly repo: EmailScheduleRepository) {}

  /** One row per notification, idempotent on the unique `notificationId` (AC6). */
  async scheduleNotifications(rows: ReadonlyArray<NewNotificationEmail>): Promise<number> {
    return this.repo.scheduleNotifications(rows);
  }

  async scheduleMemberAdded(input: MemberAddedEmail): Promise<void> {
    return this.repo.scheduleMemberAdded(input);
  }

  async startInviteSend(input: InviteSend): Promise<EmailScheduleRow> {
    return this.repo.startInviteSend(input);
  }

  /** Exclusive claim of due NOTIFICATION/MEMBER_ADDED rows (AC1-AC4). */
  async claimDue(now: Date, limit: number): Promise<EmailScheduleRow[]> {
    return this.repo.claimDue(now, limit);
  }

  /** INVITE rows stuck in SENDING past their lock become FAILED (AC5). */
  async closeAbandonedInvites(now: Date): Promise<number> {
    return this.repo.closeAbandonedInvites(now);
  }

  async markSent(id: string, now: Date): Promise<void> {
    return this.repo.markSent(id, now);
  }

  async markSkipped(id: string, reason: SkipReason): Promise<void> {
    return this.repo.markSkipped(id, reason);
  }

  async markFailed(id: string, error: string): Promise<void> {
    return this.repo.markFailed(id, error);
  }

  /** Returns the row to PENDING with the error capped at 500 characters (AC7). */
  async retryAt(id: string, dueAt: Date, error: string): Promise<void> {
    return this.repo.retryAt(id, dueAt, error);
  }
}
