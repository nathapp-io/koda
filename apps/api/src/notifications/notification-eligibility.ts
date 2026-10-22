import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { principalIdsWithAccess } from '../permissions/membership.queries';
import type { NotificationDraft } from './notification.types';

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Fleet S4a §2.1 step 1: who may receive a draft. Never the actor; never a disabled or unknown user
 * (agents are not users, so agent ids fall out here too); for a project-scoped draft, only a project
 * member or a global ADMIN.
 *
 * Permissions P1b US-005: "a project member" has PROJECT-scope bindings, in the project and
 * `projectId`-null — read once per distinct draft project through `principalIdsWithAccess`. Nothing
 * is cached; a draft with no project consults none of them.
 */
@Injectable()
export class NotificationEligibility {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async filter(drafts: readonly NotificationDraft[]): Promise<readonly NotificationDraft[]> {
    const candidates = drafts.filter((d) => d.userId !== d.actorId);
    if (candidates.length === 0) return [];
    const userIds = unique(candidates.map((d) => d.userId));
    const users = await this.db.user.findMany({ where: { id: { in: userIds }, disabled: false }, select: { id: true, role: true } });
    const roleOf = new Map(users.map((u) => [u.id, u.role]));
    const projectIds = unique(candidates.flatMap((d) => (d.projectId ? [d.projectId] : [])));
    const access = await Promise.all(projectIds.map(
      async (projectId) => [projectId, await principalIdsWithAccess(this.db, projectId, 'USER')] as const,
    ));
    // A disabled user is dropped by the `disabled: false` read above, so the access ids need no filter.
    const isMember = new Set(access.flatMap(([projectId, ids]) => ids.map((id) => `${projectId}:${id}`)));
    return candidates.filter((d) => {
      const role = roleOf.get(d.userId);
      if (role === undefined) return false;
      if (d.projectId === null || role === 'ADMIN') return true;
      return isMember.has(`${d.projectId}:${d.userId}`);
    });
  }

  async findGlobalAdminIds(): Promise<readonly string[]> {
    const rows = await this.db.user.findMany({ where: { role: 'ADMIN', disabled: false }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => r.id);
  }
}
