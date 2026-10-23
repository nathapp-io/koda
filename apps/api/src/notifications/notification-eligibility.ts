import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PermissionService } from '../permissions/permission.service';
import { MEMBERSHIP_READ_CAP } from '../permissions/membership.queries';
import type { NotificationDraft } from './notification.types';

const unique = (values: readonly string[]): string[] => [...new Set(values)];
const PERMISSION_READ_CONCURRENCY = 10;

/**
 * Fleet S4a §2.1 step 1: who may receive a draft. Never the actor; never a disabled or unknown user
 * (agents are not users, so agent ids fall out here too); for a project-scoped draft, only a user
 * holding `project.read` in that project.
 *
 * Permissions P1b US-005: key checks are made once per distinct enabled user/project pair. Nothing is
 * cached here; a draft with no project consults no permissions.
 */
@Injectable()
export class NotificationEligibility {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly permissions: PermissionService,
  ) {}

  private get db() {
    return this.prisma.client;
  }

  async filter(drafts: readonly NotificationDraft[]): Promise<readonly NotificationDraft[]> {
    const candidates = drafts.filter((d) => d.userId !== d.actorId);
    if (candidates.length === 0) return [];
    const userIds = unique(candidates.map((d) => d.userId));
    const users = await this.db.user.findMany({ where: { id: { in: userIds }, disabled: false }, select: { id: true } });
    const enabledIds = new Set(users.map((user) => user.id));
    const projectPairs = unique(candidates.flatMap((draft) =>
      draft.projectId !== null && enabledIds.has(draft.userId) ? [`${draft.projectId}\u0000${draft.userId}`] : [],
    ));
    const readable = new Set<string>();
    // Bound cold-cache reads even when a ticket has thousands of watchers. A failed chunk rejects
    // the whole filter unchanged, without starting later chunks or returning a partial result.
    for (let offset = 0; offset < projectPairs.length; offset += PERMISSION_READ_CONCURRENCY) {
      const chunk = projectPairs.slice(offset, offset + PERMISSION_READ_CONCURRENCY);
      const keys = await Promise.all(chunk.map(async (pair) => {
        const [projectId, id] = pair.split('\u0000');
        return [pair, (await this.permissions.effectiveKeys({ type: 'USER', id: id as string }, { projectId: projectId as string })).has('project.read')] as const;
      }));
      for (const [pair, hasKey] of keys) if (hasKey) readable.add(pair);
    }
    return candidates.filter((draft) => enabledIds.has(draft.userId) && (
      draft.projectId === null || readable.has(`${draft.projectId}\u0000${draft.userId}`)
    ));
  }

  async findGlobalAdminIds(): Promise<readonly string[]> {
    const bindings = await this.db.roleBinding.findMany({
      where: { principalType: 'USER', projectId: null, role: { key: { in: ['owner', 'admin'] } } },
      select: { principalId: true },
      distinct: ['principalId'],
      orderBy: { principalId: 'asc' },
      take: MEMBERSHIP_READ_CAP,
    });
    if (bindings.length >= MEMBERSHIP_READ_CAP) {
      new Logger(NotificationEligibility.name).warn(
        `findGlobalAdminIds read its ${MEMBERSHIP_READ_CAP}-row cap and answered the first page`,
      );
    }
    const ids = unique(bindings.map(({ principalId }) => principalId));
    if (ids.length === 0) return [];
    const users = await this.db.user.findMany({
      where: { id: { in: ids }, disabled: false },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return users.map(({ id }) => id);
  }
}
