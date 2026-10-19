import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../generated/prisma/client';
import { userProjectRole } from '../permissions/legacy-membership.queries';

@Injectable()
export class PrismaKodaDomainWriterRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async findProjectById(id: string): Promise<{ id: string } | null> {
    return this.prisma.client.project.findUnique({ where: { id }, select: { id: true } });
  }

  /**
   * US-004: project roles for a user actor in a specific project. The roles
   * come from the database (User.role + ProjectMember.role), never from the
   * write payload — see `KodaDomainWriter.writeTicketEvent`.
   *
   *  - Global ADMIN user → ['ADMIN'] (no membership row required).
   *  - Project member → [ProjectMember.role] (e.g. ['DEVELOPER']).
   *  - Global ADMIN who is also a member → ['ADMIN', ProjectMember.role].
   *
   * Permissions P1b US-003: the user's compatibility `userProjectRole` over its access sources (its
   * legacy row unioned with its PROJECT-scope bindings) is added when it has one. The raw legacy role
   * is kept: a legacy `AGENT` row still satisfies the writer's allowed roles even when a `viewer`
   * binding outranks it in `strongestProjectRole`.
   */
  async findUserProjectRoles(projectId: string, userId: string): Promise<string[]> {
    const [user, membership, bindingRole] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
      this.prisma.client.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      }),
      userProjectRole(this.prisma.client, userId, projectId),
    ]);

    const roles: string[] = [];
    if (user?.role === 'ADMIN') roles.push('ADMIN');
    if (membership?.role) roles.push(membership.role);
    if (bindingRole !== null) roles.push(bindingRole);
    return [...new Set(roles)];
  }
}
