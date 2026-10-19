import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { principalIdsWithAccess } from '../permissions/legacy-membership.queries';
import { parseMentions } from './mentions';

/**
 * Fleet S4a §2.3 (slice 3): who a text mentions. Only enabled project members and enabled global admins count;
 * a token for anyone else is ignored (D504). Order follows the text.
 *
 * Permissions P1b US-005: "a project member" is the compatibility union over the **access sources** —
 * the legacy `ProjectMember` row and the PROJECT-scope bindings of the user, in the project and
 * `projectId`-null — while the global-admin branch stays on `User.role`. The project's member ids are
 * read once per call and intersected with the mentioned ones; nothing is cached.
 */
@Injectable()
export class TicketMentionResolver {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async mentionedUserIds(projectId: string, text: string | null): Promise<readonly string[]> {
    const ids = parseMentions(text);
    if (ids.length === 0) return [];
    const [users, projectUserIds] = await Promise.all([
      this.prisma.client.user.findMany({
        where: { id: { in: [...ids] }, disabled: false },
        select: { id: true, role: true },
      }),
      principalIdsWithAccess(this.prisma.client, projectId, 'USER'),
    ]);
    const inProject = new Set(projectUserIds);
    const allowed = new Set(
      users.filter((user) => user.role === 'ADMIN' || inProject.has(user.id)).map((user) => user.id),
    );
    return ids.filter((userId) => allowed.has(userId));
  }
}
