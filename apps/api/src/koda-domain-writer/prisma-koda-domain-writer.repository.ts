import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';

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
   */
  async findUserProjectRoles(projectId: string, userId: string): Promise<string[]> {
    const [user, membership] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
      this.prisma.client.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      }),
    ]);

    const roles: string[] = [];
    if (user?.role === 'ADMIN') roles.push('ADMIN');
    if (membership?.role) roles.push(membership.role);
    return roles;
  }
}
