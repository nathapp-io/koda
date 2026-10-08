import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Fleet S4b US-002: resolves a user id to the address an email is sent to. Notification drafts carry a
 * `userId`, never an address, so the writer and the dispatcher both look it up here.
 *
 * US-002 stub: the implementer owns the real lookup.
 */
@Injectable()
export class NotificationEmailRecipients {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async emails(_userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    throw new Error('NotificationEmailRecipients.emails is not implemented');
  }
}
