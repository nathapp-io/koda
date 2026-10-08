import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Fleet S4b US-002: resolves a user id to the address an email is sent to. Notification drafts carry a
 * `userId`, never an address, so the writer and the dispatcher both look it up here.
 */
@Injectable()
export class NotificationEmailRecipients {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async emails(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (userIds.length === 0) return new Map();
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.email]));
  }
}
