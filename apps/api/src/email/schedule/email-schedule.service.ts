import { Injectable } from '@nestjs/common';
import { EmailScheduleRepository } from './email-schedule.repository';
import {
  EmailScheduleRow, InviteSend, MemberAddedEmail, NewNotificationEmail, SkipReason,
} from './email-schedule.types';

/**
 * Fleet S4b US-001: the public face of the `EmailSchedule` store. Repository is module-private; this
 * service is provided globally by `EmailCoreModule`.
 *
 * STUB (US-001): placeholder returns so the tests compile and fail on their assertions; the implementer
 * writes the real claiming/state behavior.
 */
@Injectable()
export class EmailScheduleService {
  constructor(private readonly repo: EmailScheduleRepository) {}

  /** One row per notification, idempotent on the unique `notificationId` (AC6). */
  async scheduleNotifications(_rows: ReadonlyArray<NewNotificationEmail>): Promise<number> {
    return this.repo.scheduleNotifications(_rows);
  }

  async scheduleMemberAdded(_input: MemberAddedEmail): Promise<void> {
    return this.repo.scheduleMemberAdded(_input);
  }

  async startInviteSend(_input: InviteSend): Promise<EmailScheduleRow> {
    return this.repo.startInviteSend(_input);
  }

  /** Exclusive claim of due NOTIFICATION/MEMBER_ADDED rows (AC1-AC4). */
  async claimDue(_now: Date, _limit: number): Promise<EmailScheduleRow[]> {
    return this.repo.claimDue(_now, _limit);
  }

  /** INVITE rows stuck in SENDING past their lock become FAILED (AC5). */
  async closeAbandonedInvites(_now: Date): Promise<number> {
    return this.repo.closeAbandonedInvites(_now);
  }

  async markSent(_id: string, _now: Date): Promise<void> {
    return this.repo.markSent(_id, _now);
  }

  async markSkipped(_id: string, _reason: SkipReason): Promise<void> {
    return this.repo.markSkipped(_id, _reason);
  }

  async markFailed(_id: string, _error: string): Promise<void> {
    return this.repo.markFailed(_id, _error);
  }

  /** Returns the row to PENDING with the error capped at 500 characters (AC7). */
  async retryAt(_id: string, _dueAt: Date, _error: string): Promise<void> {
    return this.repo.retryAt(_id, _dueAt, _error);
  }
}
