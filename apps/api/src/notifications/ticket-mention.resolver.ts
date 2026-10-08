import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { parseMentions } from './mentions';

/**
 * Fleet S4a §2.3 (slice 3): who a text mentions. Only enabled project members and enabled global admins count;
 * a token for anyone else is ignored (D504). Order follows the text.
 */
@Injectable()
export class TicketMentionResolver {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async mentionedUserIds(projectId: string, text: string | null): Promise<readonly string[]> {
    const ids = parseMentions(text);
    if (ids.length === 0) return [];
    const users = await this.prisma.client.user.findMany({
      where: {
        id: { in: [...ids] },
        disabled: false,
        OR: [{ role: 'ADMIN' }, { projectMemberships: { some: { projectId } } }],
      },
      select: { id: true },
    });
    const allowed = new Set(users.map((u) => u.id));
    return ids.filter((userId) => allowed.has(userId));
  }
}
