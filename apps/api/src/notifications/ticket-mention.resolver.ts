import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PermissionService } from '../permissions/permission.service';
import { parseMentions } from './mentions';

/**
 * Fleet S4a §2.3 (slice 3): who a text mentions. Only enabled users holding `project.read` in the
 * project count; a token for anyone else is ignored (D504). Order follows the text.
 *
 * Permissions P1b US-005: each mentioned enabled user is checked by effective project keys; nothing
 * is cached.
 */
@Injectable()
export class TicketMentionResolver {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly permissions: PermissionService,
  ) {}

  async mentionedUserIds(projectId: string, text: string | null): Promise<readonly string[]> {
    const ids = parseMentions(text);
    if (ids.length === 0) return [];
    const users = await this.prisma.client.user.findMany({
      where: { id: { in: [...ids] }, disabled: false },
      select: { id: true },
    });
    const enabledIds = new Set(users.map((user) => user.id));
    const access = await Promise.all([...enabledIds].map(async (id) =>
      [id, (await this.permissions.effectiveKeys({ type: 'USER', id }, { projectId })).has('project.read')] as const,
    ));
    const readable = new Set(access.filter(([, hasKey]) => hasKey).map(([id]) => id));
    return ids.filter((userId) => readable.has(userId));
  }
}
