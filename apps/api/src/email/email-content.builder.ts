import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';
import { EmailAvailability } from './email-availability';
import { EmailScheduleRow, SkipReason } from './schedule/email-schedule.types';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';

/**
 * Fleet S4b US-002: turns one claimed `EmailSchedule` row into either a skip reason or the template
 * data the notify service renders. The dispatcher never reads a notification itself.
 */
export type EmailContent =
  | { skip: SkipReason }
  | { data: Record<string, unknown>; userId: string | null };

/**
 * US-002 stub: the implementer owns the real build order (SOURCE_GONE -> READ -> USER_DISABLED ->
 * emailAllowed reason -> data).
 */
@Injectable()
export class EmailContentBuilder {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly preferences: NotificationPreferencesService,
    private readonly email: EmailAvailability,
  ) {}

  async build(_row: EmailScheduleRow): Promise<EmailContent> {
    throw new Error('EmailContentBuilder.build is not implemented');
  }
}
