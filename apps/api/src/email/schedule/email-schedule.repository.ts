import { Injectable } from '@nestjs/common';
import {
  EmailScheduleRow, InviteSend, MemberAddedEmail, NewNotificationEmail, SkipReason,
} from './email-schedule.types';

/**
 * Fleet S4b §2.2: module-private persistence for `EmailSchedule` (raw SQL claim, state writes).
 *
 * STUB (US-001): every method is a placeholder so the service and its tests compile; the implementer
 * replaces the bodies with the real Prisma/SQL.
 */
@Injectable()
export class EmailScheduleRepository {
  async scheduleNotifications(_rows: ReadonlyArray<NewNotificationEmail>): Promise<number> {
    return 0;
  }

  async scheduleMemberAdded(_input: MemberAddedEmail): Promise<void> {}

  async startInviteSend(_input: InviteSend): Promise<EmailScheduleRow> {
    throw new Error('EmailScheduleRepository.startInviteSend not implemented');
  }

  async claimDue(_now: Date, _limit: number): Promise<EmailScheduleRow[]> {
    return [];
  }

  async closeAbandonedInvites(_now: Date): Promise<number> {
    return 0;
  }

  async markSent(_id: string, _now: Date): Promise<void> {}

  async markSkipped(_id: string, _reason: SkipReason): Promise<void> {}

  async markFailed(_id: string, _error: string): Promise<void> {}

  async retryAt(_id: string, _dueAt: Date, _error: string): Promise<void> {}

  async purgeFinal(_before: Date): Promise<number> {
    return 0;
  }
}
