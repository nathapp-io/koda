import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { NotificationDraft } from './notification.types';

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Fleet S4a §2.1 step 1: who may receive a draft. Never the actor; never a disabled or unknown user
 * (agents are not users, so agent ids fall out here too); for a project-scoped draft, only a
 * project member or a global ADMIN. Two queries per call at most.
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
    const memberships = projectIds.length === 0
      ? []
      : await this.db.projectMember.findMany({
        where: { projectId: { in: projectIds }, userId: { in: userIds } },
        select: { projectId: true, userId: true },
      });
    const isMember = new Set(memberships.map((m) => `${m.projectId}:${m.userId}`));
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
